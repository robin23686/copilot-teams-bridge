import * as assert from 'assert';
import { describe, it } from 'node:test';
import { markDelivered, mergeForWrite, MAX_SESSIONS } from '../src/domain/policies/sessionMerge';
import type { PendingReply, Session } from '../src/domain/types';

/**
 * The MCP server and the extension share one session file: the server queues replies it
 * collected, the extension empties the queue as it delivers them. Each wrote its own copy
 * back wholesale, so the server kept restoring delivered replies and the same instruction
 * was injected into chat every few seconds until the server was killed.
 */
describe('reconciling a shared session file', () => {
	it('does not restore a reply the other process delivered', () => {
		// What the server still believes: the reply is queued, because it never learned.
		const stale = [session({ pending: [held('r1')] })];
		// What is on disk: delivered and recorded as such.
		const disk = [session({ deliveredReplyIds: ['r1'] })];

		const merged = mergeForWrite(stale, disk);

		assert.strictEqual(merged[0].pending, undefined, 'a delivered reply must not come back');
	});

	it('keeps a reply that has not been delivered', () => {
		const stale = [session({ pending: [held('r1'), held('r2')] })];
		const disk = [session({ deliveredReplyIds: ['r1'] })];

		const merged = mergeForWrite(stale, disk);

		assert.deepStrictEqual(
			(merged[0].pending ?? []).map((p) => p.reply.id),
			['r2'],
			'only the delivered reply should be dropped'
		);
	});

	it('carries the record forward so a later write still honours it', () => {
		const disk = [session({ deliveredReplyIds: ['r1'] })];

		const merged = mergeForWrite([session({ pending: [held('r1')] })], disk);

		assert.deepStrictEqual(merged[0].deliveredReplyIds, ['r1']);
	});

	it('leaves a session the other process has never seen alone', () => {
		const mine = [session({ id: 'new', pending: [held('r9')] })];

		const merged = mergeForWrite(mine, []);

		assert.strictEqual((merged[0].pending ?? []).length, 1);
	});

	it('records without duplicating or growing without bound', () => {
		const many = Array.from({ length: 60 }, (_, i) => `r${i}`);
		const ids = markDelivered(session({ deliveredReplyIds: ['r1'] }), [...many, 'r1']);

		assert.strictEqual(ids.length, 50, 'the record is bounded');
		assert.strictEqual(new Set(ids).size, ids.length, 'and holds no duplicates');
	});

	it('preserves a session only on disk that this writer never knew about', () => {
		// The extension created "b" after this server booted, so it never appeared in
		// `mine`. Returning only mine would delete it and orphan its Teams thread.
		const mine = [session({ id: 'a' })];
		const disk = [
			session({ id: 'a' }),
			session({ id: 'b', pending: [held('r9')], deliveredReplyIds: ['r0'] })
		];

		const merged = mergeForWrite(mine, disk);

		const b = merged.find((s) => s.id === 'b');
		assert.ok(b, 'a session only on disk must survive');
		assert.deepStrictEqual((b.pending ?? []).map((p) => p.reply.id), ['r9'], 'its pending queue is preserved');
		assert.deepStrictEqual(b.deliveredReplyIds, ['r0'], 'its delivered-id record is preserved');
	});

	it('still reconciles delivered ids for sessions present in both', () => {
		// Regression: preserving disk-only sessions must not skip the existing
		// delivered-id reconciliation for sessions we do know about.
		const mine = [session({ id: 'a', pending: [held('r1')] })];
		const disk = [
			session({ id: 'a', deliveredReplyIds: ['r1'] }),
			session({ id: 'b' })
		];

		const merged = mergeForWrite(mine, disk);

		const a = merged.find((s) => s.id === 'a');
		assert.ok(a);
		assert.strictEqual(a.pending, undefined, 'a delivered reply must not come back');
		assert.deepStrictEqual(a.deliveredReplyIds, ['r1']);
		assert.ok(merged.find((s) => s.id === 'b'), 'the disk-only session is still preserved');
	});

	it('caps the merged list at 100, keeping the newest by last activity', () => {
		const t = (offsetMinutes: number): string =>
			new Date(Date.UTC(2026, 0, 1, 0, offsetMinutes, 0)).toISOString();

		// 80 known here (older activity) + 40 disk-only (newer) = 120; the 20 oldest go.
		const mine = Array.from({ length: 80 }, (_, i) =>
			session({ id: `m${i}`, lastActivityAt: t(i) })
		);
		const disk = [
			...mine.map((s) => session({ id: s.id, lastActivityAt: s.lastActivityAt })),
			...Array.from({ length: 40 }, (_, i) =>
				session({ id: `d${i}`, lastActivityAt: t(200 + i) })
			)
		];

		const merged = mergeForWrite(mine, disk);

		assert.strictEqual(merged.length, MAX_SESSIONS, 'the merged list is capped');
		assert.ok(
			merged.every((s) => s.id.startsWith('d') || Number(s.id.slice(1)) >= 20),
			'the newest by last activity are kept'
		);
		assert.ok(
			merged.some((s) => s.id === 'd39'),
			'the very newest disk-only session must survive the cap'
		);
	});
});

function session(over: Partial<Session> = {}): Session {
	return {
		id: 's1',
		key: 'k',
		title: 'A task',
		createdAt: '2026-01-01T00:00:00.000Z',
		lastActivityAt: '2026-01-01T00:00:00.000Z',
		seenReplyIds: [],
		...over
	} as Session;
}

function held(id: string): PendingReply {
	return {
		reply: { id, threadId: 't1', text: 'hello', from: 'Rob', createdAt: '2026-01-01T00:00:00.000Z' },
		text: 'hello'
	} as PendingReply;
}
