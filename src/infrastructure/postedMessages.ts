import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The default file used by both processes to record message ids the bridge itself posted.
 *
 * Lives beside the shared thread registry, so an operator overriding `COPILOT_TEAMS_BRIDGE_HOME`
 * moves both together.
 */
export function defaultPostedMessagesPath(): string {
	const home = process.env.COPILOT_TEAMS_BRIDGE_HOME ?? path.join(os.homedir(), '.copilot-teams-bridge');
	return path.join(home, 'posted.json');
}

/** Kept small because the file is read on every reply fetch — bounded to the newest ids. */
const MAX_ENTRIES = 1_000;

/**
 * A cross-process record of Teams message ids the bridge itself posted.
 *
 * The bridge posts as the signed-in user, so an outbound message is indistinguishable from
 * an inbound one at the transport level: same author, same channel, same shape. Per-process
 * suppression via `seenReplyIds` in each session store used to be enough — until the
 * extension and the MCP server ended up with separate stores. A message suppressed in one
 * store is unknown in the other, and the moment either polls it treats the bridge's own
 * post as a fresh instruction, replies to it (as another own-post), and loops.
 *
 * Modelled on {@link JsonThreadRegistry}: read-merge-write on every record so concurrent
 * writers cannot clobber each other, capped so a long-running install cannot grow the file
 * without limit, and tolerant of a missing or corrupt file — a broken registry costs a
 * false positive on suppression at worst, which is far better than blocking the
 * notification the user is waiting on.
 */
export interface PostedMessagesRegistry {
	/** Records that the bridge posted this Teams message id. Safe to call with undefined. */
	record(messageId: string | undefined): void;
	/** True when this id was posted by *this* bridge (either process). */
	has(messageId: string): boolean;
}

export class JsonPostedMessagesRegistry implements PostedMessagesRegistry {
	constructor(private readonly file: string = defaultPostedMessagesPath()) {}

	has(messageId: string): boolean {
		if (!messageId) {
			return false;
		}
		return this.read().includes(messageId);
	}

	record(messageId: string | undefined): void {
		if (!messageId) {
			return;
		}
		const entries = this.read();
		if (entries.includes(messageId)) {
			return;
		}
		entries.push(messageId);
		// Newest kept — an id far enough back in the file is one the poller has already
		// walked past, so dropping it is a false negative that cannot actually mislead.
		const bounded = entries.slice(-MAX_ENTRIES);
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// Written whole and renamed into place, so a concurrent reader never sees
			// half a file.
			const temporary = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify(bounded, undefined, 2), 'utf8');
			fs.renameSync(temporary, this.file);
		} catch {
			// A registry that cannot be written costs a self-post being read back once,
			// which is far better than failing the outbound post that just succeeded.
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
			// Missing or malformed: treated as empty, so a bad file degrades to per-process
			// suppression rather than blocking every notification.
			return [];
		}
	}
}

/** Registry that records nothing, for tests and other environments with no shared state. */
export const noopPostedMessagesRegistry: PostedMessagesRegistry = {
	has: () => false,
	record: () => undefined
};
