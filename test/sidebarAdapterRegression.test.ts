import * as assert from 'assert';
import { describe, it, before } from 'node:test';
import type {
	DeliverableReply,
	DeliveryOutcome,
	HarnessAdapter
} from '../src/application/services/harness';
import { HarnessRegistry, deliverableHarnesses } from '../src/application/services/harness';
import type { Session, SessionIdentity } from '../src/domain/types';

// The sidebar adapter imports `vscode` at module scope for its LogOutputChannel type. That
// module only exists inside a real extension host, so the loader is patched before the
// adapter is required, exactly like extensionActivation.test.ts does it. Loading the real
// class is the whole point: a stub that already declares `serves` correctly could never
// have failed on the pre-fix code, and this suite must.
let SidebarAdapter: new (deps: unknown) => HarnessAdapter;

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);
	const vscodeMock: Record<string, unknown> = {
		// Only the type surface is touched, so an empty object is enough; nothing at runtime
		// reaches for a member here.
	};
	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode' ? vscodeMock : originalLoad(request, parent, isMain);
	const mod = require('../src/hosts/vscode/adapters/sidebarAdapter') as {
		SidebarAdapter: new (deps: unknown) => HarnessAdapter;
	};
	SidebarAdapter = mod.SidebarAdapter;
	/* eslint-enable @typescript-eslint/no-require-imports */
});

function sessionWith(extra: Partial<Session> = {}): Session {
	return {
		id: 's-agent-mcp',
		key: 'agent-mcp-task',
		title: 'An agent-MCP session',
		createdAt: '2026-08-29T09:00:00Z',
		lastActivityAt: '2026-08-29T09:00:00Z',
		seenReplyIds: [],
		status: 'progress',
		...extra
	};
}

function identity(extra: Partial<SessionIdentity> = {}): SessionIdentity {
	return {
		harness: 'vscode-agent-mcp',
		chat: { kind: 'chat-session-resource', value: 'vscode-chat-session://local/agent-abc' },
		confidence: 'exact',
		capturedBy: 'notify-tool',
		capturedAt: '2026-08-29T09:00:00Z',
		...extra
	};
}

class RecordingInjector {
	readonly calls: DeliverableReply[] = [];
	async inject(deliverable: DeliverableReply): Promise<DeliveryOutcome> {
		this.calls.push(deliverable);
		return 'delivered';
	}
}

class HoldStub implements HarnessAdapter {
	readonly harness = 'unknown' as const;
	held = 0;
	canDeliver(): boolean {
		return false;
	}
	async deliver(): Promise<DeliveryOutcome> {
		this.held++;
		return 'unroutable';
	}
}

function buildAdapter(injector: RecordingInjector): HarnessAdapter {
	// Only the two members SidebarAdapter reaches for at runtime are needed. The log
	// output channel is unused on the happy path -- delivery goes straight through to
	// the injector -- so a no-op is enough.
	return new SidebarAdapter({
		injector,
		mayAutoSubmit: () => true,
		log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
	});
}

/**
 * End-to-end regression tests for the log line
 *
 *   Holding the Teams reply: harness "vscode-agent-mcp" (confidence "exact") cannot be
 *   delivered into from this window
 *
 * appearing after the chat had already been resolved. The registry looked up the harness
 * strictly, only "vscode-sidebar" was registered, so every agent-MCP session was held and
 * retried every ten seconds forever. These assertions must fail on the pre-fix code and
 * pass with the adapter claiming both harnesses through `serves`.
 */
describe('SidebarAdapter serves agent-MCP sessions (regression)', () => {
	function replyFor(session: Session): DeliverableReply {
		return {
			session,
			reply: {
				id: 'reply-1',
				threadId: 'thread-1',
				text: 'go ahead',
				from: 'user@example.com',
				createdAt: '2026-08-29T09:01:00Z'
			},
			text: 'go ahead'
		};
	}

	it('delivers when the agent-MCP session has an exact chat resource', async () => {
		const injector = new RecordingInjector();
		const hold = new HoldStub();
		const adapter = buildAdapter(injector);
		const registry = new HarnessRegistry(hold).register(adapter);

		const id = identity({ confidence: 'exact' });
		const chosen = registry.adapterFor(id);
		assert.notStrictEqual(chosen, hold, 'exact agent-MCP must not be routed to the hold adapter');

		const outcome = await chosen.deliver(replyFor(sessionWith()), id);
		assert.strictEqual(outcome, 'delivered');
		assert.strictEqual(injector.calls.length, 1);
		assert.strictEqual(hold.held, 0);
	});

	it('delivers when the agent-MCP chat was derived rather than handed over', async () => {
		const injector = new RecordingInjector();
		const hold = new HoldStub();
		const registry = new HarnessRegistry(hold).register(buildAdapter(injector));

		const id = identity({ confidence: 'derived' });
		const chosen = registry.adapterFor(id);
		assert.notStrictEqual(chosen, hold);

		assert.strictEqual(await chosen.deliver(replyFor(sessionWith()), id), 'delivered');
		assert.strictEqual(injector.calls.length, 1);
	});

	it('still delivers a plain sidebar session (unchanged behaviour)', async () => {
		const injector = new RecordingInjector();
		const hold = new HoldStub();
		const registry = new HarnessRegistry(hold).register(buildAdapter(injector));

		const id = identity({ harness: 'vscode-sidebar' });
		const chosen = registry.adapterFor(id);
		assert.notStrictEqual(chosen, hold);
		assert.strictEqual(await chosen.deliver(replyFor(sessionWith()), id), 'delivered');
	});

	it('still holds a CLI-runtime session because no adapter can reach it', () => {
		const injector = new RecordingInjector();
		const hold = new HoldStub();
		const registry = new HarnessRegistry(hold).register(buildAdapter(injector));

		const cli = identity({ harness: 'cli-runtime' });
		assert.strictEqual(registry.adapterFor(cli), hold, 'cli-runtime must remain held');
	});

	it('still holds a session whose confidence is unknown', () => {
		const injector = new RecordingInjector();
		const hold = new HoldStub();
		const registry = new HarnessRegistry(hold).register(buildAdapter(injector));

		assert.strictEqual(
			registry.adapterFor(identity({ confidence: 'unknown', chat: undefined })),
			hold
		);
	});

	it('still holds a session with no chat resource', () => {
		const injector = new RecordingInjector();
		const hold = new HoldStub();
		const registry = new HarnessRegistry(hold).register(buildAdapter(injector));

		assert.strictEqual(registry.adapterFor(identity({ chat: undefined })), hold);
	});

	// The invariant that would have caught the original regression against the real
	// adapter wiring, not just a stub. If a harness is declared deliverable in policy,
	// the registry must actually contain an adapter that claims it -- otherwise the
	// reachability check tells the user "reply here" while routing silently refuses.
	it('has the real SidebarAdapter cover every harness declared deliverable', () => {
		const injector = new RecordingInjector();
		const hold = new HoldStub();
		const registry = new HarnessRegistry(hold).register(buildAdapter(injector));
		const served = registry.servedHarnesses();
		for (const harness of deliverableHarnesses) {
			assert.ok(
				served.has(harness),
				`${harness} is declared deliverable but no registered adapter serves it`
			);
		}
	});
});
