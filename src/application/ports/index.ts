/**
 * Ports: what the application needs from the outside world, stated as interfaces.
 *
 * Declared here rather than beside their implementations so the dependency points inward —
 * infrastructure implements these, the application only ever sees them. That is what lets a
 * use case be tested without a Teams connection, a file system or an editor.
 */

import type { InboundReply, OutboundNotification, PostResult, Session, ThreadRef } from '../../domain/types';

/**
 * A transport that can hold one conversation thread per Copilot session.
 * `supportsReplies === false` means the transport is fire-and-forget.
 */
export interface ThreadedTransport {
	readonly kind: 'graph' | 'file';
	readonly supportsReplies: boolean;
	/** Creates a new thread and posts the first notification into it. */
	createThread(notification: OutboundNotification): Promise<PostResult>;
	/** Posts a follow-up notification into an existing thread. */
	postToThread(thread: ThreadRef, notification: OutboundNotification): Promise<PostResult>;
	/** Returns replies in the thread created strictly after `sinceIso`, oldest first. */
	fetchReplies(thread: ThreadRef, sinceIso: string | undefined): Promise<InboundReply[]>;
	/**
	 * Optional: rewrites the thread's opening message to show a new title.
	 * Transports that cannot edit a posted message simply omit this.
	 */
	renameThread?(thread: ThreadRef, notification: OutboundNotification): Promise<void>;
	dispose?(): void;
}

/** Minimal persistence contract, backed by VS Code memento at runtime. */
export interface SessionStore {
	read(): Session[];
	write(sessions: Session[]): void | Promise<void>;
}

/**
 * One Teams thread per session key, shared across processes.
 *
 * The extension and the MCP server each keep their own sessions — one in VS Code's memento,
 * the other in a JSON file — because neither can read the other's storage. That is fine for
 * state, and wrong for threads: both would call `createThread` for the same key and the user
 * would get two Teams threads for one task, with updates split between them.
 *
 * A thread is therefore claimed in a place both can see. Only the mapping is shared, so the
 * two stores stay independent and there is nothing to race beyond a single first write.
 */
export interface ThreadRegistry {
	/** The thread already opened for this key by any process, if there is one. */
	lookup(key: string): ThreadRef | undefined;
	/** Records the thread opened for this key, so the other process reuses it. */
	record(key: string, thread: ThreadRef): void;
}

export interface BridgeLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	/** Optional: verbose diagnostic output that only appears when debug logging is on. */
	debug?(message: string, ...args: unknown[]): void;
}

export const noopLogger: BridgeLogger = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	debug: () => undefined
};

export class InMemorySessionStore implements SessionStore {
	private sessions: Session[] = [];

	read(): Session[] {
		return this.sessions.map((session) => ({ ...session, seenReplyIds: [...session.seenReplyIds] }));
	}

	write(sessions: Session[]): void {
		this.sessions = sessions.map((session) => ({ ...session, seenReplyIds: [...session.seenReplyIds] }));
	}
}
