import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The default file used by both processes to claim inbound Teams reply ids.
 *
 * Sits beside the shared thread registry and the posted-message registry, so an operator
 * overriding `COPILOT_TEAMS_BRIDGE_HOME` moves the whole set together.
 */
export function defaultDeliveredRepliesPath(): string {
	const home = process.env.COPILOT_TEAMS_BRIDGE_HOME ?? path.join(os.homedir(), '.copilot-teams-bridge');
	return path.join(home, 'delivered.json');
}

/** Bounded because the file is read on every reply — only the newest ids are kept. */
const MAX_ENTRIES = 1_000;

/**
 * A cross-process record of Teams reply ids the bridge has already handed to a chat.
 *
 * The extension and the MCP server keep their own session stores, and each polls its
 * threads. Once a shared thread registry made them share the *same* Teams thread per
 * session key, both processes ended up reading the same reply into two different `Session`
 * records — the reply id lands in each store's `seenReplyIds`, neither store can see the
 * other's, and both hand the reply to chat. The user's one instruction is injected twice.
 *
 * Per-store de-duplication is fundamentally the wrong scope for this: the identity that
 * has to be unique is the transport reply id, which is authoritative across every process
 * that talks to the same Teams channel. That identity lives here.
 *
 * Modelled on {@link JsonPostedMessagesRegistry}: read-merge-write on every claim so
 * concurrent writers cannot clobber each other, capped so a long-running install cannot
 * grow the file without limit, and tolerant of a missing or corrupt file — the worst-case
 * degradation is losing the cross-process guarantee for one reply, which is far better
 * than blocking every delivery.
 */
export interface DeliveredRepliesRegistry {
	/**
	 * Atomically claims a reply id for delivery.
	 *
	 * Returns true for the first caller that claims a given id, so exactly one delivery
	 * path acts on it. Every later caller — in any process sharing the file — receives
	 * false and must consume/release the reply without injecting and without posting a
	 * user-facing failure notice: the other path handled it.
	 *
	 * Safe to call with an empty or undefined id; treated as an already-claimed reply
	 * (returns false), because nothing sensible can be done with an id-less message.
	 */
	claim(replyId: string | undefined): boolean;
	/**
	 * Undoes a claim.
	 *
	 * Called when delivery did not actually happen — the harness could not deliver
	 * (`unroutable`) or the attempt failed transiently (`failed`) — so that a later poll
	 * from either process can retry. Without this the reply would be tombstoned by an
	 * attempt that never touched the chat, and a legitimate retry would find the claim
	 * already taken and drop it as "handled elsewhere".
	 */
	release(replyId: string | undefined): void;
	/** True when this id was already claimed by *this* bridge (either process). */
	has(replyId: string): boolean;
}

export class JsonDeliveredRepliesRegistry implements DeliveredRepliesRegistry {
	constructor(private readonly file: string = defaultDeliveredRepliesPath()) {}

	has(replyId: string): boolean {
		if (!replyId) {
			return false;
		}
		return this.read().includes(replyId);
	}

	claim(replyId: string | undefined): boolean {
		if (!replyId) {
			// Nothing to key on, so refuse to claim — the caller has to be prepared to be
			// second in this branch anyway.
			return false;
		}
		// Read immediately before writing so a racing process that already wrote the id is
		// observed here and loses this claim. Losing a race is the safe direction to be
		// wrong in: it drops one path's delivery, not both.
		const entries = this.read();
		if (entries.includes(replyId)) {
			return false;
		}
		entries.push(replyId);
		const bounded = entries.slice(-MAX_ENTRIES);
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// Written whole then renamed, so a concurrent reader never sees half a file.
			const temporary = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify(bounded, undefined, 2), 'utf8');
			fs.renameSync(temporary, this.file);
		} catch {
			// A registry that cannot be written costs the cross-process guarantee for this
			// one reply, and the caller still delivers. Far better than failing a delivery
			// the user is waiting on.
		}
		return true;
	}

	release(replyId: string | undefined): void {
		if (!replyId) {
			return;
		}
		const entries = this.read();
		const remaining = entries.filter((entry) => entry !== replyId);
		if (remaining.length === entries.length) {
			return;
		}
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const temporary = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify(remaining, undefined, 2), 'utf8');
			fs.renameSync(temporary, this.file);
		} catch {
			// A registry that cannot be written costs the retry for this one reply: it
			// stays tombstoned until the file rolls it out, which is a small cost against
			// the alternative of failing every subsequent delivery.
		}
	}

	private read(): string[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
		} catch {
			// Missing or malformed: read as empty, so a bad file degrades to per-process
			// de-duplication rather than blocking every delivery.
			return [];
		}
	}
}

/** Registry that claims every reply, for tests and environments with no shared state. */
export const noopDeliveredRepliesRegistry: DeliveredRepliesRegistry = {
	claim: () => true,
	release: () => undefined,
	has: () => false
};
