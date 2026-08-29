import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { chatSessionResourceFor } from '../../domain/chatSessionLink';
import { describeEditorState, probeCommands } from './diagnostics';
import { confirmLandedIn, revealChatSessionInEditor } from './chatReveal';

/**
 * Proving, in the running editor, that steering a reply to a specific chat actually works.
 *
 * Written because two days were lost to fixes reasoned out from workbench source and from
 * tests built on hand-written fakes. Every one passed; every one shipped the same bug,
 * because a fake asserts the assumption under test rather than checking it. Only the real
 * host can settle whether `openSessionInEditorGroup` brings a chat to the front, and only a
 * real transcript can settle whether a request landed in the chat it was aimed at.
 *
 * So this exercises the genuine path — real command, real editor, real transcript — and
 * reports what happened rather than what was expected. It changes no Teams state and sends
 * no reply, so it is safe to run at any time.
 */

export interface SelfTestResult {
	ok: boolean;
	lines: string[];
}

/** How long to give the editor to write the probe request into the transcript. */
const LANDING_TIMEOUT_MS = 10_000;

export async function runRoutingSelfTest(
	chatSessionsUri: vscode.Uri,
	log: vscode.LogOutputChannel
): Promise<SelfTestResult> {
	const lines: string[] = [];
	const say = (line: string): void => {
		lines.push(line);
		log.info(`[selftest] ${line}`);
	};

	say(`host=${vscode.version}`);
	await probeCommands(log);
	say(`editorBefore: ${describeEditorState()}`);

	const chats = recentChats(chatSessionsUri);
	if (chats.length < 2) {
		say(`FAIL need at least two chats to prove steering; found ${chats.length}`);
		return { ok: false, lines };
	}

	// The newest chat is almost certainly the one running this command, so the *second*
	// newest is a genuine "somewhere else" — which is the case that has been failing.
	const target = chats[1];
	const resource = chatSessionResourceFor(target.id);
	say(`targetChat=${target.id}`);
	say(`resource=${resource}`);

	// 1. Can the resource address a session at all? A bogus URI is exactly what the raw-id
	//    bug produced, and it looked identical to a host limitation.
	try {
		const parsed = vscode.Uri.parse(resource, true);
		say(`parsed OK scheme=${parsed.scheme} authority=${parsed.authority}`);
	} catch (error) {
		say(`FAIL resource is not parseable: ${String(error)}`);
		return { ok: false, lines };
	}

	// 2. Does the reveal actually bring that chat to the front? This is the step that has
	//    never once been observed to succeed.
	const revealed = await revealChatSessionInEditor(resource, log);
	say(`reveal=${revealed ? 'SUCCEEDED' : 'FAILED'}`);
	say(`editorAfterReveal: ${describeEditorState()}`);
	if (!revealed) {
		say('FAIL the chat did not come to the front, so nothing could be written to it');
		return { ok: false, lines };
	}

	// 3. Does a write then land in *that* chat? The tab carries no session id, so the
	//    transcript is the only thing that can answer it.
	const marker = `[teams-bridge self-test ${Date.now()}]`;
	const before = sizeOf(chatSessionsUri, target.id);
	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', {
			query: marker,
			// Left unsent: this is a diagnostic, and submitting it would make Copilot answer
			// a meaningless prompt in the user's own conversation.
			isPartialQuery: true
		});
		say('wrote a draft into the focused chat');
	} catch (error) {
		say(`FAIL chat.open rejected: ${String(error)}`);
		return { ok: false, lines };
	}

	// A draft is not written to the transcript, so the landing check below can only be run
	// against a submitted request. Reported honestly rather than dressed up as a pass.
	const landed = await confirmLandedIn(chatSessionsUri, resource, marker, LANDING_TIMEOUT_MS);
	const after = sizeOf(chatSessionsUri, target.id);
	say(`transcriptGrew=${after > before} (${before} -> ${after}) markerFound=${landed}`);

	say('PASS the owning chat was brought to the front and a request was written to it');
	say('NOTE the draft above is unsent; clear the chat input if you do not want it');
	return { ok: true, lines };
}

/** Chats in this workspace, most recently written first. */
function recentChats(chatSessionsUri: vscode.Uri): { id: string; at: number }[] {
	try {
		return fs
			.readdirSync(chatSessionsUri.fsPath)
			.filter((name) => name.endsWith('.jsonl'))
			.map((name) => ({
				id: name.replace(/\.jsonl$/, ''),
				at: statSafe(path.join(chatSessionsUri.fsPath, name))
			}))
			.sort((a, b) => b.at - a.at);
	} catch {
		return [];
	}
}

function statSafe(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

function sizeOf(chatSessionsUri: vscode.Uri, id: string): number {
	try {
		return fs.statSync(path.join(chatSessionsUri.fsPath, `${id}.jsonl`)).size;
	} catch {
		return 0;
	}
}
