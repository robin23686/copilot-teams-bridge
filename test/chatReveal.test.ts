import * as assert from 'assert';
import { describe, it, before, beforeEach } from 'node:test';

/**
 * The focus race in `revealChatSessionInEditor`.
 *
 * Live evidence: `workbench.action.chat.openSessionInEditorGroup` makes the chat editor
 * tab active, but does not necessarily move keyboard focus into it. VS Code's
 * `OpenChatGlobalAction` (chatActions.ts) reads `IChatWidgetService.lastFocusedWidget`, so
 * the very next `workbench.action.chat.open` still writes to whichever chat was last
 * clicked into — a trace showed the target tab label became "Capabilities and ideas
 * overview" while the reply text landed in "Logging implementation ideas".
 *
 * The fix explicitly executes `workbench.action.focusActiveEditorGroup` after the reveal
 * confirms a chat editor is in front, then settles briefly so the widget service records
 * the focus change before the write is issued.
 */

interface Call {
	command: string;
	arg?: unknown;
}

let executed: Call[] = [];
/** Whether the tab-groups fake reports a chat editor is the active tab. */
let chatInFront = true;
/** Whether the focus command rejects, standing in for a host missing it. */
let focusRejects = false;

let revealChatSessionInEditor:
	| ((resource: string, log: unknown, trace?: unknown) => Promise<boolean>)
	| undefined;

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);

	class FakeTabInputChat {}

	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode'
			? {
					Uri: {
						parse: (value: string) => ({
							scheme: value.split(':')[0],
							authority: 'local',
							toString: () => value
						})
					},
					TabInputChat: FakeTabInputChat,
					commands: {
						executeCommand: async (command: string, arg: unknown): Promise<void> => {
							executed.push({ command, arg });
							if (command === 'workbench.action.focusActiveEditorGroup' && focusRejects) {
								throw new Error('command not found');
							}
						}
					},
					window: {
						tabGroups: {
							activeTabGroup: {
								get activeTab(): { input: unknown } | undefined {
									return chatInFront ? { input: new FakeTabInputChat() } : { input: {} };
								}
							}
						}
					}
				}
			: originalLoad(request, parent, isMain);

	const module = require('../src/hosts/vscode/chatReveal') as {
		revealChatSessionInEditor: typeof revealChatSessionInEditor;
	};
	/* eslint-enable @typescript-eslint/no-require-imports */
	Module._load = originalLoad;
	revealChatSessionInEditor = module.revealChatSessionInEditor;
});

function fakeLog(): unknown {
	return { info: () => undefined, warn: () => undefined };
}

describe('revealChatSessionInEditor focuses the editor group after reveal', () => {
	beforeEach(() => {
		executed = [];
		chatInFront = true;
		focusRejects = false;
	});

	// The primary bug: reveal → write is not atomic, because the chat tab can be active
	// while `lastFocusedWidget` still points at the previously focused chat. Explicitly
	// focusing the active editor group updates that pointer, so the very next
	// `workbench.action.chat.open` reads it as the revealed chat.
	it('issues focusActiveEditorGroup between the reveal and any write', async () => {
		const trace: { steps: string[] } = { steps: [] };
		const ok = await revealChatSessionInEditor!('vscode-chat-session://local/mine', fakeLog(), trace);

		assert.strictEqual(ok, true, 'the reveal must succeed when a chat editor is in front');
		const order = executed.map((call) => call.command);
		assert.deepStrictEqual(
			order,
			['workbench.action.chat.openSessionInEditorGroup', 'workbench.action.focusActiveEditorGroup'],
			'the focus command must follow the reveal, and there must be no write in between'
		);
		assert.ok(
			trace.steps.some((step) => step === 'focusedEditorGroup'),
			`the trace must record focusedEditorGroup: ${JSON.stringify(trace.steps)}`
		);
	});

	// A host missing this command still has a chat editor in front, so we still consider
	// the reveal to have succeeded — refusing delivery here would strand every reply on a
	// host that renames or drops the focus command. The rejection is recorded in the trace.
	it('records the focus rejection but does not fail the reveal', async () => {
		focusRejects = true;
		const trace: { steps: string[] } = { steps: [] };
		const ok = await revealChatSessionInEditor!('vscode-chat-session://local/mine', fakeLog(), trace);

		assert.strictEqual(ok, true, 'a rejection must not cancel a reveal whose chat is in front');
		assert.ok(
			trace.steps.some((step) => step.startsWith('focusCommandRejected(')),
			`the trace must record focusCommandRejected: ${JSON.stringify(trace.steps)}`
		);
	});

	// No chat editor in front means the reveal itself failed. In that case the focus
	// command must not be issued at all — there is nothing to focus, and pretending
	// otherwise would hide the reveal failure.
	it('does not focus when no chat editor came to the front', async () => {
		chatInFront = false;
		const ok = await revealChatSessionInEditor!('vscode-chat-session://local/mine', fakeLog());

		assert.strictEqual(ok, false, 'a reveal with no chat editor in front must fail');
		assert.deepStrictEqual(
			executed.filter((call) => call.command === 'workbench.action.focusActiveEditorGroup'),
			[],
			'the focus command must not be issued when there is no chat editor to focus'
		);
	});
});
