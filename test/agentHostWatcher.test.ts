import * as assert from 'assert';
import { describe, it, before } from 'node:test';
import { confirmAgentHostTurn } from '../src/hosts/vscode/agentHostIndex';
import type { AgentHostSession } from '../src/hosts/vscode/agentHostSessions';
import type { SessionIdentity } from '../src/domain/types';

interface Watcher {
	start(): void;
	poll(): Promise<void>;
	dispose(): void;
}

let AgentHostWatcher: new (deps: Record<string, unknown>) => Watcher;

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);
	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode' ? {} : originalLoad(request, parent, isMain);
	const mod = require('../src/hosts/vscode/agentHostWatcher') as {
		AgentHostWatcher: new (deps: Record<string, unknown>) => Watcher;
	};
	AgentHostWatcher = mod.AgentHostWatcher;
	Module._load = originalLoad;
	/* eslint-enable @typescript-eslint/no-require-imports */
});

const logger = { info: (): void => undefined, warn: (): void => undefined, debug: (): void => undefined };

function session(overrides: Partial<AgentHostSession> = {}): AgentHostSession {
	return {
		resource: 'agent-host-copilotcli:/aaaaaaaa-0000-0000-0000-000000000001',
		label: 'A Copilot-mode chat',
		workingDirectoryPath: 'c:\\code\\CE-EA-ATC-Services',
		lastRequestStarted: 1_000,
		...overrides
	};
}

interface Harness {
	watcher: Watcher;
	announced: { sessionKey: string; title: string; identity: SessionIdentity }[];
	touched: string[];
	setSessions(list: AgentHostSession[]): void;
}

function build(initial: AgentHostSession[], options: { enabled?: boolean } = {}): Harness {
	let current = initial;
	const announced: { sessionKey: string; title: string; identity: SessionIdentity }[] = [];
	const touched: string[] = [];
	const watcher = new AgentHostWatcher({
		sessions: () => current,
		announce: async (request: { sessionKey: string; title: string; identity: SessionIdentity }) => {
			announced.push(request);
			return true;
		},
		touch: (key: string) => touched.push(key),
		enabled: () => options.enabled ?? true,
		intervalMs: () => 10_000,
		log: logger,
		// Timers are never armed, so polling stays under the test's control.
		setTimer: () => undefined,
		clearTimer: () => undefined
	});
	return { watcher, announced, touched, setSessions: (list) => (current = list) };
}

/**
 * Copilot-mode chats had no way of reaching Teams on their own.
 *
 * The transcript watcher matches `*.jsonl`, and this surface writes none, so the
 * deterministic "a chat started" signal could never fire for it: a session only appeared if
 * the agent inside chose to call the notify tool. A user working in Copilot mode therefore
 * saw nothing and could not tell whether the bridge was broken or simply unused.
 */
describe('announcing Copilot-mode sessions', () => {
	it('announces a session that appears after start-up', async () => {
		const harness = build([]);
		harness.watcher.start();

		harness.setSessions([session()]);
		await harness.watcher.poll();

		assert.strictEqual(harness.announced.length, 1);
		assert.strictEqual(harness.announced[0].title, 'A Copilot-mode chat');
		harness.watcher.dispose();
	});

	it('records the harness and the chat together, never one alone', async () => {
		// `vscode-agent-host` is on the deliverable list, so a record naming the harness
		// without a chat would tell the user "reply here" while routing had nothing to
		// steer to -- the exact shape of the agent-MCP regression.
		const harness = build([]);
		harness.watcher.start();
		harness.setSessions([session()]);
		await harness.watcher.poll();

		const identity = harness.announced[0].identity;
		assert.strictEqual(identity.harness, 'vscode-agent-host');
		assert.deepStrictEqual(identity.chat, {
			kind: 'chat-session-resource',
			value: 'agent-host-copilotcli:/aaaaaaaa-0000-0000-0000-000000000001'
		});
		assert.strictEqual(identity.confidence, 'exact');
		harness.watcher.dispose();
	});

	it('keys the session on its resource so a reply resolves without searching', async () => {
		const harness = build([]);
		harness.watcher.start();
		harness.setSessions([session()]);
		await harness.watcher.poll();

		assert.strictEqual(
			harness.announced[0].sessionKey,
			'agent-host-copilotcli:/aaaaaaaa-0000-0000-0000-000000000001'
		);
		harness.watcher.dispose();
	});

	it('does not announce the chats that already existed when it started', async () => {
		// The reload storm the transcript watcher guards against: without seeding, every
		// Copilot-mode chat in the workspace history would post a thread at once.
		const harness = build([session(), session({ resource: 'agent-host-copilotcli:/bbbb', label: 'Another' })]);
		harness.watcher.start();
		await harness.watcher.poll();

		assert.deepStrictEqual(harness.announced, []);
		harness.watcher.dispose();
	});

	it('announces each session once, however often it polls', async () => {
		const harness = build([]);
		harness.watcher.start();
		harness.setSessions([session()]);

		await harness.watcher.poll();
		await harness.watcher.poll();
		await harness.watcher.poll();

		assert.strictEqual(harness.announced.length, 1);
		harness.watcher.dispose();
	});

	it('ignores a tab that has never run a request', async () => {
		// An empty chat the user has not typed into yet. Announcing it would open a thread
		// for a session that may never exist, under a placeholder title.
		const harness = build([]);
		harness.watcher.start();
		harness.setSessions([session({ lastRequestStarted: undefined })]);
		await harness.watcher.poll();

		assert.deepStrictEqual(harness.announced, []);
		harness.watcher.dispose();
	});

	it('ignores archived sessions', async () => {
		const harness = build([]);
		harness.watcher.start();
		harness.setSessions([session({ archived: true })]);
		await harness.watcher.poll();

		assert.deepStrictEqual(harness.announced, []);
		harness.watcher.dispose();
	});

	it('stays silent while announcing is switched off', async () => {
		const harness = build([], { enabled: false });
		harness.watcher.start();
		harness.setSessions([session()]);
		await harness.watcher.poll();

		assert.deepStrictEqual(harness.announced, []);
		harness.watcher.dispose();
	});

	it('reports a new turn, but does not mistake a rewrite for one', async () => {
		// The index is rewritten wholesale, so an unchanged timing must not be read as
		// activity -- that would keep an abandoned session alive forever and defeat the
		// idle window entirely.
		const harness = build([]);
		harness.watcher.start();
		harness.setSessions([session({ lastRequestStarted: 1_000 })]);
		await harness.watcher.poll();
		assert.deepStrictEqual(harness.touched, [], 'the first sighting is not a new turn');

		await harness.watcher.poll();
		assert.deepStrictEqual(harness.touched, [], 'the same timing is a rewrite, not activity');

		harness.setSessions([session({ lastRequestStarted: 2_000 })]);
		await harness.watcher.poll();
		assert.deepStrictEqual(
			harness.touched,
			['agent-host-copilotcli:/aaaaaaaa-0000-0000-0000-000000000001'],
			'an advanced timing is a real turn'
		);
		harness.watcher.dispose();
	});

	it('keeps working when the index cannot be read', async () => {
		const watcher = new AgentHostWatcher({
			sessions: () => {
				throw new Error('database is locked');
			},
			announce: async () => true,
			enabled: () => true,
			intervalMs: () => 10_000,
			log: logger,
			setTimer: () => undefined,
			clearTimer: () => undefined
		});
		watcher.start();
		await watcher.poll();
		watcher.dispose();
	});
});

/**
 * The confirmation defect this fixes, from the live run on 2026-08-29.
 *
 * The reply was written into the correct chat at 12:07:23 -- the log shows it revealed,
 * focused and submitted, with the intended session's title in front -- and confirmation
 * still reported `unroutable` at 12:07:54, because `lastRequestStarted` had not moved.
 * Inspection afterwards found the session absent from the index entirely: VS Code rewrites
 * it lazily and wholesale, so it is not a per-request signal.
 */
describe('confirming into a Copilot-mode chat', () => {
	const resource = 'agent-host-copilotcli:/aaaaaaaa-0000-0000-0000-000000000001';

	it('confirms from the title of the tab in front', async () => {
		const ok = await confirmAgentHostTurn({
			resource,
			writtenAt: 5_000,
			ceilingMs: 50,
			pollMs: 10,
			now: () => 0,
			sleep: async () => undefined,
			// Deliberately stale, as it was in the live failure.
			sessions: () => [session({ resource, lastRequestStarted: 1_000 })],
			activeTabLabel: () => 'A Copilot-mode chat'
		});
		assert.strictEqual(ok, true, 'the intended chat is in front, so the write reached it');
	});

	it('is not satisfied by some other chat being in front', async () => {
		// The distinction that matters: "a chat is in front" was already proved worthless,
		// because a chat tab carries no session id. Comparing the title to the session we
		// resolved is a statement about *which* conversation.
		let clock = 0;
		const ok = await confirmAgentHostTurn({
			resource,
			writtenAt: 5_000,
			ceilingMs: 50,
			pollMs: 10,
			now: () => (clock += 30),
			sleep: async () => undefined,
			sessions: () => [session({ resource, lastRequestStarted: 1_000 })],
			activeTabLabel: () => 'Some unrelated chat'
		});
		assert.strictEqual(ok, false);
	});

	it('still confirms from the request timing when the tab is not in front', async () => {
		const ok = await confirmAgentHostTurn({
			resource,
			writtenAt: 5_000,
			ceilingMs: 50,
			pollMs: 10,
			now: () => 0,
			sleep: async () => undefined,
			sessions: () => [session({ resource, lastRequestStarted: 6_000 })],
			activeTabLabel: () => undefined
		});
		assert.strictEqual(ok, true);
	});

	it('fails when neither signal says the reply landed', async () => {
		let clock = 0;
		const ok = await confirmAgentHostTurn({
			resource,
			writtenAt: 5_000,
			ceilingMs: 50,
			pollMs: 10,
			now: () => (clock += 30),
			sleep: async () => undefined,
			sessions: () => [session({ resource, lastRequestStarted: 1_000 })],
			activeTabLabel: () => undefined
		});
		assert.strictEqual(ok, false);
	});
});
