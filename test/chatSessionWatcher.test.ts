import * as assert from 'assert';
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import { parseTranscript } from '../src/domain/chatTranscript';
import { asChatSessionResource, chatSessionIdFrom, chatSessionResourceFor } from '../src/domain/chatSessionLink';

/**
 * Announcing used to depend on the model choosing to call the notify tool, so a session
 * often reached Teams late or not at all. These cover reading the transcript instead,
 * including both of the shapes VS Code writes.
 */
describe('chat transcript parsing', () => {
	it('reads a transcript that carries the whole session in the first line', () => {
		const text = JSON.stringify({
			kind: 0,
			v: {
				sessionId: 'abc-123',
				customTitle: 'Reserve API work',
				requests: [{ message: { text: 'add a solutionArea filter to the reserve endpoint' } }]
			}
		});

		const parsed = parseTranscript(text);

		assert.strictEqual(parsed?.id, 'abc-123');
		assert.strictEqual(parsed?.title, 'Reserve API work');
		assert.match(parsed?.prompt ?? '', /solutionArea/);
	});

	// The long-running sessions on disk use this shape: an empty shell, then keyed deltas.
	it('reads a transcript whose fields arrive as deltas', () => {
		const text = [
			JSON.stringify({ kind: 0, v: { sessionId: 'def-456', requests: [] } }),
			JSON.stringify({ kind: 1, k: ['customTitle'], v: 'IcM investigation request' }),
			JSON.stringify({ kind: 2, k: ['requests'], v: { '0': { message: { text: 'help investigate this IcM' } } } })
		].join('\n');

		const parsed = parseTranscript(text);

		assert.strictEqual(parsed?.id, 'def-456');
		assert.strictEqual(parsed?.title, 'IcM investigation request');
		assert.match(parsed?.prompt ?? '', /help investigate/);
	});

	it('falls back to the prompt when the editor has not named the session yet', () => {
		const text = [
			JSON.stringify({ kind: 0, v: { sessionId: 'ghi-789', requests: [] } }),
			JSON.stringify({ kind: 2, k: ['requests'], v: { '0': { message: { text: 'fix the failing reserve tests' } } } })
		].join('\n');

		const parsed = parseTranscript(text);

		assert.strictEqual(parsed?.title, 'fix the failing reserve tests');
	});

	// A session with no request has not started work, so announcing it would be noise.
	it('announces nothing until the session has a request', () => {
		const text = JSON.stringify({ kind: 0, v: { sessionId: 'jkl-000', requests: [] } });

		assert.strictEqual(parseTranscript(text), undefined);
	});

	it('survives a partial write rather than throwing', () => {
		assert.strictEqual(parseTranscript('{ not json'), undefined);
		assert.strictEqual(parseTranscript(''), undefined);
		// A truncated first line must not stop a later, complete one being read.
		const recovered = parseTranscript(
			[
				JSON.stringify({ kind: 0, v: { sessionId: 'mno-111', requests: [] } }),
				'{"kind":1,"k":["custom',
				JSON.stringify({ kind: 2, k: ['requests'], v: { '0': { message: { text: 'carry on with the migration' } } } })
			].join('\n')
		);
		assert.match(recovered?.prompt ?? '', /migration/);
	});
});

/**
 * Every recorded chat identity must be a resource, never a bare session id.
 *
 * The live failure of 2026-08-28. Two producers recorded the same conversation two
 * different ways -- the notify tool stored `vscode-chat-session://local/<base64>`, the
 * transcript watcher stored the raw uuid -- and everything downstream parses a resource.
 * Every reveal was handed an unusable URI, so every reveal failed, and because the command
 * resolves silently it looked like a limitation of VS Code rather than a bug here.
 *
 * Guarded at the seam rather than in one producer, so a third producer added later cannot
 * reintroduce it quietly.
 */
describe('recorded chat identities', () => {
	// Mirrors what ChatSessionWatcher.handle builds, which is the producer that had it wrong.
	function watcherIdentityValue(sessionId: string): string {
		return chatSessionResourceFor(sessionId);
	}

	it('records the watcher chat as a resource, not a bare id', () => {
		const value = watcherIdentityValue('6acd174a-6474-4814-aa89-42afe10941e9');

		assert.ok(value.startsWith('vscode-chat-session://'), `expected a resource, got ${value}`);
		assert.strictEqual(chatSessionIdFrom(value), '6acd174a-6474-4814-aa89-42afe10941e9');
	});

	// The property that actually matters: whatever a producer recorded, delivery must end up
	// with something that addresses a session.
	it('normalises every recorded form to the same resource', () => {
		const id = '6acd174a-6474-4814-aa89-42afe10941e9';

		assert.strictEqual(asChatSessionResource(id), asChatSessionResource(chatSessionResourceFor(id)));
		assert.ok((asChatSessionResource(id) ?? '').startsWith('vscode-chat-session://'));
	});

	// A bare id is exactly what failed in the real editor, proven by the integration suite.
	it('never leaves a bare id as the delivered resource', () => {
		const delivered = asChatSessionResource('6acd174a-6474-4814-aa89-42afe10941e9');

		assert.ok(!/^[0-9a-f-]{36}$/i.test(delivered ?? ''), 'a bare uuid cannot address a chat session');
	});
});

/**
 * The revive-storm regression of 2026-08-28.
 *
 * Three unrelated sessions were revived within one millisecond, expired 65 s later, and
 * every expired thread posted a fresh "session is active again" notice — with no user
 * activity in any of those chats. The cause: `ChatSessionWatcher.schedule` treated every
 * `.jsonl` write as a chat turn and called `touch()` unconditionally, so a single
 * housekeeping re-persist of the editor tabs the bridge had opened tripped a revival for
 * each of them.
 *
 * These cover the fix: activity means "the newest turn identity in the transcript
 * changed", never "some byte in the file changed". The announce path for a brand-new
 * transcript is left alone, because that had nothing to do with the regression and was
 * working correctly.
 */
describe('chat session watcher activity detection', () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require('node:fs') as typeof import('node:fs');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const os = require('node:os') as typeof import('node:os');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const nodePath = require('node:path') as typeof import('node:path');

	interface StubUri { fsPath: string; path: string }
	type Handler = (uri: StubUri) => void;
	const listeners: { create: Handler[]; change: Handler[] } = { create: [], change: [] };

	function uriFor(fsPath: string): StubUri {
		return { fsPath, path: fsPath.replace(/\\/g, '/') };
	}

	function resetListeners(): void {
		listeners.create.length = 0;
		listeners.change.length = 0;
	}

	interface StubDisposable { dispose(): void }
	interface StubWatcher {
		onDidCreate(h: Handler): StubDisposable;
		onDidChange(h: Handler): StubDisposable;
		dispose(): void;
	}

	function makeStubWatcher(): StubWatcher {
		return {
			onDidCreate(h) { listeners.create.push(h); return { dispose() {} }; },
			onDidChange(h) { listeners.change.push(h); return { dispose() {} }; },
			dispose() {}
		};
	}

	const vscodeStub = {
		Uri: {
			file: (p: string) => uriFor(p),
			joinPath: (base: StubUri, ...parts: string[]) => uriFor(nodePath.join(base.fsPath, ...parts))
		},
		RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
		workspace: {
			fs: {
				async readFile(uri: StubUri): Promise<Uint8Array> {
					return fs.readFileSync(uri.fsPath);
				},
				async readDirectory(uri: StubUri): Promise<Array<[string, number]>> {
					return fs
						.readdirSync(uri.fsPath, { withFileTypes: true })
						.filter((entry) => entry.isFile())
						.map((entry) => [entry.name, 1] as [string, number]);
				}
			},
			createFileSystemWatcher(): StubWatcher {
				return makeStubWatcher();
			}
		}
	};

	interface WatcherCtor {
		new (deps: unknown): {
			start(): Promise<void>;
			dispose(): void;
		};
	}
	let ChatSessionWatcherCtor: WatcherCtor;

	before(() => {
		/* eslint-disable @typescript-eslint/no-require-imports */
		const Module = require('module') as {
			_load(request: string, parent: unknown, isMain: boolean): unknown;
		};
		const originalLoad = Module._load.bind(Module);
		Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
			request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
		const { ChatSessionWatcher } = require('../src/hosts/vscode/chatSessionWatcher') as {
			ChatSessionWatcher: WatcherCtor;
		};
		Module._load = originalLoad;
		/* eslint-enable @typescript-eslint/no-require-imports */
		ChatSessionWatcherCtor = ChatSessionWatcher;
	});

	// A dumping ground of test state so each `it` can start fresh.
	let tmpDir: string;
	let touched: string[];
	let announces: Array<{ sessionKey: string }>;
	let currentWatcher: { dispose(): void } | undefined;
	const silentLog = {
		info: () => undefined,
		warn: () => undefined,
		debug: () => undefined,
		error: () => undefined,
		trace: () => undefined,
		append: () => undefined,
		appendLine: () => undefined,
		clear: () => undefined,
		dispose: () => undefined,
		hide: () => undefined,
		show: () => undefined,
		replace: () => undefined,
		name: 'stub',
		logLevel: 0,
		onDidChangeLogLevel: () => ({ dispose() {} })
	};

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'ctb-watcher-'));
		touched = [];
		announces = [];
		resetListeners();
	});

	afterEach(() => {
		currentWatcher?.dispose();
		currentWatcher = undefined;
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// A stray timer holding a handle is not this test's problem.
		}
	});

	function makeWatcher(overrides: Record<string, unknown> = {}): { start(): Promise<void>; dispose(): void } {
		const deps = {
			chatSessionsUri: uriFor(tmpDir),
			log: silentLog,
			enabled: () => true,
			minPromptLength: () => 0,
			announce: async (req: { sessionKey: string }) => {
				announces.push({ sessionKey: req.sessionKey });
				return true;
			},
			touch: (key: string) => touched.push(key),
			settleMs: 5,
			announceDelayMs: 5,
			...overrides
		};
		const watcher = new ChatSessionWatcherCtor(deps);
		currentWatcher = watcher;
		return watcher;
	}

	function transcriptWith(requestIds: string[], sessionId = 'sess'): string {
		return JSON.stringify({
			kind: 0,
			v: {
				sessionId,
				customTitle: 'A conversation about something long enough to announce',
				requests: requestIds.map((id) => ({
					requestId: id,
					message: { text: `a prompt about ${id} that is comfortably longer than any minimum` },
					result: { ok: true }
				}))
			}
		});
	}

	function fireChange(fsPath: string): void {
		for (const handler of listeners.change) {
			handler(uriFor(fsPath));
		}
	}

	function fireCreate(fsPath: string): void {
		for (const handler of listeners.create) {
			handler(uriFor(fsPath));
		}
	}

	async function settle(ms = 40): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}

	// The regression itself: a write that adds nothing must not slide the idle window.
	// If this ever starts calling touch again, the flap returns.
	it('does not touch when a write adds no new turn', async () => {
		const file = nodePath.join(tmpDir, 'abc.jsonl');
		fs.writeFileSync(file, transcriptWith(['r1']));

		await makeWatcher().start();
		fs.writeFileSync(file, transcriptWith(['r1']));
		fireChange(file);
		await settle();

		assert.deepStrictEqual(touched, []);
	});

	it('touches once when a write adds a new turn', async () => {
		const file = nodePath.join(tmpDir, 'abc.jsonl');
		fs.writeFileSync(file, transcriptWith(['r1']));

		await makeWatcher().start();
		fs.writeFileSync(file, transcriptWith(['r1', 'r2']));
		fireChange(file);
		await settle();

		assert.deepStrictEqual(touched, ['chat-abc']);
	});

	// A stream of housekeeping writes must produce no touches at all — the observed
	// pattern in the incident log.
	it('produces no touches across several writes with no new turn', async () => {
		const file = nodePath.join(tmpDir, 'abc.jsonl');
		fs.writeFileSync(file, transcriptWith(['r1']));

		await makeWatcher().start();
		for (let index = 0; index < 4; index++) {
			fs.writeFileSync(file, transcriptWith(['r1']));
			fireChange(file);
			await settle(15);
		}

		assert.deepStrictEqual(touched, []);
	});

	// The reload storm: transcripts present at activation must be baselined so the first
	// housekeeping write after startup does not look "new" for every one of them.
	it('seeds transcripts present at startup so the first no-new-turn write is silent', async () => {
		const file = nodePath.join(tmpDir, 'seed.jsonl');
		fs.writeFileSync(file, transcriptWith(['seed-1']));

		await makeWatcher().start();
		fireChange(file);
		await settle();

		assert.deepStrictEqual(touched, []);
	});

	it('does nothing when the transcript cannot be read', async () => {
		const file = nodePath.join(tmpDir, 'gone.jsonl');
		fs.writeFileSync(file, transcriptWith(['r1']));

		await makeWatcher().start();
		fs.rmSync(file);
		fireChange(file);
		await settle();

		assert.deepStrictEqual(touched, []);
	});

	it('does nothing when the transcript cannot be parsed', async () => {
		const file = nodePath.join(tmpDir, 'garbage.jsonl');
		fs.writeFileSync(file, transcriptWith(['r1']));

		await makeWatcher().start();
		fs.writeFileSync(file, '{ this is not json at all');
		fireChange(file);
		await settle();

		assert.deepStrictEqual(touched, []);
	});

	// The unrelated code path — must keep working.
	it('still announces a brand-new transcript', async () => {
		await makeWatcher().start();

		const file = nodePath.join(tmpDir, 'brand-new.jsonl');
		fs.writeFileSync(
			file,
			JSON.stringify({
				kind: 0,
				v: {
					sessionId: 'brand-new-id',
					customTitle: 'Fresh chat',
					requests: [{ requestId: 'r1', message: { text: 'kick off some real work here' } }]
				}
			})
		);
		fireCreate(file);
		await settle(60);

		assert.deepStrictEqual(
			announces.map((entry) => entry.sessionKey),
			['chat-brand-new-id']
		);
		assert.deepStrictEqual(touched, []);
	});
});
