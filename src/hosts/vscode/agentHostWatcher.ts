import * as vscode from 'vscode';
import { listAgentHostSessions } from './agentHostIndex';
import type { AgentHostSession } from './agentHostSessions';
import type { SessionIdentity } from '../../domain/types';

export interface AgentHostWatcherDeps {
	/** Lists the Copilot-mode sessions VS Code currently knows about. */
	sessions(): AgentHostSession[];
	announce(request: { sessionKey: string; title: string; identity: SessionIdentity }): Promise<boolean>;
	/** Reports that an already-announced session is still being worked on. */
	touch?(sessionKey: string): void;
	enabled(): boolean;
	intervalMs(): number;
	log: vscode.LogOutputChannel;
	setTimer?(handler: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
}

/**
 * Announces VS Code "Copilot mode" chats on Teams, and keeps their idle window alive.
 *
 * {@link ChatSessionWatcher} cannot do this. It watches `chatSessions/*.jsonl`, and a
 * Copilot-mode session writes no transcript at all, so the deterministic "a chat started"
 * signal never fires for that surface. Until this existed, such a session reached Teams
 * only if the agent inside it happened to call the notify tool -- guidance, not a
 * guarantee -- and a user working in Copilot mode saw nothing and could not tell whether
 * the bridge was broken or simply unused.
 *
 * VS Code's own session index is the signal instead. It is a database rather than files, so
 * this polls rather than watching: the index is rewritten wholesale, which makes a change
 * notification say nothing about *which* session changed.
 */
export class AgentHostWatcher {
	/** Resources already announced, so a session is not posted twice. */
	private readonly seen = new Set<string>();
	/**
	 * The request timing each known session was last seen at.
	 *
	 * A session is only "still being worked on" when this advances. Polling alone cannot
	 * tell activity from a rewrite of the same data, and treating every poll as activity
	 * would keep an abandoned session alive forever and defeat the idle window.
	 */
	private readonly lastSeenRequest = new Map<string, number>();
	private timer: unknown;
	private running = false;
	/**
	 * Set by {@link dispose}, so a poll already in flight does not arm a fresh timer as it
	 * finishes. Without it the watcher can outlive its own disposal, which in a test run
	 * keeps the process alive indefinitely and in the editor keeps polling a window that is
	 * shutting down.
	 */
	private disposed = false;

	constructor(private readonly deps: AgentHostWatcherDeps) {}

	/**
	 * Records what already exists, then starts polling.
	 *
	 * Seeding first is what stops every Copilot-mode chat in the workspace history being
	 * announced at once the first time this runs -- the same storm the transcript watcher
	 * guards against by marking existing files as seen.
	 */
	start(): void {
		if (this.timer !== undefined) {
			return;
		}
		for (const session of this.read()) {
			this.seen.add(session.resource);
			if (session.lastRequestStarted !== undefined) {
				this.lastSeenRequest.set(session.resource, session.lastRequestStarted);
			}
		}
		this.deps.log.info(`Watching for Copilot-mode sessions (${this.seen.size} already open).`);
		this.schedule();
	}

	private schedule(): void {
		if (this.disposed) {
			return;
		}
		const setTimer =
			this.deps.setTimer ??
			((handler: () => void, ms: number): unknown => {
				const handle = setTimeout(handler, ms);
				// Polling for new chats is background work: it must never be the reason a
				// process stays alive. Without this the self-rescheduling timer keeps Node
				// running forever once the editor has finished with it.
				handle.unref?.();
				return handle;
			});
		this.timer = setTimer(() => void this.poll(), this.deps.intervalMs());
	}

	/** Announces sessions that have appeared, and touches ones that have moved on. */
	async poll(): Promise<void> {
		if (this.running || this.disposed) {
			return;
		}
		this.running = true;
		try {
			if (!this.deps.enabled()) {
				return;
			}
			for (const session of this.read()) {
				if (this.seen.has(session.resource)) {
					this.touchIfActive(session);
					continue;
				}
				// A tab that has never run a request is an empty chat the user has not
				// typed into yet. Announcing it would open a Teams thread for a session
				// that may never exist, titled with a placeholder.
				if (session.lastRequestStarted === undefined) {
					continue;
				}
				await this.announce(session);
			}
		} catch (error) {
			this.deps.log.warn(`Could not check for Copilot-mode sessions: ${String(error)}`);
		} finally {
			this.running = false;
			this.schedule();
		}
	}

	private read(): AgentHostSession[] {
		try {
			return this.deps.sessions().filter((session) => !session.archived);
		} catch (error) {
			this.deps.log.warn(`Could not read the Copilot-mode session index: ${String(error)}`);
			return [];
		}
	}

	private touchIfActive(session: AgentHostSession): void {
		const started = session.lastRequestStarted;
		if (started === undefined) {
			return;
		}
		const previous = this.lastSeenRequest.get(session.resource);
		if (previous !== undefined && started <= previous) {
			return;
		}
		this.lastSeenRequest.set(session.resource, started);
		if (previous !== undefined) {
			// Only once a baseline exists: the first sighting is not a new turn.
			this.deps.touch?.(session.resource);
		}
	}

	private async announce(session: AgentHostSession): Promise<void> {
		this.seen.add(session.resource);
		if (session.lastRequestStarted !== undefined) {
			this.lastSeenRequest.set(session.resource, session.lastRequestStarted);
		}
		try {
			await this.deps.announce({
				// The resource is the key, so the session is addressable by the same string
				// everywhere and a reply resolves without a search.
				sessionKey: session.resource,
				title: session.label,
				identity: {
					harness: 'vscode-agent-host',
					// Recorded together with the harness, never alone: `vscode-agent-host`
					// is on the deliverable list, so a record naming the harness without a
					// chat would promise a route to nothing.
					chat: { kind: 'chat-session-resource', value: session.resource },
					confidence: 'exact',
					capturedBy: 'chat-watcher',
					capturedAt: new Date().toISOString()
				}
			});
		} catch (error) {
			// Allow a retry rather than losing the session to a transient Teams failure.
			this.seen.delete(session.resource);
			this.deps.log.warn(`Could not announce a Copilot-mode session: ${String(error)}`);
		}
	}

	dispose(): void {
		this.disposed = true;
		const clear = this.deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout));
		if (this.timer !== undefined) {
			clear(this.timer);
			this.timer = undefined;
		}
	}
}

/** Convenience factory used by the extension, wiring the index read to a state database. */
export function agentHostSessionsFrom(stateDbPath: string, log: vscode.LogOutputChannel): () => AgentHostSession[] {
	return () => listAgentHostSessions({ stateDbPath, log });
}
