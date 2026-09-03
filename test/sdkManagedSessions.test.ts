import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import type { ModelInfo, ResumeSessionConfig, SessionConfig } from '@github/copilot-sdk';
import type { Bridge, NotifyRequest, RoutedReply } from '../src/application/bridge';
import type {
	SdkManagedSessionRecord,
	SdkManagedSessions as SdkManagedSessionsType
} from '../src/hosts/vscode/sdkManagedSessions';

interface Notice extends NotifyRequest {
	sessionId?: string;
}

class MemoryMemento {
	private readonly values = new Map<string, unknown>();

	keys(): readonly string[] {
		return [...this.values.keys()];
	}

	get<T>(key: string): T | undefined;
	get<T>(key: string, fallback: T): T;
	get<T>(key: string, fallback?: T): T | undefined {
		return (this.values.get(key) as T | undefined) ?? fallback;
	}

	update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
		return Promise.resolve();
	}
}

class FakeBridge {
	readonly notices: Notice[] = [];
	readonly closed: string[] = [];

	async notify(request: NotifyRequest): Promise<{
		session: { id: string };
		repliesSupported: boolean;
	}> {
		this.notices.push({ ...request });
		return { session: { id: request.sessionId ?? 'bridge-session-1' }, repliesSupported: true };
	}

	closeSession(sessionId: string): void {
		this.closed.push(sessionId);
	}
}

class FakeSdkSession {
	readonly prompts: { prompt: string; agentMode?: string }[] = [];
	disconnected = false;

	constructor(
		readonly sessionId: string,
		private readonly response: string = 'SDK completed the task.'
	) {}

	async sendAndWait(options: {
		prompt: string;
		agentMode?: 'interactive' | 'plan' | 'autopilot';
	}): Promise<{ data: { content: string } }> {
		this.prompts.push(options);
		return { data: { content: this.response } };
	}

	onError(handler: (message: string) => void): () => void {
		void handler;
		return () => undefined;
	}

	async disconnect(): Promise<void> {
		this.disconnected = true;
	}
}

class FakeSdkClient {
	started = 0;
	stopped = 0;
	readonly created: { config: SessionConfig; session: FakeSdkSession }[] = [];
	readonly resumed: { sessionId: string; config: ResumeSessionConfig; session: FakeSdkSession }[] = [];
	models: ModelInfo[] = [];
	response = 'SDK completed the task.';
	sendGate: Promise<void> | undefined;
	private activeSends = 0;
	maxActiveSends = 0;

	async start(): Promise<void> {
		this.started += 1;
	}

	async stop(): Promise<Error[]> {
		this.stopped += 1;
		return [];
	}

	async listModels(): Promise<ModelInfo[]> {
		return this.models;
	}

	async createSession(config: SessionConfig): Promise<FakeSdkSession> {
		const session = this.makeSession(config.sessionId ?? 'created');
		this.created.push({ config, session });
		return session;
	}

	async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<FakeSdkSession> {
		const session = this.makeSession(sessionId);
		this.resumed.push({ sessionId, config, session });
		return session;
	}

	private makeSession(sessionId: string): FakeSdkSession {
		const session = new FakeSdkSession(sessionId, this.response);
		const original = session.sendAndWait.bind(session);
		session.sendAndWait = async (options) => {
			this.activeSends += 1;
			this.maxActiveSends = Math.max(this.maxActiveSends, this.activeSends);
			try {
				await this.sendGate;
				return await original(options);
			} finally {
				this.activeSends -= 1;
			}
		};
		return session;
	}
}

let SdkManagedSessions: typeof SdkManagedSessionsType;
let modelItems: typeof import('../src/hosts/vscode/sdkManagedSessions').modelItems;
let resolveRuntimePath: typeof import('../src/hosts/vscode/sdkManagedSessions').resolveRuntimePath;

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as {
		_load(request: string, parent: unknown, isMain: boolean): unknown;
	};
	const originalLoad = Module._load.bind(Module);
	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode'
			? {
					window: {
						showWarningMessage: () => Promise.resolve(undefined)
					}
				}
			: originalLoad(request, parent, isMain);
	const loaded = require('../src/hosts/vscode/sdkManagedSessions') as typeof import('../src/hosts/vscode/sdkManagedSessions');
	SdkManagedSessions = loaded.SdkManagedSessions;
	modelItems = loaded.modelItems;
	resolveRuntimePath = loaded.resolveRuntimePath;
	Module._load = originalLoad;
	/* eslint-enable @typescript-eslint/no-require-imports */
});

after(() => undefined);

function fixture(existing?: SdkManagedSessionRecord[]): {
	manager: SdkManagedSessionsType;
	bridge: FakeBridge;
	client: FakeSdkClient;
	memento: MemoryMemento;
} {
	const bridge = new FakeBridge();
	const client = new FakeSdkClient();
	const memento = new MemoryMemento();
	if (existing) {
		void memento.update('copilotTeamsBridge.sdkManagedSessions', existing);
	}
	const manager = new SdkManagedSessions({
		memento,
		bridge: () => bridge as unknown as Bridge,
		log: { error: () => undefined, warn: () => undefined } as never,
		workspacePath: () => 'C:\\code\\project',
		runtimePath: () => 'copilot',
		createClient: () => client
	});
	return { manager, bridge, client, memento };
}

function request(): {
	title: string;
	prompt: string;
	model: string;
	agentMode: 'autopilot';
	permissionMode: 'ask';
} {
	return {
		title: 'SDK trial',
		prompt: 'Implement the change',
		model: 'gpt-test',
		agentMode: 'autopilot',
		permissionMode: 'ask'
	};
}

function routed(record: SdkManagedSessionRecord, text: string, command?: string): RoutedReply {
	return {
		session: { id: record.bridgeSessionId } as never,
		reply: { id: `reply-${text}`, text } as never,
		text,
		command
	};
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.fail(message);
}

describe('SDK-managed Teams sessions', () => {
	it('creates one durable SDK session and posts its final response to the same Teams thread', async () => {
		const { manager, bridge, client } = fixture();

		const record = await manager.start(request());

		assert.strictEqual(client.started, 1);
		assert.strictEqual(client.created.length, 1);
		assert.strictEqual(client.created[0].config.sessionId, record.sdkSessionId);
		assert.strictEqual(client.created[0].config.model, 'gpt-test');
		assert.strictEqual(client.created[0].session.prompts[0].agentMode, 'autopilot');
		assert.strictEqual(manager.records[0].sdkSessionId, record.sdkSessionId);
		assert.strictEqual(bridge.notices.length, 2);
		assert.strictEqual(bridge.notices[1].sessionId, record.bridgeSessionId);
		assert.strictEqual(bridge.notices[1].status, 'completed');
		assert.match(bridge.notices[1].summary, /SDK completed/);
		assert.strictEqual(client.created[0].session.disconnected, true);
		manager.dispose();
	});

	it('resumes the same SDK session for a later Teams reply and claims it', async () => {
		const { manager, client } = fixture();
		const record = await manager.start(request());

		const claimed = await manager.handleReply(routed(record, 'Now add tests'));
		await waitFor(() => client.resumed.length === 1, 'the resumed turn did not run');

		assert.strictEqual(claimed, true);
		assert.strictEqual(client.resumed.length, 1);
		assert.strictEqual(client.resumed[0].sessionId, record.sdkSessionId);
		assert.strictEqual(client.resumed[0].session.prompts[0].prompt, 'Now add tests');
		manager.dispose();
	});

	it('does not claim replies belonging to normal VS Code chat sessions', async () => {
		const { manager, client } = fixture();

		const claimed = await manager.handleReply({
			session: { id: 'another-session' } as never,
			reply: { id: 'reply-1', text: 'hello' } as never,
			text: 'hello'
		});

		assert.strictEqual(claimed, false);
		assert.strictEqual(client.started, 0);
		manager.dispose();
	});

	it('serializes concurrent replies for one SDK session', async () => {
		const { manager, bridge, client } = fixture();
		const record = await manager.start(request());
		let release: (() => void) | undefined;
		client.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});

		assert.strictEqual(await manager.handleReply(routed(record, 'first')), true);
		assert.strictEqual(await manager.handleReply(routed(record, 'second')), true);
		await waitFor(() => client.resumed.length === 1, 'the first queued reply did not start');
		assert.strictEqual(client.resumed.length, 1, 'the second reply must wait for the first turn');
		release?.();
		await waitFor(
			() => bridge.notices.filter((notice) => notice.status === 'completed').length === 3,
			'the second queued reply did not finish'
		);

		assert.strictEqual(client.resumed.length, 2);
		assert.strictEqual(client.maxActiveSends, 1);
		manager.dispose();
	});

	it('closes both mappings on a closing command without resuming the SDK', async () => {
		const { manager, bridge, client } = fixture();
		const record = await manager.start(request());

		assert.strictEqual(await manager.handleReply(routed(record, '/done', 'done')), true);

		assert.strictEqual(manager.records[0].closed, true);
		assert.deepStrictEqual(bridge.closed, [record.bridgeSessionId]);
		assert.strictEqual(client.resumed.length, 0);
		manager.dispose();
	});

	it('does not reopen a thread when an active turn finishes after it was closed', async () => {
		const { manager, bridge, client } = fixture();
		const record = await manager.start(request());
		let release: (() => void) | undefined;
		client.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await manager.handleReply(routed(record, 'keep working'));
		await waitFor(() => client.resumed.length === 1, 'the active reply did not start');
		const noticesBeforeClose = bridge.notices.length;

		await manager.handleReply(routed(record, '/stop', 'stop'));
		release?.();
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.strictEqual(manager.records[0].closed, true);
		assert.deepStrictEqual(bridge.closed, [record.bridgeSessionId]);
		assert.strictEqual(bridge.notices.length, noticesBeforeClose);
		manager.dispose();
	});

	it('does not execute prompts already queued when the session is closed', async () => {
		const { manager, client } = fixture();
		const record = await manager.start(request());
		let release: (() => void) | undefined;
		client.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await manager.handleReply(routed(record, 'first'));
		await manager.handleReply(routed(record, 'must not run'));
		await waitFor(() => client.resumed.length === 1, 'the first reply did not start');

		await manager.handleReply(routed(record, '/cancel', 'cancel'));
		release?.();
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.strictEqual(client.resumed.length, 1);
		assert.strictEqual(client.resumed[0].session.prompts[0].prompt, 'first');
		manager.dispose();
	});

	it('restores persisted mappings after manager recreation', async () => {
		const { manager, memento } = fixture();
		const record = await manager.start(request());
		manager.dispose();
		const bridge = new FakeBridge();
		const client = new FakeSdkClient();
		const restored = new SdkManagedSessions({
			memento,
			bridge: () => bridge as unknown as Bridge,
			log: { error: () => undefined, warn: () => undefined } as never,
			workspacePath: () => 'C:\\code\\project',
			runtimePath: () => 'copilot',
			createClient: () => client
		});

		assert.strictEqual(await restored.handleReply(routed(record, 'continue')), true);
		await waitFor(() => client.resumed.length === 1, 'the restored session did not resume');
		assert.strictEqual(client.resumed[0].sessionId, record.sdkSessionId);
		restored.dispose();
	});

	it('posts a failed outcome when the SDK returns no final assistant message', async () => {
		const { manager, bridge, client } = fixture();
		client.response = '';

		await manager.start(request());

		assert.strictEqual(bridge.notices.at(-1)?.status, 'failed');
		assert.match(bridge.notices.at(-1)?.summary ?? '', /without returning a final/);
		manager.dispose();
	});

	it('retires a mapping when the SDK session cannot be created', async () => {
		const { manager, bridge, client } = fixture();
		client.createSession = () => Promise.reject(new Error('runtime rejected the session'));

		const record = await manager.start(request());

		assert.strictEqual(manager.records[0].closed, true);
		assert.deepStrictEqual(bridge.closed, [record.bridgeSessionId]);
		assert.strictEqual(bridge.notices.at(-1)?.status, 'failed');
		assert.strictEqual(await manager.handleReply(routed(record, 'retry')), false);
		manager.dispose();
	});

	it('closes persisted SDK routes when the experimental mode is disabled', async () => {
		const { manager, bridge } = fixture();
		const record = await manager.start(request());

		await manager.disable();

		assert.strictEqual(manager.records[0].closed, true);
		assert.deepStrictEqual(bridge.closed, [record.bridgeSessionId]);
		assert.strictEqual(await manager.handleReply(routed(record, 'continue')), false);
		manager.dispose();
	});

	it('starts only one SDK client when restored sessions receive replies concurrently', async () => {
		const timestamp = new Date().toISOString();
		const records: SdkManagedSessionRecord[] = ['one', 'two'].map((id) => ({
			bridgeSessionId: `bridge-${id}`,
			bridgeSessionKey: `key-${id}`,
			sdkSessionId: `sdk-${id}`,
			title: id,
			workspace: 'C:\\code\\project',
			model: 'auto',
			agentMode: 'interactive',
			permissionMode: 'ask',
			createdAt: timestamp,
			lastActivityAt: timestamp
		}));
		const bridge = new FakeBridge();
		const memento = new MemoryMemento();
		await memento.update('copilotTeamsBridge.sdkManagedSessions', records);
		let createdClients = 0;
		let releaseStart: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const client = new FakeSdkClient();
		client.start = async () => {
			await startGate;
			client.started += 1;
		};
		const manager = new SdkManagedSessions({
			memento,
			bridge: () => bridge as unknown as Bridge,
			log: { error: () => undefined, warn: () => undefined } as never,
			workspacePath: () => 'C:\\code\\project',
			runtimePath: () => 'copilot',
			createClient: () => {
				createdClients += 1;
				return client;
			}
		});

		await Promise.all([
			manager.handleReply(routed(records[0], 'first')),
			manager.handleReply(routed(records[1], 'second'))
		]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.strictEqual(createdClients, 1);
		releaseStart?.();
		await waitFor(() => client.resumed.length === 2, 'both restored sessions did not resume');
		manager.dispose();
	});

	it('does not begin a turn closed while the SDK client is starting', async () => {
		const timestamp = new Date().toISOString();
		const record: SdkManagedSessionRecord = {
			bridgeSessionId: 'bridge-starting',
			bridgeSessionKey: 'key-starting',
			sdkSessionId: 'sdk-starting',
			title: 'starting',
			workspace: 'C:\\code\\project',
			model: 'auto',
			agentMode: 'autopilot',
			permissionMode: 'approve-all',
			createdAt: timestamp,
			lastActivityAt: timestamp
		};
		const { manager, client } = fixture([record]);
		let releaseStart: (() => void) | undefined;
		client.start = () => new Promise<void>((resolve) => {
			releaseStart = resolve;
		});

		await manager.handleReply(routed(record, 'must not execute'));
		await new Promise((resolve) => setTimeout(resolve, 5));
		await manager.handleReply(routed(record, '/stop', 'stop'));
		releaseStart?.();
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.strictEqual(client.resumed.length, 0);
		manager.dispose();
	});

	it('posts SDK user-input questions to Teams and continues with that thread reply', async () => {
		const bridge = new FakeBridge();
		const memento = new MemoryMemento();
		let receivedAnswer: string | undefined;
		const client = {
			start: () => Promise.resolve(),
			stop: () => Promise.resolve([]),
			listModels: () => Promise.resolve([]),
			createSession: async (config: SessionConfig) => ({
				sessionId: config.sessionId ?? 'created',
				onError: () => () => undefined,
				disconnect: () => Promise.resolve(),
				sendAndWait: async () => {
					assert.ok(config.onUserInputRequest);
					const answer = await config.onUserInputRequest({
						question: 'Which environment?',
						choices: ['PPE', 'PROD'],
						allowFreeform: true
					} as never, { sessionId: config.sessionId ?? 'created' });
					receivedAnswer = answer.answer;
					return { data: { content: `Using ${answer.answer}.` } };
				}
			}),
			resumeSession: () => Promise.reject(new Error('not expected'))
		};
		const manager = new SdkManagedSessions({
			memento,
			bridge: () => bridge as unknown as Bridge,
			log: { error: () => undefined, warn: () => undefined } as never,
			workspacePath: () => 'C:\\code\\project',
			runtimePath: () => 'copilot',
			createClient: () => client
		});

		const starting = manager.start(request());
		for (let attempt = 0; attempt < 20 && !bridge.notices.some((notice) => notice.status === 'needs-input'); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const record = manager.records[0];
		assert.ok(record, 'the mapping must be durable before Copilot asks for input');
		assert.match(bridge.notices.at(-1)?.question ?? '', /PPE · PROD/);

		assert.strictEqual(await manager.handleReply(routed(record, 'PPE')), true);
		await starting;

		assert.strictEqual(receivedAnswer, 'PPE');
		assert.match(bridge.notices.at(-1)?.summary ?? '', /Using PPE/);
		manager.dispose();
	});

	it('puts Auto first and omits models disabled by policy', () => {
		const items = modelItems([
			{ id: 'z-model', name: 'Zulu', policy: { state: 'enabled' } } as ModelInfo,
			{ id: 'blocked', name: 'Blocked', policy: { state: 'disabled' } } as ModelInfo,
			{ id: 'a-model', name: 'Alpha', policy: { state: 'enabled' } } as ModelInfo
		]);

		assert.deepStrictEqual(
			items.map((item) => item.model),
			['auto', 'a-model', 'z-model']
		);
	});

	it('resolves a bare runtime command through PATH before giving it to the SDK', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-sdk-path-'));
		const executable = path.join(directory, process.platform === 'win32' ? 'trial.exe' : 'trial');
		fs.writeFileSync(executable, '');
		const originalPath = process.env.PATH;
		try {
			process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`;
			assert.strictEqual(resolveRuntimePath('trial'), executable);
			assert.strictEqual(resolveRuntimePath(executable), executable);
		} finally {
			process.env.PATH = originalPath;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
