import * as vscode from 'vscode';
import { asChatSessionResource } from '../../src/domain/chatSessionLink';
import { revealChatSessionInEditor } from '../../src/hosts/vscode/chatReveal';
import type { CheckResult } from './hostChecks';

/**
 * Exercising the shipped code against the real editor.
 *
 * The checks in `hostChecks` establish what VS Code does; these establish that *this
 * extension* asks it correctly. Both are needed, and only the second would have caught the
 * bug that shipped twice: the command was always capable of revealing a chat, and the
 * extension was always handing it something unusable.
 *
 * Deliberately calls the production functions rather than reimplementing their logic. A
 * check that repeats the implementation only proves the two agree.
 */

const SEEDED_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SETTLE_MS = 3_000;

export async function runProductionChecks(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail: string): void => {
		results.push({ name, ok, detail });
	};
	const log = vscode.window.createOutputChannel('CTB Host Checks', { log: true });

	// The exact form the transcript watcher used to record, run through the shipped
	// normaliser and then through the shipped reveal. If this passes, the path a real
	// reply takes is proven end to end.
	const normalised = asChatSessionResource(SEEDED_SESSION_ID);
	add(
		'the shipped normaliser produces a usable resource',
		normalised === `vscode-chat-session://local/${Buffer.from(SEEDED_SESSION_ID, 'utf8').toString('base64')}`,
		`bare id -> ${normalised}`
	);

	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await delay(SETTLE_MS);

	if (!normalised) {
		add('the shipped reveal brings the chat to the front', false, 'skipped: nothing to aim at');
		return results;
	}

	const revealed = await revealChatSessionInEditor(normalised, log);
	add(
		'the shipped reveal brings the chat to the front',
		revealed,
		`revealChatSessionInEditor(${normalised}) -> ${revealed}; activeTab=${describeActiveTab()}`
	);

	// The other half: the shipped reveal must *refuse* what it cannot address, rather than
	// reporting success and leaving the reply to be written into whatever is in front.
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await delay(SETTLE_MS);
	const refusedBareId = !(await revealChatSessionInEditor(SEEDED_SESSION_ID, log));
	add(
		'the shipped reveal refuses an unusable reference',
		refusedBareId,
		`revealChatSessionInEditor("${SEEDED_SESSION_ID}") -> ${!refusedBareId}; must refuse rather than ` +
			`claim a reveal it did not achieve`
	);

	log.dispose();
	return results;
}

function describeActiveTab(): string {
	const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
	const input = tab?.input as { constructor?: { name?: string } } | undefined;
	return `${input?.constructor?.name ?? 'none'}(${JSON.stringify(tab?.label ?? '')})`;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
