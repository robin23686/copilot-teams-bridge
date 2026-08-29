import * as assert from 'assert';
import { describe, it, before } from 'node:test';
import type { DeliverableReply, DeliveryOutcome, HarnessAdapter } from '../src/application/services/harness';
import { deliveryMarker } from '../src/domain/messageFormat';
import type { Session, SessionIdentity } from '../src/domain/types';

// The adapter imports `vscode` for its LogOutputChannel type, which only exists inside an
// extension host. Patched exactly as sidebarAdapterRegression.test.ts does, so the real
// class is exercised rather than a stand-in that could not reproduce its behaviour.
let CliRuntimeAdapter: new (deps: unknown) => HarnessAdapter;

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);
	const vscodeMock: Record<string, unknown> = {};
	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode' ? vscodeMock : originalLoad(request, parent, isMain);
	const mod = require('../src/hosts/vscode/adapters/cliRuntimeAdapter') as {
		CliRuntimeAdapter: new (deps: unknown) => HarnessAdapter;
	};
	CliRuntimeAdapter = mod.CliRuntimeAdapter;
	/* eslint-enable @typescript-eslint/no-require-imports */
});

const CLI_ID = 'a9e68183-1fcb-49ab-a252-edbadc5403f4';

const logger = {
	info: (): void => undefined,
	warn: (): void => undefined,
	error: (): void => undefined,
	appendLine: (): void => undefined
};

function identity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
	return {
		harness: 'cli-runtime',
		confidence: 'exact',
		capturedBy: 'mcp-ingest',
		capturedAt: '2026-08-29T10:00:00.000Z',
		cliSessionId: CLI_ID,
		...overrides
	};
}

function deliverable(): DeliverableReply {
	const session: Session = {
		id: 's-cli',
		key: 'cli-task',
		title: 'A CLI task',
		createdAt: '2026-08-29T09:00:00Z',
		lastActivityAt: '2026-08-29T09:00:00Z',
		seenReplyIds: [],
		status: 'progress'
	};
	return {
		session,
		reply: {
			id: 'r-1',
			threadId: 't-1',
			text: 'carry on',
			from: 'Ada Lovelace',
			createdAt: '2026-08-29T10:05:00Z'
		},
		text: 'carry on'
	};
}

interface Harness {
	adapter: HarnessAdapter;
	runs: { args: readonly string[]; timeoutMs: number }[];
	reported: string[];
}

function build(
	overrides: {
		enabled?: boolean;
		result?: { code: number | null; stdout: string; stderr: string };
		runThrows?: Error;
		reportThrows?: Error;
	} = {}
): Harness {
	const runs: { args: readonly string[]; timeoutMs: number }[] = [];
	const reported: string[] = [];
	const adapter = new CliRuntimeAdapter({
		enabled: () => overrides.enabled ?? true,
		timeoutMs: () => 900_000,
		run: async (args: readonly string[], options: { timeoutMs: number }) => {
			runs.push({ args, timeoutMs: options.timeoutMs });
			if (overrides.runThrows) {
				throw overrides.runThrows;
			}
			return overrides.result ?? { code: 0, stdout: 'done that', stderr: '' };
		},
		report: async (_session: Session, text: string) => {
			if (overrides.reportThrows) {
				throw overrides.reportThrows;
			}
			reported.push(text);
		},
		log: logger
	});
	return { adapter, runs, reported };
}

describe('resuming a Copilot CLI session to deliver a reply', () => {
	it('refuses every session while the setting is off', () => {
		const { adapter } = build({ enabled: false });
		assert.strictEqual(adapter.canDeliver(identity()), false);
	});

	it('refuses a session with no recorded id even when switched on', () => {
		const { adapter } = build();
		assert.strictEqual(adapter.canDeliver(identity({ cliSessionId: undefined })), false);
	});

	it('refuses a harness it does not serve', () => {
		const { adapter } = build();
		for (const harness of ['vscode-sidebar', 'vscode-agent-mcp', 'external', 'unknown'] as const) {
			assert.strictEqual(adapter.canDeliver(identity({ harness })), false, harness);
		}
	});

	it('accepts only an opted-in CLI session that knows its id', () => {
		const { adapter } = build();
		assert.strictEqual(adapter.canDeliver(identity()), true);
	});

	it('resumes the recorded session and reports the answer back to Teams', async () => {
		const { adapter, runs, reported } = build();
		const outcome: DeliveryOutcome = await adapter.deliver(deliverable(), identity());

		assert.strictEqual(outcome, 'delivered');
		assert.strictEqual(runs.length, 1);

		const args = runs[0].args;
		assert.deepStrictEqual(
			[args[0], args[1]],
			['--session-id', CLI_ID],
			'must resume the recorded session, never start a new one'
		);
		assert.ok(args.includes('--no-ask-user'), 'nobody is at a terminal to answer a question');
		assert.ok(args.includes('-p'), 'must run non-interactively');

		// The prompt has to carry the same marker the chat route uses, or a resumed turn is
		// indistinguishable from something the user typed themselves.
		const prompt = args[args.length - 1];
		assert.ok(
			prompt.startsWith(deliveryMarker('A CLI task', 'Ada Lovelace')),
			`prompt must be marked, got: ${prompt}`
		);
		assert.ok(prompt.includes('carry on'));

		assert.deepStrictEqual(reported, ['done that'], 'the answer must come back to the thread');
	});

	it('passes the instruction as one argument, never through a shell', async () => {
		const { adapter, runs } = build();
		const hostile = deliverable();
		hostile.text = 'ok"; whoami; echo "';

		await adapter.deliver(hostile, identity());

		const args = runs[0].args;
		assert.strictEqual(
			args.filter((a) => a.includes('whoami')).length,
			1,
			'the text must remain a single argument rather than being split into commands'
		);
		assert.ok(args[args.length - 1].includes('ok"; whoami; echo "'), 'and must survive intact');
	});

	it('reports a failure when the CLI exits non-zero, so the reply can be retried', async () => {
		const { adapter, reported } = build({ result: { code: 1, stdout: '', stderr: 'boom' } });
		assert.strictEqual(await adapter.deliver(deliverable(), identity()), 'failed');
		assert.deepStrictEqual(reported, [], 'nothing ran, so there is nothing to report');
	});

	it('reports a failure when the CLI cannot be started at all', async () => {
		const { adapter } = build({ runThrows: new Error('ENOENT') });
		assert.strictEqual(await adapter.deliver(deliverable(), identity()), 'failed');
	});

	it('still counts as delivered when the run succeeded but the answer could not be posted', async () => {
		// The instruction has already been acted on. Calling this a failure would retry the
		// run and do the work twice, which is worse than a missing status message.
		const { adapter } = build({ reportThrows: new Error('Teams unreachable') });
		assert.strictEqual(await adapter.deliver(deliverable(), identity()), 'delivered');
	});

	it('says something in the thread even when the run printed nothing', async () => {
		const { adapter, reported } = build({ result: { code: 0, stdout: '   \n', stderr: '' } });
		await adapter.deliver(deliverable(), identity());
		assert.strictEqual(reported.length, 1);
		assert.ok(reported[0].length > 0, 'silence would be indistinguishable from the reply being ignored');
	});

	it('retains rather than fails when asked to deliver without an id', async () => {
		// Reaching deliver() without an id means the registry chose the wrong adapter.
		// Retaining keeps the reply recoverable; failing would eventually discard it.
		const { adapter, runs } = build();
		const outcome = await adapter.deliver(deliverable(), identity({ cliSessionId: undefined }));
		assert.strictEqual(outcome, 'unroutable');
		assert.strictEqual(runs.length, 0, 'must not spawn anything it cannot target');
	});
});
