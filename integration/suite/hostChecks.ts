import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** The session the launcher seeds, so the checks know what they are aiming at. */
const SEEDED_SESSION_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Facts about the running editor, established by asking it rather than by reading its source.
 *
 * Each check answers one question that a routing decision depends on. They were all
 * previously answered by inference — from minified bundles, from GitHub source, and from
 * fakes written to match those inferences — and the inferences were wrong twice.
 *
 * Ordered so that a failure explains the ones after it: if the command does not exist, no
 * amount of argument-shaping will make a chat come to the front.
 */

export interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

/** Long enough for an editor to open, short enough that a hung check still reports. */
const SETTLE_MS = 3_000;

export async function runHostChecks(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail: string): void => {
		results.push({ name, ok, detail });
	};

	add('host version', true, vscode.version);

	// 1. Do the commands delivery depends on actually exist in this build? A renamed command
	//    fails in exactly the same way as a chat that will not come forward, and telling
	//    those apart by observation alone is impossible.
	const commands = new Set(await vscode.commands.getCommands(true));
	for (const id of [
		'workbench.action.chat.open',
		'workbench.action.chat.openSessionInEditorGroup',
		'workbench.action.chat.openInSidebar',
		// The focus race fix depends on this command to move keyboard focus into the
		// revealed chat editor. Without it VS Code's `lastFocusedWidget` keeps pointing at
		// whichever chat was last clicked, and the write goes to that one instead.
		'workbench.action.focusActiveEditorGroup'
	]) {
		add(`command exists: ${id}`, commands.has(id), commands.has(id) ? 'present' : 'MISSING from this host');
	}

	// 2. Is TabInputChat exported, and is it the empty marker the delivery check assumes?
	//    Delivery treats "a chat editor is in front" as its only observable signal, so if
	//    the class carried a session id the whole verification step could be simpler — and
	//    if it is absent, the signal does not exist at all.
	const tabInputChat = (vscode as { TabInputChat?: new (...args: never[]) => object }).TabInputChat;
	if (!tabInputChat) {
		add('TabInputChat exported', false, 'not exported by this host; a chat tab cannot be recognised');
	} else {
		const fields = Object.getOwnPropertyNames(new tabInputChat());
		add(
			'TabInputChat exported',
			true,
			`present; instance fields=[${fields.join(',')}] (empty means a tab cannot name its session)`
		);
	}

	// 3. Can a chat be created at all in this host? Everything downstream needs a real
	//    session to aim at, and a headless VS Code has no Copilot provider — so this is
	//    also what tells us whether the remaining checks can be trusted.
	//
	//    Note what this establishes on its own: `chat.open` opens the chat in the *side bar
	//    view*, not an editor. So an absent chat tab afterwards is correct behaviour, and
	//    any check that treats "no chat tab" as failure is measuring the wrong thing.
	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', {
			query: 'teams bridge host check',
			isPartialQuery: true
		});
		await delay(SETTLE_MS);
		add(
			'chat.open opens a chat',
			true,
			`resolved; activeTab=${describeActiveTab()} (a side-bar chat leaves the editor area empty)`
		);
	} catch (error) {
		add('chat.open opens a chat', false, `rejected: ${String(error)}`);
	}

	// The resource is found the same way delivery finds it in production — from the
	// transcript this instance just wrote — so the check exercises the real mechanism
	// rather than a shortcut available only to tests.
	const seeded = newestSessionResource();
	add(
		'a real session resource can be found',
		Boolean(seeded),
		seeded?.toString() ?? 'no transcript was written; later checks cannot be trusted'
	);

	// 4. The question the last two days turned on: given a session resource, does the
	//    command bring *that* chat to the front? Answered against a resource this host
	//    itself produced, so a failure cannot be blamed on a malformed URI.
	if (!seeded) {
		add(
			'openSessionInEditorGroup reveals a chat',
			false,
			'skipped: no chat resource was available to aim at'
		);
	} else {
		try {
			const before = describeActiveTab();
			await vscode.commands.executeCommand('workbench.action.chat.openSessionInEditorGroup', {
				resource: seeded
			});
			await delay(SETTLE_MS);
			const after = describeActiveTab();
			add(
				'openSessionInEditorGroup reveals a chat',
				activeTabIsChat(),
				`before=${before} after=${after} target=${seeded.toString()}`
			);
		} catch (error) {
			add('openSessionInEditorGroup reveals a chat', false, `rejected: ${String(error)}`);
		}
	}

	// 5. Does the command validate its target, or accept anything? This is what made the
	//    raw-id bug so expensive: a bogus resource behaved exactly like a host limitation.
	//    Recorded as a fact rather than a failure — delivery is built around this answer,
	//    confirming from the transcript instead of trusting the call.
	let bogusRejected: boolean;
	try {
		await vscode.commands.executeCommand('workbench.action.chat.openSessionInEditorGroup', {
			resource: vscode.Uri.parse('vscode-chat-session://local/bm90LWEtcmVhbC1zZXNzaW9u')
		});
		bogusRejected = false;
	} catch {
		bogusRejected = true;
	}
	add(
		'behaviour recorded: a bogus session',
		true,
		bogusRejected
			? 'rejected, so the call can be trusted'
			: 'RESOLVES SILENTLY, so the call proves nothing and delivery must confirm from the transcript'
	);

	// 6. The regression itself. Two producers recorded the same chat two different ways —
	//    the notify tool stored the full resource, the transcript watcher stored the bare
	//    id — and the bare id cannot address anything. Proven here against the real command
	//    rather than argued from source, because arguing from source is what got this
	//    wrong twice.
	if (seeded) {
		const bareId = SEEDED_SESSION_ID;
		let bareWorks: boolean;
		try {
			await vscode.commands.executeCommand('workbench.action.chat.openSessionInEditorGroup', {
				resource: vscode.Uri.parse(bareId)
			});
			await delay(SETTLE_MS);
			bareWorks = activeTabIsChat();
		} catch {
			bareWorks = false;
		}
		// Closing what the previous step may have opened, so the next check starts clean.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await delay(SETTLE_MS);

		let normalisedWorks: boolean;
		try {
			await vscode.commands.executeCommand('workbench.action.chat.openSessionInEditorGroup', {
				resource: seeded
			});
			await delay(SETTLE_MS);
			normalisedWorks = activeTabIsChat();
		} catch {
			normalisedWorks = false;
		}

		add(
			'the bare-id regression is fixed',
			!bareWorks && normalisedWorks,
			`bareId=${bareId} reveals=${bareWorks} (must be false) | ` +
				`resource=${seeded.toString()} reveals=${normalisedWorks} (must be true)`
		);
	}

	return results;
}

function activeTabIsChat(): boolean {
	const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
	const chatTab = (vscode as { TabInputChat?: new (...args: never[]) => object }).TabInputChat;
	if (input && chatTab && input instanceof chatTab) {
		return true;
	}
	return (input as { constructor?: { name?: string } })?.constructor?.name === 'TabInputChat';
}

function describeActiveTab(): string {
	const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
	const input = tab?.input as { constructor?: { name?: string } } | undefined;
	return `${input?.constructor?.name ?? 'none'}(${JSON.stringify(tab?.label ?? '')})`;
}

/**
 * The newest chat session this instance has written, as a resource.
 *
 * Found from the transcripts rather than from any API, because that is exactly how delivery
 * finds it in production — VS Code exposes no way to enumerate chat sessions. Testing the
 * same mechanism means a pass here says something about the real path.
 */
function newestSessionResource(): vscode.Uri | undefined {
	let newest: { id: string; at: number } | undefined;
	for (const folder of transcriptFolders()) {
		let names: string[];
		try {
			names = fs.readdirSync(folder);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith('.jsonl')) {
				continue;
			}
			try {
				const at = fs.statSync(path.join(folder, name)).mtimeMs;
				if (!newest || at > newest.at) {
					newest = { id: name.replace(/\.jsonl$/, ''), at };
				}
			} catch {
				// Vanished between listing and reading; the next candidate will do.
			}
		}
	}
	return newest ? vscode.Uri.parse(chatSessionResourceFor(newest.id)) : undefined;
}

/** Every workspace-storage chatSessions folder belonging to this test instance. */
function transcriptFolders(): string[] {
	// `--user-data-dir` is pinned by the launcher precisely so this is knowable.
	const root = path.resolve(__dirname, '..', '..', '..', '.vscode-test-user-data', 'User', 'workspaceStorage');
	try {
		return fs
			.readdirSync(root)
			.map((entry) => path.join(root, entry, 'chatSessions'))
			.filter((candidate) => fs.existsSync(candidate));
	} catch {
		return [];
	}
}

/** Mirrors the production encoding, kept local so the suite has no import cycle. */
function chatSessionResourceFor(id: string): string {
	return `vscode-chat-session://local/${Buffer.from(id, 'utf8').toString('base64')}`;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
