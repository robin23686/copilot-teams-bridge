import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, before, after } from 'node:test';
import { useTempHome } from './support/tempHome';

// The extension module constructs a JsonDeliveredRepliesRegistry at module scope and
// resolves its file path at that moment, so COPILOT_TEAMS_BRIDGE_HOME MUST be set before
// `require('../src/hosts/vscode/extension')` — which happens later, inside `before`.
// Setting it here, at the top of the file, guarantees the registry is aimed at a scratch
// directory rather than the developer's real ~/.copilot-teams-bridge, whose delivered.json
// would otherwise tombstone reply ids reused across runs and silently break the second
// invocation of `npm test`.
const tempHome = useTempHome('ctb-ext-home-');

import { chatSessionResourceFor } from '../src/domain/chatSessionLink';

/**
 * Integration test for the VS Code layer.
 *
 * The extension is loaded against a hand-rolled mock of the `vscode` module so that
 * activation, tool registration, command registration and a real notify round trip can be
 * exercised headlessly. This catches API misuse that unit tests on `src/core` cannot,
 * such as registering a tool whose name does not match package.json.
 */

interface Registered {
	tools: Map<string, { invoke(options: unknown, token: unknown): Promise<unknown>; prepareInvocation?(options: unknown): unknown }>;
	commands: Map<string, () => unknown>;
	mcpProviders: Map<string, { provideMcpServerDefinitions(): unknown[] }>;
	written: Map<string, string>;
	executed: { command: string; args: unknown[] }[];
	infoMessages: string[];
	errorMessages: string[];
	warningMessages: string[];
	statusBarText: string;
	/** Stands in for the editor tab that is in front, which is what steers a reply. */
	activeTab?: { input: object };
}

const registered: Registered = {
	tools: new Map(),
	commands: new Map(),
	mcpProviders: new Map(),
	written: new Map(),
	executed: [],
	infoMessages: [],
	errorMessages: [],
	warningMessages: [],
	statusBarText: '',
	activeTab: undefined
};


/**
 * Listeners the extension registered for setting changes.
 *
 * Settings are read once at activation, so a test that edits {@link settings} alone changes
 * nothing — which is exactly how a test can pass while proving nothing. Driving the real
 * reload path makes a changed setting take effect the way it does for a user.
 */
const configListeners: ((event: { affectsConfiguration(section: string): boolean }) => void)[] = [];

/** Applies setting changes and lets the extension notice them, then restores the old values. */
async function withSettings(changes: Record<string, unknown>, body: () => Promise<void>): Promise<void> {
	const before = settings;
	const next = { ...settings };
	for (const [key, value] of Object.entries(changes)) {
		// undefined means "unset", so a test can exercise the shipped default.
		if (value === undefined) {
			delete next[key];
		} else {
			next[key] = value;
		}
	}
	settings = next;
	notifyConfigChanged();
	try {
		await body();
	} finally {
		settings = before;
		notifyConfigChanged();
	}
}

function notifyConfigChanged(): void {
	for (const listener of configListeners) {
		listener({ affectsConfiguration: () => true });
	}
}

const BUNDLED_INSTRUCTIONS = 'current guidance shipped with this build';

let tempDir: string;
let settings: Record<string, unknown>;
const globalStateStore = new Map<string, unknown>();

class FakeUri {
	constructor(readonly value: string, readonly fsPath: string = value) {}
	static parse(value: string): FakeUri {
		return new FakeUri(value);
	}
	static file(value: string): FakeUri {
		return new FakeUri(value, value);
	}
	static from(parts: { scheme: string; path?: string }): FakeUri {
		return new FakeUri(`${parts.scheme}:${parts.path ?? ""}`);
	}
	static joinPath(base: { fsPath: string }, ...parts: string[]): FakeUri {
		const joined = path.join(base.fsPath, ...parts);
		return new FakeUri(joined, joined);
	}
	toString(): string {
		return this.value;
	}
}

/** Stands in for vscode.TabInputChat, which really is an empty class. */
class FakeTabInputChat {}

function buildVscodeMock(): Record<string, unknown> {
	return {
		TabInputChat: FakeTabInputChat,
		window: {
			tabGroups: {
				get activeTabGroup() {
					return { activeTab: registered.activeTab };
				},
				get all() {
					return registered.activeTab ? [{ tabs: [registered.activeTab] }] : [];
				}
			},
			createOutputChannel: () => ({
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				debug: () => undefined,
				show: () => undefined,
				dispose: () => undefined
			}),
			createStatusBarItem: () => ({
				show: () => undefined,
				dispose: () => undefined,
				set text(value: string) {
					registered.statusBarText = value;
				},
				get text(): string {
					return registered.statusBarText;
				},
				tooltip: '',
				command: ''
			}),
			showInformationMessage: (message: string) => {
				registered.infoMessages.push(message);
				return Promise.resolve(undefined);
			},
			showErrorMessage: (message: string) => {
				registered.errorMessages.push(message);
				return Promise.resolve(undefined);
			},
			showWarningMessage: (message: string) => {
				registered.warningMessages.push(message);
				return Promise.resolve(undefined);
			},
			showInputBox: () => Promise.resolve(undefined),
			showQuickPick: () => Promise.resolve(undefined),
			withProgress: (_options: unknown, task: () => unknown) => Promise.resolve(task())
		},
		commands: {
			registerCommand: (id: string, handler: () => unknown) => {
				registered.commands.set(id, handler);
				return { dispose: () => undefined };
			},
			executeCommand: (command: string, ...args: unknown[]) => {
				registered.executed.push({ command, args });
				return Promise.resolve(undefined);
			}
		},
		lm: {
			registerTool: (name: string, tool: { invoke(options: unknown, token: unknown): Promise<unknown> }) => {
				registered.tools.set(name, tool);
				return { dispose: () => undefined };
			},
			registerMcpServerDefinitionProvider: (id: string, provider: { provideMcpServerDefinitions(): unknown[] }) => {
				registered.mcpProviders.set(id, provider);
				return { dispose: () => undefined };
			}
		},
		RelativePattern: class {
			constructor(readonly base: unknown, readonly pattern: string) {}
		},
		workspace: {
			createFileSystemWatcher: () => ({
				onDidCreate: () => ({ dispose: () => undefined }),
				onDidChange: () => ({ dispose: () => undefined }),
				onDidDelete: () => ({ dispose: () => undefined }),
				dispose: () => undefined
			}),
			getConfiguration: () => ({
				get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback)
			}),
			onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) => {
				configListeners.push(listener);
				return { dispose: () => undefined };
			},
			fs: {
				createDirectory: () => Promise.resolve(),
				writeFile: (uri: { fsPath: string }, content: Uint8Array) => {
					registered.written.set(uri.fsPath, Buffer.from(content).toString("utf8"));
					return Promise.resolve();
				},
				readFile: (uri: { fsPath: string }) => {
					if (uri.fsPath.endsWith('teams-bridge.instructions.md')) {
						if (uri.fsPath.includes('assets')) {
							return Promise.resolve(Buffer.from(BUNDLED_INSTRUCTIONS, "utf8"));
						}
						// An older copy, as an existing user would have on disk.
						return Promise.resolve(Buffer.from("stale guidance from an earlier version", "utf8"));
					}
					if (!uri.fsPath.endsWith('mcp.json')) {
						return Promise.reject(new Error('not found'));
					}
					// A leftover manual entry, the state every existing user upgrades from.
					const contents = JSON.stringify({
						servers: {
							'copilot-teams-bridge': { command: 'node', args: ['C:\\code\\copilot-teams-bridge\\out\\src\\mcp\\stdio.js'] }
						}
					});
					return Promise.resolve(Buffer.from(contents, 'utf8'));
				}
			},
			openTextDocument: () => Promise.resolve({}),
			workspaceFolders: [{ name: 'test-workspace' }],
			name: 'test-workspace'
		},
		authentication: {
			getSession: () => Promise.resolve(undefined)
		},
		env: {
			clipboard: { writeText: () => Promise.resolve() },
			openExternal: () => Promise.resolve(true),
			asExternalUri: (uri: unknown) => Promise.resolve(uri)
		},
		Uri: FakeUri,
		StatusBarAlignment: { Right: 2, Left: 1 },
		ProgressLocation: { Notification: 15 },
		LanguageModelToolResult: class {
			constructor(readonly content: unknown[]) {}
		},
		LanguageModelTextPart: class {
			constructor(readonly value: string) {}
		},
		EventEmitter: class {
			private readonly listeners: ((value: unknown) => void)[] = [];
			readonly event = (listener: (value: unknown) => void): { dispose(): void } => {
				this.listeners.push(listener);
				return { dispose: () => undefined };
			};
			fire(value?: unknown): void {
				for (const listener of this.listeners) {
					listener(value);
				}
			}
			dispose(): void {
				this.listeners.length = 0;
			}
		},
		McpStdioServerDefinition: class {
			constructor(
				readonly label: string,
				readonly command: string,
				readonly args: string[],
				readonly env: Record<string, string>,
				readonly version: string
			) {}
		}
	};
}

function makeContext(): Record<string, unknown> {
	return {
		subscriptions: [] as { dispose(): void }[],
		extensionUri: { fsPath: path.join(tempDir, 'extension') },
		extension: { packageJSON: { version: '9.9.9' } },
		globalStorageUri: { fsPath: path.join(tempDir, 'globalStorage') },
		// Delivery reads the chat transcripts to tell which chat is in front, so the suite
		// has to own a transcript folder rather than pointing at the real one.
		storageUri: { fsPath: path.join(tempDir, 'workspaceStorage', 'ws') },
		secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() },
		globalState: {
			get: (key: string, fallback: unknown) => globalStateStore.get(key) ?? fallback,
			update: (key: string, value: unknown) => {
				globalStateStore.set(key, value);
				return Promise.resolve();
			}
		}
	};
}

/** Where the extension looks for chat transcripts, given the fixture's storage layout. */
function transcriptDir(): string {
	return path.join(tempDir, 'workspaceStorage', 'chatSessions');
}

/**
 * Makes `chatSessionId` the chat the user is working in.
 *
 * VS Code writes a transcript per chat as the conversation progresses, so the newest one
 * is the chat in front. That is the only signal available: no API reports the focused chat,
 * and the one command that targets a session moves it out of the side bar.
 */
function workingIn(chatSessionId: string): void {
	fs.mkdirSync(transcriptDir(), { recursive: true });
	const file = path.join(transcriptDir(), `${chatSessionId}.jsonl`);
	fs.writeFileSync(file, '{}\n');
	// Mtime granularity is coarse enough that two writes in the same millisecond tie, and a
	// tie makes "the newest transcript" ambiguous — which is a flaky test, not a real
	// signal. Pushing this one forward states the intent outright.
	const ahead = new Date(Date.now() + 2_000);
	fs.utimesSync(file, ahead, ahead);
}

let extension: { activate(context: unknown): void; deactivate(): void };

describe('extension activation', () => {
	before(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-ext-'));
		settings = {
			transport: 'file',
			'file.directory': path.join(tempDir, 'transport'),
			autoStart: false,
			pollIntervalSeconds: 3,
			// Most of this suite predates targeted delivery and drives replies whose chat is
			// unknown, so it opts into focus delivery explicitly. The shipped default is
			// 'hold', which the tests below assert by removing this key.
			unroutableReplies: 'focusedChat',
			// Most of this suite predates steering and asserts what happens without it, so
			// it opts out explicitly. The shipped default is 'editorGroup', which the
			// dedicated tests below turn back on.
			replyTargeting: 'sidebarOnly',
			// Proof of delivery is read from a transcript the fixture writes synchronously,
			// so the real budget would only add dead time to every steered case.
			deliveryConfirmSeconds: 1,
			// Waiting out the real timeout would add seconds per test for no coverage.
			revealTimeoutMs: 150
		};

		// The vscode module only exists inside a real extension host, so it is stubbed by
		// patching the loader before the extension is required. This genuinely needs
		// require(): the interception must happen at runtime, after the mock is built.
		/* eslint-disable @typescript-eslint/no-require-imports */
		const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
		const originalLoad = Module._load.bind(Module);
		const mock = buildVscodeMock();
		Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
			request === 'vscode' ? mock : originalLoad(request, parent, isMain);

		extension = require('../src/hosts/vscode/extension') as typeof extension;
		/* eslint-enable @typescript-eslint/no-require-imports */
	});

	after(() => {
		try {
			extension.deactivate();
		} catch {
			// Deactivation errors must not mask assertion failures.
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempHome.cleanup();
	});

	it('activates without throwing', () => {
		assert.doesNotThrow(() => extension.activate(makeContext()));
	});

	it('registers the notify tool under the name declared in package.json', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { languageModelTools: { name: string }[] };
		};
		const declared = manifest.contributes.languageModelTools.map((tool) => tool.name);

		assert.deepStrictEqual([...registered.tools.keys()], declared);
	});

	it('registers every command declared in package.json', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { commands: { command: string }[] };
		};

		for (const { command } of manifest.contributes.commands) {
			assert.ok(registered.commands.has(command), `command not registered: ${command}`);
		}
	});

	it('serves the bundled MCP server so it does not depend on a checkout path', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { mcpServerDefinitionProviders: { id: string }[] };
		};
		const declared = manifest.contributes.mcpServerDefinitionProviders.map((entry) => entry.id);

		assert.deepStrictEqual([...registered.mcpProviders.keys()], declared, 'provider id must match package.json');

		const provider = registered.mcpProviders.get(declared[0]);
		const definitions = provider?.provideMcpServerDefinitions() as {
			command: string;
			args: string[];
			env: Record<string, string>;
			version: string;
		}[];

		assert.strictEqual(definitions.length, 1);
		const [definition] = definitions;
		assert.strictEqual(definition.command, process.execPath, 'should reuse the editor runtime');
		// The entry point must live inside the installed extension, never a working copy.
		assert.ok(
			definition.args[0].startsWith(path.join(tempDir, 'extension') + path.sep),
			`entry point escaped the extension folder: ${definition.args[0]}`
		);
		assert.strictEqual(definition.env.ELECTRON_RUN_AS_NODE, '1');
		assert.ok(definition.version.includes('9.9.9'), 'version should change when the extension updates');
	});

	// Guidance changes as the bridge does. A user who ran setup once would otherwise keep
	// the original behaviour for good, with nothing to explain the mismatch.
	it('refreshes instructions that are older than the build', async () => {
		for (let attempt = 0; attempt < 50 && registered.written.size === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const instructionFiles = [...registered.written.entries()].filter(([target]) =>
			target.endsWith('teams-bridge.instructions.md')
		);

		assert.ok(instructionFiles.length > 0, 'a stale instructions file must be rewritten');
		for (const [target, content] of instructionFiles) {
			assert.strictEqual(content, BUNDLED_INSTRUCTIONS, `not refreshed from the bundled copy: ${target}`);
		}

		// Both hosts read different folders, so one alone leaves the other stale.
		const folders = instructionFiles.map(([target]) => (target.includes('.copilot') ? 'agent' : 'chat'));
		assert.ok(folders.includes('chat'), 'the chat sidebar folder must be refreshed');
		assert.ok(folders.includes('agent'), 'the agent/CLI folder must be refreshed');
	});

	it('warns about a leftover mcp.json entry that would race the same store', async () => {
		// Activation fires this without awaiting it, so give the read a chance to land.
		for (let attempt = 0; attempt < 50 && registered.warningMessages.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const warning = registered.warningMessages.find((message) => message.includes('mcp.json'));
		assert.ok(warning, `expected a duplicate-entry warning, got: ${JSON.stringify(registered.warningMessages)}`);
		assert.ok(warning.includes('copilot-teams-bridge'), 'the warning should name the entry to remove');
	});

	it('posts a notification when the tool is invoked', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		assert.ok(tool, 'notify tool must be registered');

		const result = (await tool.invoke(
			{
				input: {
					title: 'Integration test',
					summary: 'Posted from the activation test.',
					status: 'completed',
					sessionKey: 'integration-1'
				}
			},
			{ isCancellationRequested: false, onCancellationRequested: () => undefined }
		)) as { content: { value: string }[] };

		const text = result.content.map((part) => part.value).join('');
		assert.ok(text.includes('integration-1'), `unexpected tool result: ${text}`);

		const outbox = path.join(tempDir, 'transport', 'outbox.jsonl');
		assert.ok(fs.existsSync(outbox), 'notification should have been written');
		assert.ok(fs.readFileSync(outbox, 'utf8').includes('Integration test'));
	});

	// The sidebar user is already watching; a Teams post must not become their only update.
	it('tells the agent to answer in the chat as well as Teams', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		assert.ok(tool, 'notify tool must be registered');

		const result = (await tool.invoke(
			{
				input: {
					title: 'Chat visibility',
					summary: 'Work finished.',
					status: 'completed',
					sessionKey: 'chat-visibility'
				}
			},
			{ isCancellationRequested: false, onCancellationRequested: () => undefined }
		)) as { content: { value: string }[] };

		const text = result.content.map((part) => part.value).join('');
		assert.match(text, /not a replacement for this chat/, `unexpected tool result: ${text}`);
	});

	// The sidebar is the user's own reply route. Blocking on Teams freezes the turn and takes
	// it away, so the manifest must not tell the model to block by default.
	it('does not tell the model to block on Teams by default', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { languageModelTools: { name: string; modelDescription: string }[] };
		};

		const notify = manifest.contributes.languageModelTools.find((tool) => tool.name === 'copilotTeamsBridge_notify');
		assert.ok(notify, 'notify tool must be declared');
		assert.match(notify.modelDescription, /LEAVE waitForReply UNSET/, 'blocking must not be the default');
		assert.doesNotMatch(notify.modelDescription, /PREFER waitForReply true/, 'the old always-block guidance must be gone');
	});

	it('returns a helpful result instead of throwing on invalid input', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		const result = (await tool?.invoke({ input: { title: '', summary: '' } }, { isCancellationRequested: false, onCancellationRequested: () => undefined })) as {
			content: { value: string }[];
		};

		assert.ok(result.content.map((p) => p.value).join('').includes('required'));
	});

	it('runs the send-test-notification command end to end', async () => {
		const handler = registered.commands.get('copilotTeamsBridge.sendTestNotification');
		assert.ok(handler, 'command must be registered');

		await handler();

		assert.strictEqual(registered.errorMessages.length, 0, `unexpected errors: ${registered.errorMessages.join('; ')}`);
		const outbox = fs.readFileSync(path.join(tempDir, 'transport', 'outbox.jsonl'), 'utf8');
		assert.ok(outbox.includes('Teams Bridge test'));
	});

	it('exposes sessions through the show-sessions command without error', async () => {
		const handler = registered.commands.get('copilotTeamsBridge.showSessions');
		await handler?.();
		assert.strictEqual(registered.errorMessages.length, 0);
	});

	it('delivers an incoming reply into Copilot Chat', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		await tool?.invoke(
			{
				input: {
					title: 'Reply routing',
					summary: 'Waiting for instructions.',
					status: 'needs-input',
					sessionKey: 'reply-routing'
				}
			},
			{ isCancellationRequested: false, onCancellationRequested: () => undefined }
		);

		// Stands in for the user typing in the Teams thread for this session.
		const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
		const session = sessions.find((entry) => entry.key === 'reply-routing');
		assert.ok(session?.thread, 'session must have a thread');

		fs.appendFileSync(
			path.join(tempDir, 'transport', 'inbox.jsonl'),
			`${JSON.stringify({
				id: 'user-reply-1',
				threadId: session.thread.id,
				text: 'add retry logic to the reserve job',
				from: 'Rob (Teams)',
				createdAt: new Date(Date.now() + 60_000).toISOString()
			})}\n`
		);

		registered.executed.length = 0;
		await registered.commands.get('copilotTeamsBridge.pollNow')?.();

		const chatOpen = registered.executed.find((entry) => entry.command === 'workbench.action.chat.open');
		assert.ok(chatOpen, `chat was not opened; executed: ${registered.executed.map((e) => e.command).join(', ')}`);

		const payload = chatOpen.args[0] as { query: string; isPartialQuery: boolean };
		assert.ok(payload.query.includes('add retry logic to the reserve job'), `reply text missing from query: ${payload.query}`);
		assert.ok(payload.query.includes('reply-routing'), 'session key should be carried so Copilot can reply to the same thread');
		// Several sessions are live by this point in the suite, so the guard holds the reply
		// in the input box rather than letting an unrelated chat act on it.
		assert.strictEqual(payload.isPartialQuery, true, 'with several sessions live the reply must not be auto-sent');
	});

	// workbench.action.chat.open takes no session target, so a reply lands in whichever chat
	// is focused. Telling an unrelated chat to resume the work invites invented continuity.
	it('warns the receiving chat that the reply may belong to a different one', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		await tool?.invoke(
			{ input: { title: 'Misrouting check', summary: 's', status: 'needs-input', sessionKey: 'misrouting' } },
			{ isCancellationRequested: false, onCancellationRequested: () => undefined }
		);

		const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
		const session = sessions.find((entry) => entry.key === 'misrouting');
		assert.ok(session?.thread, 'session must have a thread');

		fs.appendFileSync(
			path.join(tempDir, 'transport', 'inbox.jsonl'),
			`${JSON.stringify({
				id: 'misrouting-reply',
				threadId: session.thread.id,
				text: 'ship it',
				from: 'Rob (Teams)',
				createdAt: new Date(Date.now() + 60_000).toISOString()
			})}\n`
		);

		registered.executed.length = 0;
		await registered.commands.get('copilotTeamsBridge.pollNow')?.();

		const chatOpen = registered.executed.find((entry) => entry.command === 'workbench.action.chat.open');
		const query = (chatOpen?.args[0] as { query: string }).query;

		assert.match(query, /may have arrived in the wrong one/, 'must admit it could be misrouted');
		assert.match(query, /say so and stop/, 'an unrelated chat must be told not to act');
		assert.match(query, /Misrouting check/, 'must name the task it belongs to');
	});

	// The guard is what stops parallel work being corrupted, so it must actually depend on
	// how many sessions are live rather than being a fixed choice.
	it('auto-sends only while a single session is live', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');

		const deliver = async (key: string, text: string): Promise<boolean> => {
			await tool?.invoke(
				{ input: { title: key, summary: 's', status: 'needs-input', sessionKey: key } },
				{ isCancellationRequested: false, onCancellationRequested: () => undefined }
			);
			const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
			const session = sessions.find((entry) => entry.key === key);

			fs.appendFileSync(
				path.join(tempDir, 'transport', 'inbox.jsonl'),
				`${JSON.stringify({
					id: `reply-${key}`,
					threadId: session?.thread?.id,
					text,
					from: 'Rob (Teams)',
					createdAt: new Date(Date.now() + 600_000).toISOString()
				})}\n`
			);

			registered.executed.length = 0;
			await registered.commands.get('copilotTeamsBridge.pollNow')?.();
			const opened = registered.executed.find((entry) => entry.command === 'workbench.action.chat.open');
			return (opened?.args[0] as { isPartialQuery: boolean }).isPartialQuery;
		};

		// Earlier tests leave sessions behind. Close them the way a user would, with /stop,
		// rather than editing the store the bridge has already read into memory.
		const existing = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; closed?: boolean; thread?: { id: string } }[];
		for (const [index, entry] of existing.entries()) {
			if (entry.closed || !entry.thread) {
				continue;
			}
			fs.appendFileSync(
				path.join(tempDir, 'transport', 'inbox.jsonl'),
				`${JSON.stringify({
					id: `close-${index}`,
					threadId: entry.thread.id,
					text: '/stop',
					from: 'Rob (Teams)',
					createdAt: new Date(Date.now() + 300_000).toISOString()
				})}\n`
			);
		}
		await registered.commands.get('copilotTeamsBridge.pollNow')?.();

		const heldWhenAlone = await deliver('solo-session', 'only task running');
		assert.strictEqual(heldWhenAlone, false, 'a lone session is unambiguous, so the reply should be sent');

		const heldWhenCrowded = await deliver('second-session', 'a competing task');
		assert.strictEqual(heldWhenCrowded, true, 'with two sessions live the reply must be held for the user to check');
	});

	// The failure that reached a real user on 2026-08-28, twice. Delivery cannot confirm the
	// chat is in front, and the first attempt at a safe middle ground — drafting rather than
	// sending — was no safer at all: `workbench.action.chat.open` writes to the *focused*
	// chat either way, so `isPartialQuery` only chooses whether Copilot runs, never which
	// conversation receives the text. The draft landed in the user's current chat.
	//
	// With steering off there is nothing left to do but keep it, so nothing may be written.
	it('writes nothing when steering is off and the chat is not in front', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		const chatUri = FakeUri.parse(chatSessionResourceFor('never-focuses'));
		// The user is working somewhere else entirely.
		workingIn('a-different-chat');

		await tool?.invoke(
			{
				input: { title: 'Silent reveal', summary: 's', status: 'needs-input', sessionKey: 'silent-reveal' },
				toolInvocationToken: { sessionResource: chatUri }
			},
			{ isCancellationRequested: false, onCancellationRequested: () => undefined }
		);

		const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
		const session = sessions.find((entry) => entry.key === 'silent-reveal');
		fs.appendFileSync(
			path.join(tempDir, 'transport', 'inbox.jsonl'),
			JSON.stringify({
				id: 'silent-reveal-reply',
				threadId: session?.thread?.id,
				text: 'this must not land in someone else chat',
				from: 'Rob (Teams)',
				createdAt: new Date(Date.now() + 960_000).toISOString()
			}) + '\n'
		);

		registered.executed.length = 0;
		await withSettings({ unroutableReplies: undefined }, async () => {
			await registered.commands.get('copilotTeamsBridge.pollNow')?.();
		});

		// Steering is off for this suite, so no chat may be relocated to reach the reply.
		const moved = registered.executed.filter((entry) => /openSessionIn/.test(entry.command));
		assert.deepStrictEqual(moved, [], 'sidebarOnly must never move a chat session');

		assert.deepStrictEqual(
			registered.executed.filter((entry) => entry.command === 'workbench.action.chat.open'),
			[],
			'a reply for another chat must not be written into the one in front, drafted or sent'
		);

		// Not written is only safe if it is also not lost, so it must be retained for retry.
		const stored = globalStateStore.get('copilotTeamsBridge.sessions') as {
			key: string;
			pending?: { reply: { id: string } }[];
		}[];
		const retained = stored.find((entry) => entry.key === 'silent-reveal');
		assert.ok(
			retained?.pending?.some((held) => held.reply.id === 'silent-reveal-reply'),
			'the reply must be kept so it is delivered once that chat comes to the front'
		);
	});
	// The regression this fix guards: transcript-recency is not proof of the focused chat.
	// A target whose transcript grew most recently — because it was the last chat to
	// receive a write, or because a background writer touched it — is still not necessarily
	// the one the user is looking at, so the owning chat must be *revealed* before writing
	// even in this case. Skipping the reveal here is what put replies into the wrong
	// focused chat on 2026-08-28.
	it('reveals the owning chat before writing, even when it is reported as active', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		const chatUri = FakeUri.parse(chatSessionResourceFor('session-42'));

		await tool?.invoke(
			{
				input: { title: 'Targeted task', summary: 's', status: 'needs-input', sessionKey: 'targeted' },
				// Shape the extension host really passes, though it is typed `never`.
				toolInvocationToken: { sessionResource: chatUri }
			},
			{ isCancellationRequested: false, onCancellationRequested: () => undefined }
		);

		const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
		const session = sessions.find((entry) => entry.key === 'targeted');

		fs.appendFileSync(
			path.join(tempDir, 'transport', 'inbox.jsonl'),
			`${JSON.stringify({
				id: 'targeted-reply',
				threadId: session?.thread?.id,
				text: 'carry on with the targeted task',
				from: 'Rob (Teams)',
				createdAt: new Date(Date.now() + 900_000).toISOString()
			})}\n`
		);

		// The transcript for this session is the most recently touched — the exact heuristic
		// the old code treated as proof of focus. The fix must still reveal it before
		// writing, because that heuristic is not proof of anything.
		workingIn('session-42');
		// The reveal succeeds: a chat editor comes to the front when the command runs.
		registered.activeTab = { input: new FakeTabInputChat() };
		// And the target's transcript will show the delivery marker, confirming landing.
		const marker = '[Teams reply \u00b7 session "Targeted task" \u00b7 from Rob (Teams)]';
		fs.writeFileSync(
			path.join(transcriptDir(), 'session-42.jsonl'),
			`${JSON.stringify({ message: { text: marker } })}\n`
		);
		registered.executed.length = 0;
		await withSettings({ replyTargeting: 'editorGroup' }, async () => {
			await registered.commands.get('copilotTeamsBridge.pollNow')?.();
		});
		registered.activeTab = undefined;

		// The reveal must happen *even though* the target was reported as active.
		const moved = registered.executed.filter(
			(entry) =>
				entry.command === 'workbench.action.chat.openSessionInEditorGroup' &&
				String((entry.args[0] as { resource: { toString(): string } }).resource) ===
					chatSessionResourceFor('session-42')
		);
		assert.strictEqual(
			moved.length,
			1,
			'the owning chat must be revealed before writing, regardless of transcript recency'
		);

		// And the reveal must come before the write.
		const revealedIndex = registered.executed.findIndex(
			(entry) =>
				entry.command === 'workbench.action.chat.openSessionInEditorGroup' &&
				String((entry.args[0] as { resource: { toString(): string } }).resource) ===
					chatSessionResourceFor('session-42')
		);
		const writeIndex = registered.executed.findIndex(
			(entry, index) => index > revealedIndex && entry.command === 'workbench.action.chat.open'
		);
		assert.ok(
			revealedIndex >= 0 && writeIndex > revealedIndex,
			'the write must come after the reveal, never before'
		);

		const chatOpen = registered.executed[writeIndex];
		const payload = chatOpen.args[0] as { query: string; isPartialQuery: boolean };
		assert.notStrictEqual(payload.isPartialQuery, true, 'and be sent, since the reveal steered to its own chat');
		assert.match(payload.query, /carry on with the targeted task/, 'with the instruction intact');
		// The warning only belongs on a reply that may have landed somewhere unrelated;
		// here it would tell the right chat to doubt work it really did do.
		assert.doesNotMatch(payload.query, /may have arrived in the wrong one/, 'and no false doubt');
	});

	// The restored editor route, end to end through the extension: a reply whose chat is
	// not in front must steer to that chat rather than be kept waiting for the user.
	it('opens the owning chat in an editor group when it is not in front', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		const chatUri = FakeUri.parse(chatSessionResourceFor('steer-me'));

		await tool?.invoke(
			{
				input: { title: 'Steered task', summary: 's', status: 'needs-input', sessionKey: 'steered' },
				toolInvocationToken: { sessionResource: chatUri }
			},
			{ isCancellationRequested: false, onCancellationRequested: () => undefined }
		);

		const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
		const session = sessions.find((entry) => entry.key === 'steered');
		fs.appendFileSync(
			path.join(tempDir, 'transport', 'inbox.jsonl'),
			`${JSON.stringify({
				id: 'steered-reply',
				threadId: session?.thread?.id,
				text: 'steer this one home',
				from: 'Rob (Teams)',
				createdAt: new Date(Date.now() + 2_400_000).toISOString()
			})}\n`
		);

		// The transcript proof: VS Code records a request in the transcript of the chat that
		// received it, so this is what tells the bridge the reveal really did steer here.
		// Written as JSON, exactly as a real transcript stores it — and written *first*, so
		// the chat the user is in stays the most recently touched one.
		const marker = '[Teams reply \u00b7 session "Steered task" \u00b7 from Rob (Teams)]';
		fs.mkdirSync(transcriptDir(), { recursive: true });
		fs.writeFileSync(
			path.join(transcriptDir(), 'steer-me.jsonl'),
			`${JSON.stringify({ message: { text: marker } })}\n`
		);
		// The user is somewhere else entirely, and a chat editor comes to the front when
		// the reveal runs — which is what the command does in a real window.
		workingIn('a-completely-different-chat');
		registered.activeTab = { input: new FakeTabInputChat() };

		registered.executed.length = 0;
		await withSettings({ replyTargeting: 'editorGroup' }, async () => {
			await registered.commands.get('copilotTeamsBridge.pollNow')?.();
		});
		registered.activeTab = undefined;

		const moved = registered.executed.filter(
			(entry) => entry.command === 'workbench.action.chat.openSessionInEditorGroup'
		);
		const mine = moved.filter(
			(entry) =>
				String((entry.args[0] as { resource: { toString(): string } }).resource) ===
				chatSessionResourceFor('steer-me')
		);
		assert.strictEqual(mine.length, 1, 'the owning chat must be brought to the front, exactly once');

		const revealed = registered.executed.findIndex(
			(entry) =>
				entry.command === 'workbench.action.chat.openSessionInEditorGroup' &&
				String((entry.args[0] as { resource: { toString(): string } }).resource) ===
					chatSessionResourceFor('steer-me')
		);
		const written = registered.executed.findIndex(
			(entry, index) => index > revealed && entry.command === 'workbench.action.chat.open'
		);
		assert.ok(revealed >= 0 && written > revealed, 'and the write must come after the reveal, never before');
	});

	// The default behaviour, and the reason it exists: revealing a chat focuses it, so the
	// last correctly-routed delivery is itself what "the focused chat" then means. Injecting
	// an unidentifiable reply anyway is not a neutral guess — it piles into whichever
	// conversation was last targeted.
	it('does not inject a reply whose chat cannot be identified', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		// undefined exercises the shipped default rather than a value this test chose.
		await withSettings({ unroutableReplies: undefined }, async () => {
			await tool?.invoke(
				{ input: { title: 'Unroutable task', summary: 's', status: 'needs-input', sessionKey: 'unroutable' } },
				{ isCancellationRequested: false, onCancellationRequested: () => undefined }
			);

			const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
			const session = sessions.find((entry) => entry.key === 'unroutable');
			assert.ok(session?.thread, 'session must have a thread');

			fs.appendFileSync(
				path.join(tempDir, 'transport', 'inbox.jsonl'),
				`${JSON.stringify({
					id: 'unroutable-reply',
					threadId: session.thread.id,
					text: 'this must not land in another conversation',
					from: 'Rob (Teams)',
					createdAt: new Date(Date.now() + 1_200_000).toISOString()
				})}\n`
			);

			registered.executed.length = 0;
			await registered.commands.get('copilotTeamsBridge.pollNow')?.();

			assert.strictEqual(
				registered.executed.filter((entry) => entry.command === 'workbench.action.chat.open').length,
				0,
				'a reply with no identified chat must not be injected anywhere'
			);

			// Silently dropping it would be worse than misrouting it, so it is reported where
			// the user sent it — the reply itself is still in that thread.
			const outbox = fs.readFileSync(path.join(tempDir, 'transport', 'outbox.jsonl'), 'utf8');
			const notice = outbox
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { threadId?: string; html?: string })
				.filter((entry) => entry.threadId === session.thread?.id)
				.find((entry) => /will not resume the work|could not be delivered/i.test(entry.html ?? ''));
			assert.ok(notice, 'the user must be told in Teams that the reply was not delivered');
			// An agent session cannot be reached from this window at all, so the notice has to
			// say what to do instead rather than imply the reply is still on its way.
			assert.match(
				notice?.html ?? '',
				/VS Code/i,
				'and told where to continue the work instead'
			);
		});

	});

	// Holding everything would pass the test above while breaking the bridge, so the
	// identified path has to keep working under exactly the same setting.
	it('still delivers an identified reply while holding unroutable ones', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		const chatUri = FakeUri.parse(chatSessionResourceFor('session-hold'));
		await withSettings({ unroutableReplies: undefined, replyTargeting: 'editorGroup' }, async () => {
			await tool?.invoke(
				{
					input: { title: 'Held mode targeting', summary: 's', status: 'needs-input', sessionKey: 'hold-targeted' },
					toolInvocationToken: { sessionResource: chatUri }
				},
				{ isCancellationRequested: false, onCancellationRequested: () => undefined }
			);

			const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
			const session = sessions.find((entry) => entry.key === 'hold-targeted');

			fs.appendFileSync(
				path.join(tempDir, 'transport', 'inbox.jsonl'),
				`${JSON.stringify({
					id: 'hold-targeted-reply',
					threadId: session?.thread?.id,
					text: 'this one knows where it belongs',
					from: 'Rob (Teams)',
					createdAt: new Date(Date.now() + 1_500_000).toISOString()
				})}\n`
			);

			// An identified reply must be revealed and delivered even when unroutables hold.
			workingIn('session-hold');
			registered.activeTab = { input: new FakeTabInputChat() };
			const marker = '[Teams reply \u00b7 session "Held mode targeting" \u00b7 from Rob (Teams)]';
			fs.writeFileSync(
				path.join(transcriptDir(), 'session-hold.jsonl'),
				`${JSON.stringify({ message: { text: marker } })}\n`
			);
			registered.executed.length = 0;
			await registered.commands.get('copilotTeamsBridge.pollNow')?.();
			registered.activeTab = undefined;

			const chatOpen = registered.executed.find((entry) => entry.command === 'workbench.action.chat.open');
			assert.ok(chatOpen, 'an identified reply must still be delivered when holding is on');
			assert.match(
				(chatOpen.args[0] as { query: string }).query,
				/this one knows where it belongs/,
				'the reply text must reach the chat that owns it'
			);
		});
	});

	it('does not deliver the same reply twice', async () => {
		// Still in the chat that just received one, so a repeat would be written rather
		// than refused: this proves deduplication, not the routing guard.
		workingIn('session-hold');
		registered.executed.length = 0;
		await registered.commands.get('copilotTeamsBridge.pollNow')?.();

		const repeats = registered.executed
			.filter((entry) => entry.command === 'workbench.action.chat.open')
			.filter((entry) => /this one knows where it belongs/.test((entry.args[0] as { query: string })?.query ?? ''));
		assert.deepStrictEqual(repeats, [], 'an already-delivered reply must not be re-injected');
	});

	it('still delivers a reply when the waiting turn was cancelled', async () => {
		const tool = registered.tools.get('copilotTeamsBridge_notify');
		assert.ok(tool, 'notify tool must be registered');

		// A chat turn the user cancels while Copilot is blocked on waitForReply. The wait is
		// abandoned but stays registered, so without care it swallows the reply that arrives
		// next and the user's message is lost rather than delivered to chat.
		let fireCancel = (): void => undefined;
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: (listener: () => void) => {
				fireCancel = listener;
				return { dispose: () => undefined };
			}
		};

		const invocation = tool.invoke(
			{ input: { title: 'Cancelled wait', summary: 'Blocked on a reply.', status: 'needs-input', sessionKey: 'cancelled-wait', waitForReply: true } },
			token
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		fireCancel();
		await invocation;

		const sessions = globalStateStore.get('copilotTeamsBridge.sessions') as { key: string; thread?: { id: string } }[];
		const session = sessions.find((entry) => entry.key === 'cancelled-wait');
		assert.ok(session?.thread, 'session must have a thread');

		fs.appendFileSync(
			path.join(tempDir, 'transport', 'inbox.jsonl'),
			`${JSON.stringify({
				id: 'user-reply-after-cancel',
				threadId: session.thread.id,
				text: 'sent right after I cancelled',
				from: 'Rob (Teams)',
				createdAt: new Date(Date.now() + 120_000).toISOString()
			})}\n`
		);

		registered.executed.length = 0;
		await registered.commands.get('copilotTeamsBridge.pollNow')?.();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const chatOpen = registered.executed.find((entry) => entry.command === 'workbench.action.chat.open');
		assert.ok(chatOpen, 'a reply arriving after cancellation must still reach chat');
		assert.ok(
			(chatOpen.args[0] as { query: string }).query.includes('sent right after I cancelled'),
			'the abandoned wait must not swallow the reply'
		);
	});

});

