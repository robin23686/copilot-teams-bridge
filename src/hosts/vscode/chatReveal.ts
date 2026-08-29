import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chatSessionIdFrom } from '../../domain/chatSessionLink';
import { describeEditorState, note, type DeliveryTrace } from './diagnostics';

/**
 * Bringing a specific chat to the front, and proving a request reached it.
 *
 * `workbench.action.chat.open` writes to whichever chat is focused and cannot be told which
 * to use. The one command that does take a session is
 * `workbench.action.chat.openSessionInEditorGroup`, which resolves `{ resource }` and opens
 * that session in an editor group — focusing it, and so making the next write land there.
 *
 * The trade is visible to the user: a chat living in the side bar is *relocated* to an
 * editor tab, because `prepareSessionForMove` calls `clear()` on the side bar widget to
 * detach the session. The conversation survives — this is what the built-in "Open as Editor"
 * action does — but the chat does leave the side bar, so it is offered as a choice rather
 * than imposed.
 */

/** How long to wait for a revealed chat editor to become the active tab. */
const REVEAL_SETTLE_MS = 1_200;

/**
 * How long to wait after moving focus into the revealed editor group, before returning.
 *
 * VS Code's chat command resolves whichever chat widget the widget service reports as
 * `lastFocusedWidget`. Revealing a chat editor makes its *tab* active, but does not
 * necessarily move keyboard focus into the editor — so `lastFocusedWidget` still points at
 * the chat that was focused when the user last clicked, and the next write goes to that
 * chat rather than the revealed one. The fix is to explicitly focus the active editor
 * group after the reveal, then let the widget service settle before we write.
 */
const FOCUS_SETTLE_MS = 200;

/**
 * How long the target transcript must be silent after we have seen it change at least
 * once, before delivery is treated as unproven when the marker has not shown up. Not a
 * hard cap on confirmation, just the settle period: activity in the file resets it, so a
 * chat that is still writing keeps being waited for. Crucially the window is *only*
 * consulted after the first observed change — see {@link confirmLandedIn} for why.
 *
 * Overridable per call to {@link confirmLandedIn}; the extension threads
 * `config.deliveryConfirmMs` through so a slow machine can lengthen the settle without
 * touching this default.
 */
const CONFIRM_QUIET_MS = 30_000;

/**
 * The absolute upper bound on a single confirmation, no matter how much the transcript
 * changes. A chat that keeps writing indefinitely without producing the marker still has
 * to fail eventually, or one bad delivery would keep the confirmation loop running for
 * the lifetime of the editor.
 */
const CONFIRM_CEILING_MS = 120_000;

const CONFIRM_POLL_MS = 250;
/**
 * Opens a chat session in an editor group and reports whether a chat is now in front.
 *
 * The command resolves nothing useful and never throws for an unknown session, so its
 * return value cannot be trusted. What can be checked is the editor state afterwards: if
 * the active tab is a chat editor, a chat was opened. Which chat it is remains unproven
 * here — {@link confirmLandedIn} settles that after the write.
 */
export async function revealChatSessionInEditor(
	resource: string,
	log: vscode.LogOutputChannel,
	trace?: DeliveryTrace
): Promise<boolean> {
	const before = describeEditorState();
	note(trace, `beforeReveal(${before})`);

	let parsed: vscode.Uri;
	try {
		parsed = vscode.Uri.parse(resource, true);
	} catch (error) {
		// A malformed resource cannot address anything, and steering on it would be a guess.
		// Recorded rather than swallowed, because storing the wrong form is exactly the bug
		// that made every reveal fail while looking like a host limitation.
		note(trace, `badResource(${String(error)})`);
		log.warn(`[reveal] "${resource}" is not a usable chat resource: ${String(error)}`);
		return false;
	}
	note(trace, `parsed(scheme=${parsed.scheme} authority=${parsed.authority || '-'})`);

	try {
		await vscode.commands.executeCommand('workbench.action.chat.openSessionInEditorGroup', {
			resource: parsed
		});
		note(trace, 'commandResolved');
	} catch (error) {
		note(trace, `commandRejected(${String(error)})`);
		log.warn(`[reveal] openSessionInEditorGroup rejected for ${resource}: ${String(error)}`);
		return false;
	}

	// The editor opens asynchronously, so the tab state immediately after the command still
	// describes the old layout.
	const deadline = Date.now() + REVEAL_SETTLE_MS;
	do {
		if (activeTabIsChat()) {
			note(trace, `chatInFront(${describeEditorState()})`);
			// The tab is active, but the widget service's `lastFocusedWidget` may still be
			// the chat the user last clicked into — that is what OpenChatGlobalAction reads
			// when the next write is issued, and it is why previous fixes revealed the right
			// chat and then wrote into the wrong one. Explicitly focusing the active editor
			// group moves the widget-service pointer onto the revealed chat, and settling
			// briefly gives VS Code time to record it before we hand back.
			await focusRevealedEditor(log, trace);
			return true;
		}
		await delay(100);
	} while (Date.now() < deadline);

	// The command resolved and no chat editor appeared. That is the fact worth recording:
	// it separates "the command does not do what was assumed" from "the resource was wrong",
	// which reading the workbench source could never settle.
	const after = describeEditorState();
	note(trace, `noChatInFront(${after})`);
	log.warn(
		`[reveal] the command resolved but no chat editor came to the front within ` +
			`${REVEAL_SETTLE_MS}ms. before=${before} after=${after}`
	);
	return false;
}

/**
 * Moves keyboard focus into the active editor group after a reveal.
 *
 * The reveal only makes the tab active; it does not necessarily update
 * `IChatWidgetService.lastFocusedWidget`, which VS Code's `workbench.action.chat.open`
 * reads when it decides which chat to write to. Without this step a written request keeps
 * landing in whichever chat was last clicked into. The command is best effort — a
 * rejection is recorded but does not by itself fail the reveal, because at this point a
 * chat editor is demonstrably in front and the write is more likely to reach it than
 * abandoning delivery would help.
 */
async function focusRevealedEditor(
	log: vscode.LogOutputChannel,
	trace?: DeliveryTrace
): Promise<void> {
	try {
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
		note(trace, 'focusedEditorGroup');
	} catch (error) {
		note(trace, `focusCommandRejected(${String(error)})`);
		log.warn(
			`[reveal] workbench.action.focusActiveEditorGroup rejected: ${String(error)}. ` +
				`Continuing because a chat editor is in front.`
		);
	}
	// A brief settle so the widget service records the focus change before the next write.
	await delay(FOCUS_SETTLE_MS);
}

/**
 * Whether a chat editor is the active tab.
 *
 * `TabInputChat` is an empty marker class — it carries no session id — so this answers
 * "a chat is in front" and deliberately not "which chat". Treating it as the latter is
 * what previously logged a reply as delivered to a chat it never reached.
 */
function activeTabIsChat(): boolean {
	const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
	if (!input) {
		return false;
	}
	const chatTab = (vscode as { TabInputChat?: new (...args: never[]) => object }).TabInputChat;
	if (chatTab && input instanceof chatTab) {
		return true;
	}
	// Older hosts predate the class being exported, so the shape is the only thing left.
	return (input as { constructor?: { name?: string } }).constructor?.name === 'TabInputChat';
}

/**
 * Injection points for {@link confirmLandedIn}, so tests can drive it without sleeping or
 * touching the disk. Every hook is optional; the defaults are the real clock and `fs`.
 */
export interface ConfirmLandedOptions {
	/** Absolute upper bound before the confirmation gives up. */
	ceilingMs?: number;
	/** Interval between transcript re-reads. */
	pollMs?: number;
	now?(): number;
	sleep?(ms: number): Promise<void>;
	readFile?(file: string): string;
	stat?(file: string): { size: number; mtimeMs: number } | undefined;
}

/**
 * Waits for `marker` to appear in the transcript of `resource`, which proves it landed.
 *
 * The only trustworthy confirmation available. VS Code records every request in the
 * transcript of the chat that received it, so finding the marker in *this* session's file
 * settles the question the tab state cannot answer.
 *
 * Adaptive rather than a fixed deadline, and — crucially — asymmetric about what
 * "quiet" means. Two situations look identical to a naive quiet-window check but must be
 * told apart:
 *
 *   (a) The transcript has NOT changed at all since we started watching. We have no
 *       evidence of failure — a cold chat whose agent is still starting up (MCP servers
 *       spinning up, a model call in flight) may simply not have flushed the request
 *       into its `.jsonl` yet, and live traces have shown flush gaps of 50s+ during
 *       which VS Code writes nothing at all. Applying the quiet window here would
 *       declare a delivery that IS about to land as unroutable, producing a spurious
 *       consent popup, no acknowledgement, and an abandoned reply. So while nothing has
 *       changed, we keep polling until the absolute ceiling.
 *
 *   (b) The transcript HAS changed since we started, and after that change the marker
 *       still is not there and the file has been quiet for the settle window. The chat
 *       is demonstrably alive and recorded something else, so our request most likely
 *       went to a different chat. That is real evidence of failure, and the quiet
 *       window is the right signal to fail on.
 *
 * The design is deliberately skewed towards waiting: a false failure costs a spurious
 * popup, a missing acknowledgement, and an abandoned reply, while an extra wait costs
 * only a delayed acknowledgement. Confirmation runs *after* `releaseQueue()` in
 * `ChatInjector.steerAndWrite`, so a longer wait here does not block other replies —
 * the reveal + write has already completed on the delivery queue, and this poll only
 * reads a file.
 *
 * The absolute ceiling remains the hard bound in both cases, so nothing waits forever
 * — a chat that either writes forever without producing the marker (case b with
 * unending activity resetting the settle window) or never writes at all (case a)
 * eventually fails. A missing transcript file behaves the same as case (a): it may
 * simply not have been written yet, so we keep polling until the ceiling rather than
 * failing at the settle window.
 */
export async function confirmLandedIn(
	chatSessionsUri: vscode.Uri,
	resource: string,
	marker: string,
	quietMs: number = CONFIRM_QUIET_MS,
	options: ConfirmLandedOptions = {}
): Promise<boolean> {
	const id = chatSessionIdFrom(resource);
	if (!id) {
		return false;
	}
	const file = path.join(chatSessionsUri.fsPath, `${id}.jsonl`);
	// The marker is written as JSON, so its quotes are escaped in the file.
	const escaped = JSON.stringify(marker).slice(1, -1);

	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? delay;
	const pollMs = options.pollMs ?? CONFIRM_POLL_MS;
	const ceilingMs = Math.max(quietMs, options.ceilingMs ?? CONFIRM_CEILING_MS);
	const readFile = options.readFile ?? ((path: string): string => fs.readFileSync(path, 'utf8'));
	const stat = options.stat ?? defaultStat;

	const start = now();
	const hardDeadline = start + ceilingMs;
	// The transcript's activity signature. `undefined` means "not present"; before we've
	// taken any observation at all, `haveObservation` is false so the first poll simply
	// records what it sees without treating that as a change.
	let priorSig: { size: number; mtimeMs: number } | undefined;
	let haveObservation = false;
	// Whether the transcript has changed at least once since we started watching. Until
	// this becomes true, the quiet window is not a valid failure signal — see the doc
	// comment for the (a)/(b) distinction.
	let sawChange = false;
	let lastChangeAt = start;

	for (;;) {
		let text: string | undefined;
		try {
			text = readFile(file);
		} catch {
			text = undefined;
		}
		if (text !== undefined && (text.includes(marker) || text.includes(escaped))) {
			return true;
		}

		const sig = safe(stat, file);
		if (haveObservation) {
			if (signaturesDiffer(priorSig, sig)) {
				sawChange = true;
				lastChangeAt = now();
			}
		} else {
			haveObservation = true;
		}
		priorSig = sig;

		const t = now();
		if (t >= hardDeadline) {
			return false;
		}
		if (sawChange && t - lastChangeAt >= quietMs) {
			return false;
		}
		await sleep(pollMs);
	}
}

function signaturesDiffer(
	a: { size: number; mtimeMs: number } | undefined,
	b: { size: number; mtimeMs: number } | undefined
): boolean {
	if (!a && !b) {
		return false;
	}
	if (!a || !b) {
		return true;
	}
	return a.size !== b.size || a.mtimeMs !== b.mtimeMs;
}

function defaultStat(file: string): { size: number; mtimeMs: number } | undefined {
	try {
		const s = fs.statSync(file);
		return { size: s.size, mtimeMs: s.mtimeMs };
	} catch {
		return undefined;
	}
}

function safe<T>(fn: (arg: string) => T | undefined, arg: string): T | undefined {
	try {
		return fn(arg);
	} catch {
		return undefined;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
