import type { Session } from '../types';

/**
 * Reconciling a session file that two processes write.
 *
 * The MCP server and the extension share one file: the server adds replies it collected,
 * the extension removes the ones it delivered. Each held its own copy in memory and wrote
 * the lot back, so the server kept restoring replies the extension had just delivered, and
 * the same instruction was injected into chat every few seconds for as long as the server
 * lived.
 *
 * An absence cannot be told from a value not yet seen, so a removal has to be recorded
 * rather than implied. Delivered ids are kept alongside the queue and both writers honour
 * them, which lets either process write a stale copy without undoing the other's work.
 */

/** Enough to outlast any queue; the ids are only needed until both writers agree. */
export const MAX_DELIVERED_IDS = 50;

/**
 * The same cap the Bridge applies to its in-memory list.
 *
 * Merging in sessions the writer never knew about means a bug in one writer, or a
 * long-lived stale process, could otherwise grow the file without bound. Re-applying the
 * cap keeps that impossible; the Bridge's own cap is unchanged so there is one rule.
 */
export const MAX_SESSIONS = 100;

/**
 * Reconciles what this process is about to write with what is already on disk.
 *
 * Two things happen:
 *
 * 1. Delivered-reply ids from disk are applied to sessions this process still holds, so a
 *    stale writer cannot bring back a reply the other process already delivered.
 * 2. Sessions present on disk but absent from `mine` are preserved.
 *
 * Each MCP server process boots with a snapshot of the file; sessions created after boot
 * by any other process — the extension, or a second server — are unknown to it. Returning
 * only `mine` therefore erased those sessions on the next write, leaving orphaned Teams
 * threads whose replies could never be routed back.
 *
 * The 100-session cap the Bridge applies in memory is re-applied here so a merge cannot
 * grow the file without bound. When the total exceeds the cap, the newest by
 * `lastActivityAt` are kept, which is the same "recent conversations win" rule the Bridge
 * uses to keep its own list small.
 */
export function mergeForWrite(mine: readonly Session[], onDisk: readonly Session[]): Session[] {
	const disk = new Map(onDisk.map((session) => [session.id, session]));
	const mineIds = new Set(mine.map((session) => session.id));

	const reconciled = mine.map((session) => {
		const other = disk.get(session.id);
		if (!other) {
			return session;
		}

		const delivered = lastUnique(
			[...(other.deliveredReplyIds ?? []), ...(session.deliveredReplyIds ?? [])],
			MAX_DELIVERED_IDS
		);
		if (delivered.length === 0) {
			return session;
		}

		const known = new Set(delivered);
		const pending = (session.pending ?? []).filter((held) => !known.has(held.reply.id));

		return {
			...session,
			deliveredReplyIds: delivered,
			pending: pending.length > 0 ? pending : undefined
		};
	});

	// Sessions only on disk are carried forward untouched: their pending queues and
	// delivered-id records belong to whichever process created them, so this writer must
	// not edit them, only refuse to delete them.
	const preserved = onDisk.filter((session) => !mineIds.has(session.id));

	const merged = [...reconciled, ...preserved];
	if (merged.length <= MAX_SESSIONS) {
		return merged;
	}
	// Newest by last activity, so an old idle thread cannot displace a live one.
	return [...merged]
		.sort((a, b) => activityTime(a) - activityTime(b))
		.slice(-MAX_SESSIONS);
}

function activityTime(session: Session): number {
	const value = Date.parse(session.lastActivityAt);
	return Number.isFinite(value) ? value : 0;
}

/** Records replies as delivered, so a stale writer cannot bring them back. */
export function markDelivered(session: Session, replyIds: readonly string[]): string[] {
	return lastUnique([...(session.deliveredReplyIds ?? []), ...replyIds], MAX_DELIVERED_IDS);
}

function lastUnique(values: readonly string[], limit: number): string[] {
	return [...new Set(values)].slice(-limit);
}
