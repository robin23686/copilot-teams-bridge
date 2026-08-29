import * as assert from 'assert';
import { describe, it } from 'node:test';

import { HoldAdapter } from '../src/hosts/vscode/adapters/holdAdapter';
import type { DeliverableReply } from '../src/application/services/harness';
import type { SessionIdentity } from '../src/domain/types';

/**
 * A retained reply is retried on every poll. Before this fix the hold explanation was
 * logged as a warning every single time — a flood of identical failure notices that
 * buried every other log line and made the user believe the bridge was on fire when in
 * fact nothing had changed. The message needs to be made once, at the level a user is
 * meant to notice, then quieted to debug for the same id.
 */
describe('HoldAdapter warning cadence', () => {
	function deliverable(replyId: string): DeliverableReply {
		return {
			session: {
				id: 's1',
				key: 'k',
				title: 'Held session',
				createdAt: '2026-01-01T00:00:00Z',
				lastActivityAt: '2026-01-01T00:00:00Z',
				seenReplyIds: [],
				status: 'progress'
			},
			reply: {
				id: replyId,
				threadId: 't',
				text: 'anything',
				from: 'Rob',
				createdAt: '2026-01-01T00:00:00Z'
			},
			text: 'anything'
		};
	}

	const identity: SessionIdentity = {
		harness: 'unknown',
		confidence: 'unknown',
		capturedBy: 'resolver',
		capturedAt: '2026-01-01T00:00:00Z'
	};

	it('warns once per reply id across repeated attempts', async () => {
		const warns: string[] = [];
		const debugs: string[] = [];
		const adapter = new HoldAdapter({
			log: {
				warn: (message: string) => warns.push(message),
				debug: (message: string) => debugs.push(message),
				info: () => undefined,
				error: () => undefined
			} as never
		});

		const outcome1 = await adapter.deliver(deliverable('reply-1'), identity);
		const outcome2 = await adapter.deliver(deliverable('reply-1'), identity);
		const outcome3 = await adapter.deliver(deliverable('reply-1'), identity);

		assert.deepStrictEqual([outcome1, outcome2, outcome3], ['unroutable', 'unroutable', 'unroutable']);
		assert.strictEqual(warns.length, 1, 'the same hold must warn exactly once');
		assert.strictEqual(debugs.length, 2, 'the repeats should log at debug so the outcome stays traceable');
		assert.match(warns[0], /Held session/);
	});

	// A distinct reply legitimately deserves its own warning: it is a new instruction the
	// user has never been told about.
	it('warns again for a different reply id', async () => {
		const warns: string[] = [];
		const adapter = new HoldAdapter({
			log: {
				warn: (message: string) => warns.push(message),
				debug: () => undefined,
				info: () => undefined,
				error: () => undefined
			} as never
		});

		await adapter.deliver(deliverable('reply-A'), identity);
		await adapter.deliver(deliverable('reply-B'), identity);

		assert.strictEqual(warns.length, 2);
	});
});
