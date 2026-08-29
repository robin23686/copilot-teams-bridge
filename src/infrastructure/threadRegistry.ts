import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ThreadRegistry } from '../application/ports';
import type { ThreadRef } from '../domain/types';

/** Where both processes look, so neither has to know about the other's storage. */
export function defaultThreadRegistryPath(): string {
	const home = process.env.COPILOT_TEAMS_BRIDGE_HOME ?? path.join(os.homedir(), '.copilot-teams-bridge');
	return path.join(home, 'threads.json');
}

/**
 * The session-key-to-thread map, kept in a small JSON file both hosts can reach.
 *
 * Read fresh on every lookup rather than cached, because the whole point is to see a claim
 * made by *another* process moments ago — a cached view would hand back "no thread yet" and
 * open the duplicate this exists to prevent.
 */
export class JsonThreadRegistry implements ThreadRegistry {
	constructor(private readonly file: string = defaultThreadRegistryPath()) {}

	lookup(key: string): ThreadRef | undefined {
		return this.read()[key];
	}

	record(key: string, thread: ThreadRef): void {
		const entries = this.read();
		const existing = entries[key];
		if (existing?.id === thread.id) {
			return;
		}
		entries[key] = thread;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// Written whole and renamed into place, so a reader never sees half a file.
			const temporary = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify(entries, undefined, 2), 'utf8');
			fs.renameSync(temporary, this.file);
		} catch {
			// A registry that cannot be written costs a duplicate thread, which is far
			// better than failing the notification the user is waiting on.
		}
	}

	private read(): Record<string, ThreadRef> {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return {};
			}
			const entries: Record<string, ThreadRef> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				const thread = value as ThreadRef | undefined;
				if (thread && typeof thread.id === 'string' && thread.id) {
					entries[key] = thread;
				}
			}
			return entries;
		} catch {
			// Missing or malformed: treated as empty, so a bad file degrades to the old
			// behaviour rather than blocking every notification.
			return {};
		}
	}
}
