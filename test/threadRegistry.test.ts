import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, before, after } from 'node:test';
import { useTempHome } from './support/tempHome';

// Defensive: every registry below is constructed with an explicit file path, but pointing
// COPILOT_TEAMS_BRIDGE_HOME at a scratch directory means any accidental default-path
// construction cannot touch ~/.copilot-teams-bridge/threads.json.
const tempHome = useTempHome('ctb-threads-home-');

import { Bridge } from '../src/application/bridge';
import { InMemorySessionStore } from '../src/application/ports';
import { JsonThreadRegistry } from '../src/infrastructure/threadRegistry';
import type { InboundReply, OutboundNotification, PostResult, ThreadRef } from '../src/domain/types';

/**
 * One Teams thread per task, across processes.
 *
 * The extension and the MCP server keep separate session stores — a VS Code memento and a
 * JSON file — and neither can read the other's. Left alone, both call `createThread` for the
 * same session key and the user gets two Teams threads for one task, with updates and
 * replies split between them. That happened live.
 */

let tempDir: string;

/** Stands in for Teams, counting how many threads were opened. */
class CountingTransport {
	readonly kind = 'file' as const;
	readonly supportsReplies = true;
	created: OutboundNotification[] = [];
	posted: { thread: ThreadRef; notification: OutboundNotification }[] = [];
	private next = 1;

	async createThread(notification: OutboundNotification): Promise<PostResult> {
		this.created.push(notification);
		return { thread: { id: `thread-${this.next++}` }, postedMessageId: `m-${this.next}` };
	}

	async postToThread(thread: ThreadRef, notification: OutboundNotification): Promise<PostResult> {
		this.posted.push({ thread, notification });
		return { thread, postedMessageId: `m-${this.next++}` };
	}

	async fetchReplies(): Promise<InboundReply[]> {
		return [];
	}
}

function bridgeFor(transport: CountingTransport, registryFile: string): Bridge {
	return new Bridge({
		transport,
		store: new InMemorySessionStore(),
		threadRegistry: new JsonThreadRegistry(registryFile)
	});
}

describe('one Teams thread per session key', () => {
	before(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-threads-'));
	});

	after(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempHome.cleanup();
	});

	// The live failure: notifying with a key the extension had already opened a thread for
	// created a second one, because the MCP server could not see the extension's memento.
	it('reuses a thread opened by another process for the same key', async () => {
		const registry = path.join(tempDir, 'reuse.json');
		const first = new CountingTransport();
		const second = new CountingTransport();

		await bridgeFor(first, registry).notify({
			sessionKey: 'chat-abc',
			title: 'Task',
			summary: 's',
			status: 'progress'
		});
		// A different process, with its own empty session store.
		await bridgeFor(second, registry).notify({
			sessionKey: 'chat-abc',
			title: 'Task',
			summary: 'more',
			status: 'progress'
		});

		assert.strictEqual(first.created.length, 1, 'the first caller opens the thread');
		assert.deepStrictEqual(second.created, [], 'the second must not open another');
		assert.strictEqual(second.posted.length, 1, 'it must post into the existing one');
		assert.strictEqual(second.posted[0].thread.id, 'thread-1', 'and it must be the same thread');
	});

	// The negative control for the test above: without the shared claim this is exactly the
	// duplicate the user saw, so the assertion is not passing by accident.
	it('opens a second thread when the claim is not shared', async () => {
		const first = new CountingTransport();
		const second = new CountingTransport();

		await new Bridge({ transport: first, store: new InMemorySessionStore() }).notify({
			sessionKey: 'chat-abc',
			title: 'Task',
			summary: 's',
			status: 'progress'
		});
		await new Bridge({ transport: second, store: new InMemorySessionStore() }).notify({
			sessionKey: 'chat-abc',
			title: 'Task',
			summary: 'more',
			status: 'progress'
		});

		assert.strictEqual(second.created.length, 1, 'unshared stores duplicate, which is the bug');
	});

	// Different tasks must stay apart, or the fix would collapse every session into one
	// thread — worse than the duplicate it replaces.
	it('keeps different keys on different threads', async () => {
		const registry = path.join(tempDir, 'distinct.json');
		const transport = new CountingTransport();
		const bridge = bridgeFor(transport, registry);

		await bridge.notify({ sessionKey: 'chat-one', title: 'One', summary: 's', status: 'progress' });
		await bridge.notify({ sessionKey: 'chat-two', title: 'Two', summary: 's', status: 'progress' });

		assert.strictEqual(transport.created.length, 2, 'two tasks means two threads');
	});

	// A registry that cannot be read must not block the notification the user is waiting on.
	it('still notifies when the registry file is unreadable', async () => {
		const registry = path.join(tempDir, 'broken.json');
		fs.writeFileSync(registry, 'not json at all');
		const transport = new CountingTransport();

		await bridgeFor(transport, registry).notify({
			sessionKey: 'chat-broken',
			title: 'Broken',
			summary: 's',
			status: 'progress'
		});

		assert.strictEqual(transport.created.length, 1, 'a bad registry degrades, it does not fail');
	});

	// Threads opened before the shared claim existed must be published to it, or every
	// task already under way keeps duplicating.
	it('publishes threads it already knew about', async () => {
		const registry = path.join(tempDir, 'seeded.json');
		const before = new CountingTransport();
		const established = bridgeFor(before, registry);
		await established.notify({ sessionKey: 'chat-old', title: 'Old', summary: 's', status: 'progress' });

		// The claim is wiped, standing in for a thread opened by an older build.
		fs.rmSync(registry, { force: true });
		established.publishThreads();

		const other = new CountingTransport();
		await bridgeFor(other, registry).notify({
			sessionKey: 'chat-old',
			title: 'Old',
			summary: 'again',
			status: 'progress'
		});

		assert.deepStrictEqual(other.created, [], 'a republished thread must be reused');
		assert.strictEqual(other.posted[0]?.thread.id, 'thread-1');
	});
});
