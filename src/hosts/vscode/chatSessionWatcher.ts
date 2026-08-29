import * as vscode from 'vscode';
import { parseTranscript } from '../../domain/chatTranscript';
import { chatSessionResourceFor } from '../../domain/chatSessionLink';
import { parseTurns, type ChatTurn } from '../../domain/chatTurns';
import type { SessionIdentity } from '../../domain/types';

export interface ChatSessionWatcherDeps {
	/** Folder VS Code writes chat transcripts into, one .jsonl per session. */
	chatSessionsUri: vscode.Uri;
	announce(request: {
		sessionKey: string;
		title: string;
		prompt?: string;
		identity?: SessionIdentity;
	}): Promise<boolean>;
	log: vscode.LogOutputChannel;
	/** Prompts shorter than this are treated as chit-chat and skipped. */
	minPromptLength(): number;
	enabled(): boolean;
	/**
	 * Reports that an already-announced chat is still being worked on.
	 *
	 * The idle window has to be measured from the last turn on *either* side. Watching the
	 * transcript is the only signal available for the editor side, since VS Code raises no
	 * event for a chat request.
	 */
	touch?(sessionKey: string): void;
	/**
	 * Reports a chat turn that has finished, so its summary can reach Teams.
	 *
	 * The user asked for an update on every turn, not only when the model remembers to call
	 * the notify tool — that call is guidance, and a turn that ends without one leaves the
	 * thread silent while work is plainly happening. The transcript is the only signal VS
	 * Code offers, so completed turns are read from it directly.
	 */
	reportTurn?(sessionKey: string, turn: ChatTurn): Promise<void>;
	/**
	 * How long a transcript must be quiet before its turns are read. Optional so tests can
	 * drive the settle loop without waiting seconds per event.
	 */
	settleMs?: number;
	/**
	 * How long to wait before treating a brand-new transcript as ready to announce.
	 * Optional so tests can exercise the announce path without a real 1.5 s pause.
	 */
	announceDelayMs?: number;
}

/** The session key a chat transcript is announced under. */
function chatSessionKey(transcriptName: string): string {
	return `chat-${transcriptName.replace(/\.jsonl$/, '')}`;
}

/**
 * Announces a Copilot chat session on Teams as soon as it starts.
 *
 * VS Code exposes no hook that fires on a chat request — `vscode.chat` offers only
 * `createChatParticipant`, which fires solely when the user @-mentions that participant. So
 * announcing has until now depended on the model choosing to call the notify tool, which is
 * guidance rather than enforcement: when the model does not call it, nothing reaches Teams
 * and the user has no way to tell whether the bridge is broken or simply unused.
 *
 * The editor does persist every session as a `.jsonl` transcript, so watching that folder
 * gives a deterministic signal instead. It is an internal format, so every field is read
 * defensively and a parse failure is logged and skipped rather than thrown.
 */
export class ChatSessionWatcher {
	private watcher: vscode.FileSystemWatcher | undefined;
	/** Sessions already handled, including those that existed before we started. */
	private readonly seen = new Set<string>();
	private readonly pending = new Map<string, NodeJS.Timeout>();
	/** Debounced turn scans, kept apart from announcements so the two do not cancel. */
	private readonly turnScans = new Map<string, NodeJS.Timeout>();
	/**
	 * The identity of the newest turn seen per transcript.
	 *
	 * A file write is not by itself a chat request — VS Code rewrites transcripts for its
	 * own reasons (persisting open chat editors, periodic housekeeping), and the bridge's
	 * reveal-before-send opens each targeted chat as an editor tab that VS Code will then
	 * re-persist in bulk. Every such write used to be misread as user activity, reviving
	 * every expired session with an open tab and producing a resume/expire flap across
	 * many threads. Recording the newest turn identity per transcript closes that: the
	 * idle window is slid only when a genuinely new turn has appeared.
	 *
	 * A missing entry means "not yet baselined" — the first successful read records what
	 * is there without touching, since a bare write is never proof of a new turn.
	 * The `null` sentinel means "transcript parsed but no turns yet".
	 */
	private readonly latestTurnKey = new Map<string, string | null>();

	constructor(private readonly deps: ChatSessionWatcherDeps) {}

	async start(): Promise<void> {
		if (this.watcher) {
			return;
		}

		// Existing transcripts are recorded as seen first, so enabling the watcher does not
		// announce every conversation in the workspace history at once.
		await this.seedExisting();

		const pattern = new vscode.RelativePattern(this.deps.chatSessionsUri, '*.jsonl');
		this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);
		this.watcher.onDidCreate((uri) => this.schedule(uri));
		this.watcher.onDidChange((uri) => this.schedule(uri));
		this.deps.log.info(`Watching for new Copilot sessions in ${this.deps.chatSessionsUri.fsPath}`);
	}

	private async seedExisting(): Promise<void> {
		try {
			for (const [name] of await vscode.workspace.fs.readDirectory(this.deps.chatSessionsUri)) {
				this.seen.add(name);
				// Baseline the newest turn identity for every transcript already on disk.
				// Without this the first write after activation looks "new" for every
				// existing conversation, and a single housekeeping re-persist revives all
				// of them at once — the reload storm this bug was reported for.
				const key = await this.readNewestTurnKey(
					vscode.Uri.joinPath(this.deps.chatSessionsUri, name)
				);
				if (key !== undefined) {
					this.latestTurnKey.set(name, key);
				}
			}
		} catch {
			// The folder appears with the first chat; nothing to seed until then.
		}
	}

	/**
	 * Reads the transcript and returns an identity for its newest turn.
	 *
	 * `undefined` means the file could not be read at all — the caller must not baseline
	 * from that, because a later successful read is exactly the moment we need a baseline
	 * to compare against. `null` means the transcript parsed but held no turn yet, which
	 * is a legitimate baseline for a chat that has not received a prompt.
	 */
	private async readNewestTurnKey(uri: vscode.Uri): Promise<string | null | undefined> {
		let text: string;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			return undefined;
		}
		return newestTurnKey(parseTurns(text));
	}

	/**
	 * Waits for the transcript to settle before reading it.
	 *
	 * VS Code writes the file repeatedly while a response streams, and the first write can
	 * land before the request itself is recorded.
	 */
	private schedule(uri: vscode.Uri): void {
		const name = basename(uri);
		if (!this.deps.enabled()) {
			return;
		}
		if (this.seen.has(name)) {
			// A write on an already-seen transcript is NOT by itself a chat turn. VS Code
			// rewrites these files whenever a chat editor is persisted, including the tabs
			// the bridge itself opens when steering replies; touching on every write turns
			// each housekeeping re-persist into a phantom "user is here" signal and
			// revives every expired session with an open tab. Debounce, read the
			// transcript, and only touch when a genuinely new turn identity is seen.
			this.scheduleTurnScan(uri, name);
			return;
		}
		const existing = this.pending.get(name);
		if (existing) {
			clearTimeout(existing);
		}
		this.pending.set(name, setTimeout(() => void this.handle(uri, name), this.deps.announceDelayMs ?? 1500));
	}

	/**
	 * Looks at the transcript once it stops changing.
	 *
	 * Debounced separately from announcing, and more patiently: the file is rewritten on
	 * every streamed token, so scanning per write would parse the whole conversation
	 * hundreds of times per answer. Waiting for a lull also means the turn being read is a
	 * settled one rather than a sentence in progress.
	 *
	 * Runs regardless of whether `reportTurn` is wired, because the same settle drives
	 * the "did a genuinely new turn appear" check that keeps the idle window honest.
	 */
	private scheduleTurnScan(uri: vscode.Uri, name: string): void {
		const existing = this.turnScans.get(name);
		if (existing) {
			clearTimeout(existing);
		}
		this.turnScans.set(
			name,
			setTimeout(() => void this.scanTurns(uri, name), this.deps.settleMs ?? TURN_SETTLE_MS)
		);
	}

	private async scanTurns(uri: vscode.Uri, name: string): Promise<void> {
		this.turnScans.delete(name);
		let text: string;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch (error) {
			// A bare write with a subsequent read failure must NOT slide the idle window:
			// that would be the exact behaviour this fix removes. Log and stop.
			this.deps.log.debug(`Could not read a chat transcript for turns: ${String(error)}`);
			return;
		}

		const turns = parseTurns(text);
		const sessionKey = chatSessionKey(name);
		const previous = this.latestTurnKey.get(name);
		const current = newestTurnKey(turns);
		if (previous === undefined) {
			// First successful read for this transcript — baseline what we have so future
			// writes have something to compare against. A bare write is not proof of a
			// new turn, so no touch here even if there is already a turn recorded.
			this.latestTurnKey.set(name, current);
		} else if (current !== null && current !== previous) {
			// A new turn identity has appeared, so the user really did work in this chat.
			// Slide the idle window and reveal an expired session, exactly as before —
			// only the trigger has become genuine.
			this.latestTurnKey.set(name, current);
			this.deps.touch?.(sessionKey);
		}

		if (!this.deps.reportTurn) {
			return;
		}
		for (const turn of turns) {
			if (!turn.complete) {
				// Still streaming. Left alone so the next lull reports it whole rather than
				// posting a half-answer and correcting it afterwards.
				continue;
			}
			try {
				await this.deps.reportTurn(sessionKey, turn);
			} catch (error) {
				// One unpostable turn must not stop the rest of the conversation reaching
				// Teams, and it must not stop the chat being watched either.
				this.deps.log.warn(`Could not post a turn summary: ${String(error)}`);
			}
		}
	}

	private async handle(uri: vscode.Uri, name: string): Promise<void> {
		this.pending.delete(name);
		if (this.seen.has(name)) {
			return;
		}

		const session = await this.readSession(uri);
		if (!session) {
			return; // Not readable yet; a later write will schedule another attempt.
		}
		if (session.prompt.trim().length < this.deps.minPromptLength()) {
			// A greeting or one-line question is not worth a Teams thread.
			this.seen.add(name);
			return;
		}

		this.seen.add(name);
		try {
			await this.deps.announce({
				sessionKey: `chat-${session.id}`,
				title: session.title,
				prompt: session.prompt,
				// The transcript's own filename is the chat's session id, so ownership is a
				// fact here rather than something to search for later. Recording it is the
				// whole point of announcing from the watcher instead of from a tool call.
				identity: {
					harness: 'vscode-sidebar',
					// The full resource, not the bare id. VS Code addresses a chat by
					// `vscode-chat-session://local/<base64 id>`, and every consumer — the
					// reveal command, the delivery check, the transcript confirmation —
					// parses it as such. Storing the bare id here made every reveal fail
					// and every fast-path comparison miss, because the same conversation
					// was written two different ways.
					chat: { kind: 'chat-session-resource', value: chatSessionResourceFor(session.id) },
					confidence: 'exact',
					capturedBy: 'chat-watcher',
					capturedAt: new Date().toISOString()
				}
			});
		} catch (error) {
			// Allow a retry rather than losing the session to a transient Teams failure.
			this.seen.delete(name);
			this.deps.log.warn(`Could not announce the new Copilot session: ${String(error)}`);
		}
	}

	/** Reads whatever of the session is on disk so far. */
	private async readSession(uri: vscode.Uri): Promise<{ id: string; title: string; prompt: string } | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return parseTranscript(Buffer.from(bytes).toString('utf8'));
		} catch (error) {
			this.deps.log.debug(`Could not read a chat transcript: ${String(error)}`);
			return undefined;
		}
	}

	dispose(): void {
		for (const timer of [...this.pending.values(), ...this.turnScans.values()]) {
			clearTimeout(timer);
		}
		this.pending.clear();
		this.turnScans.clear();
		this.watcher?.dispose();
		this.watcher = undefined;
	}
}

/**
 * How long the transcript must be quiet before its turns are read.
 *
 * Longer than the announce debounce on purpose. The file is rewritten as each token
 * streams, so a short wait would read an answer mid-sentence — and a turn can only be
 * summarised once.
 */
const TURN_SETTLE_MS = 4_000;


function basename(uri: vscode.Uri): string {
	const parts = uri.path.split('/');
	return parts[parts.length - 1] ?? uri.path;
}

/**
 * A stable identity for the newest turn in a transcript.
 *
 * Prefers `requestId`, which VS Code assigns per chat request and never reuses. Falls
 * back to the recorded start timestamp when the id is missing — good enough to tell one
 * turn from the next without a false positive, which is all the caller needs. Returns
 * `null` when the transcript parsed cleanly but held no turn yet, so a legitimate empty
 * baseline is distinguishable from a read failure upstream.
 */
function newestTurnKey(turns: ChatTurn[]): string | null {
	if (turns.length === 0) {
		return null;
	}
	const last = turns[turns.length - 1];
	if (last.requestId) {
		return `id:${last.requestId}`;
	}
	if (last.startedAt) {
		return `ts:${last.startedAt}`;
	}
	return null;
}
