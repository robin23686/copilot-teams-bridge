import type { BridgeLogger, SessionStore, ThreadedTransport, ThreadRegistry } from './ports';
import { InMemorySessionStore, noopLogger } from './ports';
import { describeHarness, identityOf, preferIdentity, replyReachability, repliesReachChat } from './services/harness';
import { asChatSessionResource } from '../domain/chatSessionLink';
import { isClosingCommand, isEmptyReply, parseReply } from '../domain/messageFormat';
import type {
	InboundReply,
	NotificationStatus,
	Session,
	SessionIdentity,
	ThreadRef,
	ActivitySource
} from '../domain/types';

export interface BridgeOptions {
	transport: ThreadedTransport;
	store?: SessionStore;
	logger?: BridgeLogger;
	/** Shared claim on one Teams thread per session key, across processes. */
	threadRegistry?: ThreadRegistry;
	pollIntervalMs?: number;
	sessionIdleMs?: number;
	/** How long a thread is still read after expiring. */
	expiredGraceMs?: number;
	/** Post a short note in Teams when a reply is handed to an agent. */
	acknowledgeReplies?: boolean;
	workspace?: string;
	now?: () => Date;
	setTimer?: (handler: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export interface NotifyRequest {
	/**
	 * Exact session id, returned by a previous notify. When supplied it wins over the key,
	 * which removes any guesswork about whether two calls mean the same task.
	 */
	sessionId?: string;
	/** Stable key for the task, used when no session id is known yet. */
	sessionKey: string;
	title: string;
	summary: string;
	status: NotificationStatus;
	question?: string;
	files?: string[];
	awaitingReply?: boolean;
	/** Chat session that issued the call, when the host exposes it. */
	chatSessionResource?: string;
	/**
	 * Who owns this session, from whichever caller knew it.
	 *
	 * Recorded once and then only upgraded, never downgraded — a later call from a host
	 * with less information must not erase a chat that an earlier one established.
	 */
	identity?: SessionIdentity;
}

export interface NotifyResult {
	session: Session;
	threadUrl?: string;
	/** False when the transport is one-way and cannot receive replies. */
	repliesSupported: boolean;
}

/** A reply routed to a session, after cleaning and command parsing. */
export interface RoutedReply {
	session: Session;
	reply: InboundReply;
	text: string;
	command?: string;
}

export type ReplyHandler = (routed: RoutedReply) => void | Promise<void>;
export type SessionExpiryHandler = (session: Session) => void | Promise<void>;

interface Waiter {
	sessionId: string;
	resolve: (reply: RoutedReply) => void;
	timer?: unknown;
}

/** A thread that could not be read on the last poll. */
export interface PollFailure {
	sessionId: string;
	title: string;
	reason: string;
}

const MAX_SEEN_IDS = 200;
/** Replies held for a caller that has not asked yet. Bounded so a forgotten session cannot grow without limit. */
const MAX_UNDELIVERED = 50;
/**
 * Turn ids remembered per session, so a rescan cannot repost.
 *
 * Bounded like the others, and generously: the whole point is that a long conversation
 * still remembers its early turns, since the transcript is re-read from the start every
 * time and a forgotten id means that turn is posted to Teams a second time.
 */
const MAX_POSTED_TURNS = 500;/** Waiter key meaning "the next reply in any session". */
const ANY_SESSION = '*';
/** Ceiling for backed-off polling, so a broken upstream is retried hourly rather than forgotten. */
const MAX_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Expired threads are read one tick in six, so watching them costs little. */
const EXPIRED_POLL_EVERY = 6;

/** How long after expiry a thread is still read before it is truly abandoned. */
/**
 * How long an expired thread is still read.
 *
 * Zero: an expired session is not polled at all. The user is told so — in the expiry notice
 * and in the footer of every message — and revives it from VS Code, so a reply is no longer
 * silently ignored the way it was when the thread still invited one.
 */
const DEFAULT_EXPIRED_GRACE_MS = 0;

/**
 * Owns the session <-> thread mapping and the polling loop.
 *
 * Routing rule: one Copilot session == one Teams thread. Anything the user types in a
 * thread is an instruction for that session, so no ids or prefixes are ever needed.
 */
export class Bridge {
	private readonly transport: ThreadedTransport;
	private readonly store: SessionStore;
	private readonly logger: BridgeLogger;
	private readonly threadRegistry?: ThreadRegistry;
	private readonly pollIntervalMs: number;
	private readonly sessionIdleMs: number;
	private readonly expiredGraceMs: number;
	private readonly acknowledgeReplies: boolean;
	/**
	 * Counts polls, to read expired threads on a slower cadence.
	 *
	 * Starts below zero so the very first poll includes them: after a restart the editor may
	 * have been closed for hours, which is exactly when a reply is most likely to be waiting.
	 */
	private tick = -1;
	private readonly now: () => Date;
	private readonly setTimer: (handler: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly workspace?: string;

	private sessions: Session[];
	private readonly waiters = new Map<string, Waiter[]>();
	private readonly handlers = new Set<ReplyHandler>();
	private readonly expiryHandlers = new Set<SessionExpiryHandler>();
	/**
	 * Per-thread lifecycle state, keyed by thread id.
	 *
	 * The bridge holds one store (the extension memento) but the AgentReplyRelay owns a
	 * second (~/.copilot-teams-bridge/sessions.json). Both stores can hold a record for the
	 * same underlying Teams thread, so keying de-duplication on the session id would let
	 * one pause or resume notice slip through per store. The thread is what the user reads,
	 * so it is the correct key: one pause notice and one resume notice per transition, no
	 * matter how many stores hold a record for that thread.
	 *
	 * Starts empty after a window reload, which is intentional — the first notice of either
	 * kind after a reload is still posted.
	 */
	private readonly threadLifecycle = new Map<string, 'paused' | 'active'>();
	/**
	 * Per-reply "already noticed" guard for sessions this Bridge does not own.
	 *
	 * The dedup fields on Session (noticedReplyIds, unreachableNoticeAt) are persisted on
	 * the Bridge's own session records. When the notice fires for a session owned by the
	 * AgentReplyRelay's on-disk store — the ~/.copilot-teams-bridge/sessions.json case a
	 * pure agent/CLI session lives in — that persistence cannot happen here, so without an
	 * in-memory guard the same "reply could not be delivered" notice would post on every
	 * poll. Bounded like MAX_SEEN_IDS so a long-running process cannot grow it forever.
	 */
	private readonly noticedRepliesMemory = new Set<string>();
	/**
	 * Per-session unreachable-notice guard for the same non-owned case.
	 *
	 * Held separately from noticedRepliesMemory because a session whose harness cannot be
	 * reached is answered once ever — not once per reply — so keying it on session id is
	 * the correct guard, matching the owned-session behaviour of unreachableNoticeAt.
	 */
	private readonly unreachableNoticedMemory = new Set<string>();
	private pollFailures: PollFailure[] = [];
	private currentIntervalMs: number;
	private pollHandle: unknown;
	private polling = false;
	private disposed = false;

	constructor(options: BridgeOptions) {
		this.transport = options.transport;
		this.store = options.store ?? new InMemorySessionStore();
		this.logger = options.logger ?? noopLogger;
		this.threadRegistry = options.threadRegistry;
		this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
		this.currentIntervalMs = this.pollIntervalMs;
		this.sessionIdleMs = options.sessionIdleMs ?? 2 * 60 * 60 * 1000;
		this.expiredGraceMs = options.expiredGraceMs ?? DEFAULT_EXPIRED_GRACE_MS;
		this.acknowledgeReplies = options.acknowledgeReplies ?? true;
		this.now = options.now ?? (() => new Date());
		this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
		this.workspace = options.workspace;
		this.sessions = this.store.read();
	}

	get isListening(): boolean {
		return this.pollHandle !== undefined;
	}

	get transportKind(): string {
		return this.transport.kind;
	}

	get supportsReplies(): boolean {
		return this.transport.supportsReplies;
	}

	listSessions(): Session[] {
		return this.sessions.map((session) => ({ ...session }));
	}

	getSession(sessionId: string): Session | undefined {
		return this.sessions.find((session) => session.id === sessionId);
	}

	onReply(handler: ReplyHandler): () => void {
		this.handlers.add(handler);
		// Anything that arrived before a handler existed is still owed to the user.
		const backlog = this.takeUndelivered();
		for (const routed of backlog) {
			void Promise.resolve(handler(routed)).catch((error: unknown) => {
				this.logger.error(`Reply handler failed: ${describeError(error)}`);
			});
		}
		return () => this.handlers.delete(handler);
	}

	/**
	 * Threads that could not be read on the most recent poll.
	 *
	 * Callers must report these: a read failure and an empty thread are otherwise
	 * indistinguishable, so a wedged transport looks exactly like "the user has not
	 * replied yet" and the bridge appears to work while silently delivering nothing.
	 */
	get lastPollFailures(): PollFailure[] {
		return this.pollFailures.map((failure) => ({ ...failure }));
	}

	/**
	 * Removes and returns replies that arrived with nothing waiting to consume them.
	 *
	 * Hosts that have no way to push into a conversation — the MCP server, for instance —
	 * poll on demand, so a reply routed by a background tick would otherwise be marked
	 * seen and thrown away before anyone asked for it.
	 */
	takeUndelivered(sessionId?: string): RoutedReply[] {
		const taken: RoutedReply[] = [];
		let changed = false;

		for (const session of this.sessions) {
			if (sessionId !== undefined && session.id !== sessionId) {
				continue;
			}
			for (const held of session.pending ?? []) {
				taken.push({ session: { ...session }, reply: held.reply, text: held.text, command: held.command });
			}
			if (session.pending?.length) {
				session.pending = undefined;
				changed = true;
			}
		}

		if (changed) {
			this.persist();
		}
		return taken.sort((a, b) => Date.parse(a.reply.createdAt) - Date.parse(b.reply.createdAt));
	}

	/** Posts a notification, creating the session's Teams thread on first use. */
	async notify(request: NotifyRequest): Promise<NotifyResult> {
		// A single chat is one conversation, no matter which sessionKey the caller happens
		// to have picked this call. Passing the chat lets ensureSession recognise that a
		// notify arriving under a fresh key really belongs to the session the transcript
		// watcher already opened for that chat, and reuse it instead of minting a second.
		const chatValue = asChatSessionResource(
			request.chatSessionResource ?? request.identity?.chat?.value
		);
		const session = this.ensureSession(request.sessionKey, request.title, request.sessionId, chatValue);
		if (request.chatSessionResource) {
			// Refreshed every call, so a task continued in a different chat follows the move.
			session.chatSessionResource = request.chatSessionResource;
		}
		// Only ever improved: a caller that knows less must not erase what one that knew
		// more already established.
		session.identity = preferIdentity(session.identity, request.identity);

		// A thread claimed by the other process for this same key. Without this the
		// extension and the MCP server each create their own, and one task ends up with two
		// Teams threads whose updates and replies are split between them.
		if (!session.thread) {
			const shared = this.threadRegistry?.lookup(session.key);
			if (shared) {
				session.thread = shared;
				this.logger.info(`Reusing the existing Teams thread for "${session.title}"`);
			}
		}

		// "unknown" means the identity has not been captured yet, not that delivery is
		// impossible. The relay resolves such a session lazily when a reply arrives, so
		// leave the field undefined — that falls through to the normal reply invitation
		// in renderNotificationHtml. Only assert false for a harness with no adapter.
		const currentIdentity = identityOf(session);
		const reachability = replyReachability(currentIdentity);
		const notification = {
			sessionId: session.id,
			title: request.title,
			summary: request.summary,
			status: request.status,
			question: request.question,
			files: request.files,
			workspace: session.workspace,
			awaitingReply: request.awaitingReply,
			repliesReachChat: reachability === 'no' ? false : undefined,
			// Passed through so the footer can distinguish a CLI-hosted agent (queued for
			// pickup) from an external client (nothing here can reach it); other renderers
			// ignore it.
			unreachableHarness: reachability === 'no' ? currentIdentity.harness : undefined
		};

		const result = session.thread
			? await this.transport.postToThread(session.thread, notification)
			: await this.transport.createThread(notification);

		session.thread = result.thread;
		if (session.thread) {
			// Claimed for this key, so the other process finds it instead of opening its own.
			this.threadRegistry?.record(session.key, session.thread);
		}
		session.status = request.status;
		session.title = request.title;
		session.closed = false;
		session.expiredAt = undefined;
		session.lastActivityAt = this.now().toISOString();
		session.lastActivitySource = 'notify';
		// Recorded so the automatic per-turn summary can tell that this turn has already
		// been reported, and stay quiet rather than duplicating it.
		session.lastNotifyAt = session.lastActivityAt;
		if (result.postedMessageId) {
			// Our own message would otherwise be read back as a user reply.
			this.markSeen(session, result.postedMessageId);
		}
		// Replies are only interesting from this point forward.
		session.lastReplyAt = session.lastReplyAt ?? session.lastActivityAt;
		this.persist();

		return {
			session: { ...session },
			threadUrl: session.thread?.webUrl,
			repliesSupported: this.transport.supportsReplies
		};
	}

	/**
	 * Waits for the next reply in a session's thread.
	 * Resolves with `undefined` on timeout so callers can report a clean "no answer yet".
	 */
	async waitForReply(sessionId: string, timeoutMs: number): Promise<RoutedReply | undefined> {
		return this.wait(sessionId, timeoutMs);
	}

	/**
	 * Waits for the next reply in any session.
	 *
	 * Hosts cap how long a single tool call may run, so a long wait has to be rebuilt from
	 * short ones. This lets a caller keep listening after its first wait returned empty,
	 * without posting another message to Teams just to re-arm.
	 */
	async waitForAnyReply(timeoutMs: number): Promise<RoutedReply | undefined> {
		return this.wait(ANY_SESSION, timeoutMs);
	}

	private async wait(key: string, timeoutMs: number): Promise<RoutedReply | undefined> {
		if (!this.transport.supportsReplies) {
			return undefined;
		}
		// A reply may have been collected by a background tick before this call began.
		const buffered = this.takeUndelivered(key === ANY_SESSION ? undefined : key);
		if (buffered.length > 0) {
			const [first, ...rest] = buffered;
			// Only one reply is returned per call, so the remainder goes back on the queue.
			for (const held of rest) {
				this.hold(held);
			}
			return first;
		}
		this.start();
		// Someone is actively expecting an answer, so a backoff left over from an earlier
		// outage must not leave this wait polling minutes apart.
		this.currentIntervalMs = this.pollIntervalMs;

		return new Promise<RoutedReply | undefined>((resolve) => {
			const waiter: Waiter = { sessionId: key, resolve: (routed) => finish(routed) };
			const finish = (routed?: RoutedReply): void => {
				if (waiter.timer !== undefined) {
					this.clearTimer(waiter.timer);
					waiter.timer = undefined;
				}
				this.removeWaiter(key, waiter);
				resolve(routed);
			};
			waiter.timer = this.setTimer(() => finish(undefined), timeoutMs);
			const list = this.waiters.get(key) ?? [];
			list.push(waiter);
			this.waiters.set(key, list);
			// A reply may already be sitting in the thread from before the wait started.
			void this.poll();
		});
	}

	start(): void {
		if (this.disposed || this.pollHandle !== undefined || !this.transport.supportsReplies) {
			return;
		}
		// Rescheduled after each poll rather than on a fixed interval, so the delay can
		// reflect how the last one went. Hammering an upstream that is already returning
		// 429s makes the outage longer, and every failed poll is a reply not delivered.
		const tick = (): void => {
			void this.poll().finally(() => {
				if (this.pollHandle !== undefined && !this.disposed) {
					this.pollHandle = this.setTimer(tick, this.currentIntervalMs);
				}
			});
		};
		this.pollHandle = this.setTimer(tick, this.pollIntervalMs);
		this.logger.info(`Teams bridge listening every ${Math.round(this.pollIntervalMs / 1000)}s`);
	}

	/** How long the listener will wait before its next poll. */
	get pollDelayMs(): number {
		return this.currentIntervalMs;
	}

	stop(): void {
		if (this.pollHandle !== undefined) {
			this.clearTimer(this.pollHandle);
			this.pollHandle = undefined;
			this.logger.info('Teams bridge stopped listening');
		}
	}

	/**
	 * Reads new replies for a thread this bridge does not own.
	 *
	 * The MCP server keeps its sessions in a file of its own and polls them itself, which
	 * only works while it is running — and it is spawned per tool call, so most of the time
	 * nothing is watching those threads and a reply sits in Teams unread. The extension is
	 * the one process alive whenever VS Code is, so it reads on their behalf.
	 */
	async readThread(thread: ThreadRef, sinceIso: string | undefined): Promise<InboundReply[]> {
		return this.transport.fetchReplies(thread, sinceIso);
	}

	/**
	 * Polls every active thread once and dispatches any new replies.
	 *
	 * Expiry is evaluated *after* reading, so a reply that arrived while VS Code was
	 * closed is still delivered rather than being discarded by the same poll that
	 * notices the session went quiet.
	 */
	async poll(): Promise<RoutedReply[]> {
		if (this.polling || this.disposed || !this.transport.supportsReplies) {
			return [];
		}
		this.polling = true;
		const routedAll: RoutedReply[] = [];
		const failures: PollFailure[] = [];
		const revived: Session[] = [];

		try {
			this.tick++;
			for (const session of this.watchedSessions()) {
				if (!session.thread) {
					continue;
				}
				let replies: InboundReply[];
				try {
					replies = await this.transport.fetchReplies(session.thread, session.lastReplyAt);
				} catch (error) {
					const reason = describeError(error);
					this.logger.warn(`Failed to read Teams thread for "${session.title}": ${reason}`);
					failures.push({ sessionId: session.id, title: session.title, reason });
					continue;
				}

				for (const reply of replies) {
					if (session.seenReplyIds.includes(reply.id)) {
						continue;
					}
					this.markSeen(session, reply.id);
					this.advanceWatermark(session, reply.createdAt);

					if (isEmptyReply(reply.text)) {
						continue;
					}

					const parsed = parseReply(reply.text);
					session.lastActivityAt = this.now().toISOString();
					session.lastActivitySource = 'teams-reply';
					if (session.expiredAt) {
						// Only reachable when the caller opted into a grace period: with the
						// default (expiredGraceMs = 0) watchedSessions() does not yield
						// expired threads at all, so replies posted after expiry are neither
						// fetched nor delivered. When the opt-in is on, replying is the
						// plainest statement that the thread is still wanted, so it revives
						// the session and the reply is passed through.
						session.expiredAt = undefined;
						revived.push(session);
						this.logger.info(`Session "${session.title}" resumed by a reply after it had expired`);
					}
					const routed: RoutedReply = { session: { ...session }, reply, text: parsed.text, command: parsed.command };

					if (isClosingCommand(parsed.command)) {
						session.closed = true;
					}

					routedAll.push(routed);
				}
			}
			this.persist();
		} finally {
			this.polling = false;
			this.pollFailures = failures;
			this.currentIntervalMs =
				failures.length > 0 ? Math.min(this.currentIntervalMs * 2, MAX_POLL_INTERVAL_MS) : this.pollIntervalMs;
		}

		for (const session of revived) {
			try {
				await this.postResumedNotice(session);
			} catch (error) {
				this.logger.warn(`Could not confirm the session resumed: ${describeError(error)}`);
			}
		}

		for (const routed of routedAll) {
			await this.dispatch(routed);
		}

		// Older instructions the user is still waiting on, offered again now the chat they
		// belong to may have come to the front.
		await this.redeliverRetained();

		// After delivering, so a reply that arrived during the quiet period both reaches
		// Copilot and resets the window instead of being lost to expiry.
		await this.expireIdleSessions();
		return routedAll;
	}

	closeSession(sessionId: string): void {
		const session = this.getSession(sessionId);
		if (session) {
			session.closed = true;
			this.persist();
		}
	}

	/**
	 * Marks sessions that have gone quiet as expired and notifies the handlers.
	 *
	 * Expiring rather than silently dropping matters: the user is told in Teams that
	 * replies are no longer being read, so a message sent later is never lost without
	 * explanation.
	 */
	private async expireIdleSessions(): Promise<void> {
		const cutoff = this.now().getTime() - this.sessionIdleMs;
		// A caller waiting on any session is still watching all of them.
		const watchingAll = this.waiters.has(ANY_SESSION);
		const expiring = this.sessions.filter(
			(session) =>
				!session.closed &&
				!session.expiredAt &&
				session.thread !== undefined &&
				Date.parse(session.lastActivityAt) < cutoff &&
				!watchingAll &&
				!this.waiters.has(session.id)
		);

		if (expiring.length === 0) {
			return;
		}

		const timestamp = this.now().toISOString();
		for (const session of expiring) {
			session.expiredAt = timestamp;
		}
		this.persist();

		for (const session of expiring) {
			this.logger.info(`Session "${session.title}" expired after ${formatIdleWindow(this.sessionIdleMs)} idle`);
			for (const handler of this.expiryHandlers) {
				try {
					await handler({ ...session });
				} catch (error) {
					this.logger.error(`Session expiry handler failed: ${describeError(error)}`);
				}
			}
		}
	}

	/**
	 * Reactivates an expired session so its thread is watched again.
	 * Returns the session, or undefined when the id is unknown or already closed.
	 */
	extendSession(sessionId: string): Session | undefined {
		const session = this.getSession(sessionId);
		if (!session || session.closed) {
			return undefined;
		}
		const wasExpired = Boolean(session.expiredAt);
		session.expiredAt = undefined;
		const revivedAt = this.now().toISOString();
		session.lastActivityAt = revivedAt;
		session.lastActivitySource = 'revival';
		if (wasExpired) {
			// The user was told replies would not reach Copilot while the session was
			// expired, so anything typed in the meantime must be honoured as ignored:
			// advancing the watermark to the reactivation instant means those replies are
			// permanently skipped instead of being delivered late and out of context.
			this.advanceWatermark(session, revivedAt);
			this.logger.info(
				`Session "${session.title}" reactivated by extend; skipping any replies posted while it was expired`
			);
		}
		this.persist();
		this.start();
		return { ...session };
	}

	/**
	 * Records that a session is still being worked on, which slides its idle window.
	 *
	 * The window has to be measured from the last turn on *either* side, or a conversation
	 * carried on entirely in the editor is declared dead while the user is mid-sentence in
	 * it. A turn in VS Code is exactly as good a sign of life as a reply from Teams.
	 *
	 * Returns the session when it had expired and this revived it, so the caller can say so
	 * in the thread — the user was told replies had stopped being read, and that has to be
	 * taken back explicitly rather than silently.
	 */
	recordActivity(sessionId: string, source: ActivitySource): { session: Session; revived: boolean } | undefined {
		const session = this.getSession(sessionId) ?? this.sessions.find((entry) => entry.key === sessionId);
		if (!session || session.closed) {
			return undefined;
		}
		const revived = Boolean(session.expiredAt);
		session.expiredAt = undefined;
		const revivedAt = this.now().toISOString();
		session.lastActivityAt = revivedAt;
		session.lastActivitySource = source;
		if (revived) {
			// The user was told replies would not reach Copilot while the session was
			// expired, so those replies must stay ignored: advance the watermark to the
			// reactivation instant so only messages posted from now on are ever fetched.
			this.advanceWatermark(session, revivedAt);
			this.logger.info(
				`Session "${session.title}" revived by activity in VS Code; skipping any replies posted while it was expired`
			);
			this.start();
		}
		this.persist();
		return { session: { ...session }, revived };
	}

	/**
	 * Posts the "this session has gone quiet" notice into an expired session's thread.
	 *
	 * Kept separate from notify() because notify revives a session, which would undo the
	 * expiry we are reporting.
	 */
	async postExpiryNotice(session: Session, idleMs: number): Promise<void> {
		// Fall back to the session passed in when its id is unknown to this Bridge: the
		// AgentReplyRelay owns a second store whose session ids never enter the memento, so
		// without this the notice for the exact sessions the relay expires would be a
		// silent no-op.
		const target = this.getSession(session.id) ?? session;
		if (!target.thread) {
			return;
		}
		// De-duplication is keyed on the thread, not the session id, because two stores can
		// each hold a record for the same thread. Without this the same pause notice would
		// be posted once per store on the same transition.
		if (this.threadLifecycle.get(target.thread.id) === 'paused') {
			return;
		}
		const window = formatIdleWindow(idleMs);
		const result = await this.transport.postToThread(target.thread, {
			sessionId: target.id,
			title: target.title,
			summary: [
				`**This session has gone quiet for ${window}, so this thread is no longer being read.**`,
				'',
				'Anything you post here from now on will be **ignored** — it will not be delivered later, ' +
					'even after the session resumes.',
				'',
				'**To continue, carry on in this chat in VS Code** (or run **Teams Bridge: Extend a Session**). ' +
					'Once you do, a confirmation is posted here and replies work again.'
			].join('\n'),
			status: 'paused',
			workspace: target.workspace,
			// The body says replies are no longer read; the footer must not then invite one.
			repliesReachChat: false
		});
		this.threadLifecycle.set(target.thread.id, 'paused');
		this.suppressOwnMessage(target, result.postedMessageId);
	}

	/** Confirms in the thread that an extended session is being watched again. */
/**
	 * Tells the user in Teams that their reply has been picked up.
	 *
	 * Posted when the instruction actually reaches something that will act on it, not when
	 * it is merely read: a message promising work while the reply still sits in a queue
	 * would be worse than silence. Until the agent posts its own first update there is
	 * otherwise no sign the reply arrived, which is indistinguishable from it being lost —
	 * the failure this bridge has had more than any other.
	 */
	async acknowledgeReply(routed: RoutedReply): Promise<void> {
		if (!this.acknowledgeReplies || isClosingCommand(routed.command)) {
			// A stop needs no promise of work; the agent confirms it having stopped.
			return;
		}
		// Fall back to the session passed in when its id is unknown to this Bridge: an
		// agent/CLI session lives only in the relay's on-disk store, and without this the
		// "got it — working on this" ack for exactly those sessions would be a silent no-op.
		const target = this.getSession(routed.session.id) ?? routed.session;
		if (!target.thread) {
			return;
		}
		try {
			const result = await this.transport.postToThread(target.thread, {
				sessionId: target.id,
				title: target.title,
				summary: '**Got it — working on this.**',
				status: 'progress',
				workspace: target.workspace
			});
			// With delegated auth the bridge posts as the user it is replying to, so its own
			// acknowledgement is fetched back and read as a fresh instruction. Left unmarked
			// it becomes an inbound reply that consumes a delivery slot and, worse, answers
			// itself: an acknowledgement acknowledged.
			this.suppressOwnMessage(target, result.postedMessageId);
		} catch (error) {
			// Never let a courtesy message stop the instruction being carried out.
			this.logger.warn(`Could not acknowledge the reply in Teams: ${describeError(error)}`);
		}
	}

	/**
	 * Tells the user in Teams what became of a reply that was not delivered.
	 *
	 * The alternative is silence about an instruction that was accepted and then dropped,
	 * which is the failure mode this bridge exists to avoid. The reply is still in the
	 * thread, so nothing is lost by not injecting it — but nothing says so unless it is said.
	 *
	 * Two different situations, and telling them apart matters. A session whose harness
	 * simply cannot be reached from this window is not a puzzle to be solved — no amount of
	 * waiting will make it deliverable — so it is answered plainly, once, and the reply is
	 * not left to be retried forever. A session whose chat merely has not been identified
	 * yet may still become deliverable, so that one keeps its "not yet" wording.
	 */
	async postUnroutableNotice(routed: RoutedReply): Promise<void> {
		// Fall back to the session handed in when the id is unknown to this Bridge: agent
		// and CLI sessions live only in the relay's on-disk store, and without this the
		// notice for exactly those sessions would be a silent no-op — the very failure this
		// exists to prevent.
		const owned = this.getSession(routed.session.id);
		const target = owned ?? routed.session;
		if (!target.thread) {
			return;
		}
		const identity = identityOf(target);
		const unreachable = !repliesReachChat(identity) && identity.harness !== 'unknown';
		// The chat is on record, so this is not a failure to identify it. Saying otherwise
		// is a false explanation, and it sends the user looking for the wrong problem.
		const identified = Boolean(identity.chat);
		// A session created by an agent/CLI process outside VS Code records no chat and no
		// harness: neither field is a mistake, and the notice must not tell the user to
		// open something that never existed.
		const queuedForAgent = !identity.chat && identity.harness === 'unknown';

		// Repeating it on every pass would bury the thread; the point is made once.
		if (unreachable) {
			if (owned?.unreachableNoticeAt) {
				return;
			}
			if (!owned && this.unreachableNoticedMemory.has(target.id)) {
				return;
			}
		}
		// The same, for the far more common case. A retained reply is retried on every
		// poll, so without this the user gets an identical "still waiting" notice every ten
		// seconds — which buries the conversation it is trying to report on, and makes a
		// working retry look like a storm of failures. For a session the Bridge does not
		// own the persisted list cannot be written, so an in-memory guard stands in.
		if (owned) {
			if (owned.noticedReplyIds?.includes(routed.reply.id)) {
				return;
			}
			owned.noticedReplyIds = [...(owned.noticedReplyIds ?? []), routed.reply.id].slice(-MAX_SEEN_IDS);
			this.persist();
		} else {
			if (this.noticedRepliesMemory.has(routed.reply.id)) {
				return;
			}
			this.noticedRepliesMemory.add(routed.reply.id);
			if (this.noticedRepliesMemory.size > MAX_SEEN_IDS) {
				const oldest = this.noticedRepliesMemory.values().next().value;
				if (oldest !== undefined) {
					this.noticedRepliesMemory.delete(oldest);
				}
			}
		}

		try {
			const result = await this.transport.postToThread(target.thread, {
				sessionId: target.id,
				title: target.title,
				summary: unreachable
					? [
							'**Replying here will not resume the work.**',
							'',
							`This session runs in ${describeHarness(identity.harness)}, which this ` +
								'window cannot deliver a message into, so your reply has been read but ' +
								'cannot be handed to Copilot.',
							'',
							'**Open the session in VS Code and continue from there.** Your message is ' +
								'still above in this thread, so nothing is lost — updates will keep ' +
								'arriving here as the work continues.'
						].join('\n')
					: identified
						? [
								'**Waiting — this reply has not been handed over yet.**',
								'',
								'It belongs to a specific VS Code chat, and that chat could not be brought to ' +
									'the front to receive it. It has not been put anywhere else: VS Code writes ' +
									'a chat request to whichever chat is focused, so delivering now would drop ' +
									'your instruction into an unrelated conversation and cost both tasks.',
								'',
								'_Open that chat in VS Code and it goes through on the next check._'
							].join('\n')
						: queuedForAgent
							? [
									'**Your reply is queued for the agent that started this session.**',
									'',
									'It will be picked up the next time that agent checks for replies — ' +
										'nothing is lost, and no chat has been sent anything on your behalf.',
									'',
									'_If that agent has already finished, continue the work in VS Code._'
								].join('\n')
							: [
									'**This reply could not be delivered yet — the chat that started this task has not been identified.**',
									'',
									'It was not sent to another chat, because that would have put your instruction into ' +
										'an unrelated conversation. **Open the chat for this task in VS Code**; the reply ' +
										'is kept and delivered as soon as that chat is known.'
								].join('\n'),
				status: 'failed',
				workspace: target.workspace,
				repliesReachChat: false
			});
			if (unreachable) {
				if (owned) {
					owned.unreachableNoticeAt = this.now().toISOString();
					this.persist();
				} else {
					this.unreachableNoticedMemory.add(target.id);
				}
			}
			this.suppressOwnMessage(target, result.postedMessageId);
		} catch (error) {
			this.logger.warn(`Could not report an undeliverable reply in Teams: ${describeError(error)}`);
		}
	}

	async postResumedNotice(session: Session): Promise<void> {
		// Fall back to the session passed in when its id is unknown to this Bridge: an
		// agent/CLI session lives only in the relay's on-disk store, and without this the
		// resumed notice for exactly those sessions would be a silent no-op.
		const target = this.getSession(session.id) ?? session;
		if (!target.thread) {
			return;
		}
		// Keyed on the thread so the same resume transition posts once even when both the
		// memento and the relay's store hold a record for the same thread.
		if (this.threadLifecycle.get(target.thread.id) === 'active') {
			return;
		}
		// See replyReachability: "unknown" is not yet identified, not undeliverable. Treat
		// it as reachable for the invitation, but leave the notification field undefined so
		// the footer falls through to the normal reply invitation.
		const reachability = replyReachability(identityOf(target));
		const reachable = reachability !== 'no';
		const result = await this.transport.postToThread(target.thread, {
			sessionId: target.id,
			title: target.title,
			summary: [
				'**This session is active again.**',
				'',
				'Anything you posted here while it was paused was not picked up, so resend it if it ' +
					'still matters.',
				'',
				reachable
					? 'Reply here and it will be picked up as the next instruction.'
					: 'Updates will keep arriving here, but this session cannot receive replies — ' +
						'give Copilot its next instruction in VS Code.'
			].join('\n'),
			status: 'progress',
			workspace: target.workspace,
			repliesReachChat: reachability === 'no' ? false : undefined
		});
		this.threadLifecycle.set(target.thread.id, 'active');
		this.suppressOwnMessage(target, result.postedMessageId);
	}

	/**
	 * Records a message the bridge itself posted so it is never read back as a reply.
	 *
	 * With delegated auth the bridge posts as the same user who replies, so without this
	 * every notice would be routed straight back to Copilot as an instruction.
	 */
	private suppressOwnMessage(session: Session, postedMessageId: string | undefined): void {
		if (postedMessageId) {
			this.markSeen(session, postedMessageId);
		}
		this.persist();
	}

	/**
	 * Renames a session and, where the transport allows it, its Teams thread.
	 *
	 * Returns false when the session is unknown. Renaming is best effort: Teams fixes a
	 * thread's subject at creation, so the header keeps its original text even though the
	 * opening message is rewritten.
	 */
	async renameSession(sessionId: string, title: string): Promise<boolean> {
		const session = this.getSession(sessionId);
		if (!session) {
			return false;
		}
		const trimmed = title.trim();
		if (!trimmed) {
			return false;
		}

		session.title = trimmed;
		session.lastActivityAt = this.now().toISOString();
		this.persist();

		if (session.thread && this.transport.renameThread) {
			await this.transport.renameThread(session.thread, {
				sessionId: session.id,
				title: trimmed,
				summary: 'Session renamed from VS Code. Reply in this thread to send Copilot the next instruction.',
				status: session.status,
				workspace: session.workspace
			});
		}
		return true;
	}

	/** Sessions that have expired and could be extended. */
	listExpiredSessions(): Session[] {
		return this.sessions.filter((session) => session.expiredAt && !session.closed).map((session) => ({ ...session }));
	}

	/** Registers a handler called when a session goes idle past its window. */
	onSessionExpired(handler: SessionExpiryHandler): () => void {
		this.expiryHandlers.add(handler);
		return () => this.expiryHandlers.delete(handler);
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		for (const list of this.waiters.values()) {
			for (const waiter of list) {
				if (waiter.timer !== undefined) {
					this.clearTimer(waiter.timer);
				}
				waiter.resolve(undefined as unknown as RoutedReply);
			}
		}
		this.waiters.clear();
		this.handlers.clear();
		this.transport.dispose?.();
	}

	/** A waiting tool call consumes the reply; otherwise it goes to the chat injector. */
	private async dispatch(routed: RoutedReply): Promise<void> {
		// A wait on this specific session is more precise than a wait on any session, so it
		// is offered the reply first.
		if (this.resolveWaiter(routed.session.id, routed) || this.resolveWaiter(ANY_SESSION, routed)) {
			return;
		}

		if (this.handlers.size === 0) {
			// Nothing can take it right now, and it has already been marked seen, so holding
			// it is the only thing standing between the user's reply and silent loss.
			this.hold(routed);
			return;
		}

		for (const handler of this.handlers) {
			try {
				await handler(routed);
			} catch (error) {
				this.logger.error(`Reply handler failed: ${describeError(error)}`);
			}
		}
	}

	private resolveWaiter(key: string, routed: RoutedReply): boolean {
		const waiters = this.waiters.get(key);
		const waiter = waiters?.shift();
		if (!waiter) {
			return false;
		}
		if (waiters && waiters.length === 0) {
			this.waiters.delete(key);
		}
		waiter.resolve(routed);
		return true;
	}

	/**
	 * Puts a reply back after the caller that took it went away.
	 *
	 * A host that abandons a tool call mid-wait would otherwise take the reply with it:
	 * it has already been marked seen, so no later poll would ever find it again. It is
	 * re-dispatched rather than merely buffered, so a host with a live delivery path — the
	 * VS Code chat injector — still gets it instead of leaving it to be polled for.
	 */
	returnUndelivered(routed: RoutedReply): void {
		void this.dispatch(routed);
	}

	/**
	 * Publishes every thread this store already knows about to the shared claim.
	 *
	 * Without this the registry only helps sessions created after the upgrade: a task whose
	 * thread was opened before it existed would still be duplicated by the other process,
	 * which is exactly the case the user is living with today.
	 */
	publishThreads(): void {
		if (!this.threadRegistry) {
			return;
		}
		for (const session of this.sessions) {
			if (session.thread && !session.closed) {
				this.threadRegistry.record(session.key, session.thread);
			}
		}
	}

	/**
	 * Posts a summary of a finished chat turn into that chat's existing Teams thread.
	 *
	 * The user asked to be told about every turn, not only the ones where the model chose
	 * to call the notify tool. Posting is therefore driven by the transcript, and this is
	 * what keeps that honest:
	 *
	 * - it only ever posts into a thread that already exists, so a turn cannot start a
	 *   conversation in Teams the user never announced;
	 * - each request id is recorded, so rescanning the transcript — which happens on every
	 *   write and after every reload — cannot replay the conversation.
	 *
	 * Returns whether anything was posted, which is what the caller logs.
	 */
	async postTurnSummary(
		sessionKey: string,
		turn: { requestId: string; prompt: string; summary: string; startedAt?: number }
	): Promise<boolean> {
		const session = this.sessions.find((entry) => entry.key === sessionKey);
		// No thread means this chat was never announced, and a turn is not a reason to
		// start announcing it: the user chose which conversations Teams should know about.
		if (!session?.thread || session.closed) {
			return false;
		}
		if (session.postedTurnIds?.includes(turn.requestId)) {
			return false;
		}
		if (this.alreadyReported(session, turn.startedAt)) {
			// The model reported this turn itself, in its own words. Saying the same thing
			// again from the transcript would double every update in the thread.
			//
			// Still recorded as posted, or the check would run again on every rescan.
			session.postedTurnIds = [...(session.postedTurnIds ?? []), turn.requestId].slice(-MAX_POSTED_TURNS);
			this.persist();
			return false;
		}

		// Recorded before posting, so a failure midway cannot cause the same turn to be
		// posted twice on the next scan. A missed summary is better than a duplicated one.
		session.postedTurnIds = [...(session.postedTurnIds ?? []), turn.requestId].slice(-MAX_POSTED_TURNS);
		this.persist();

		try {
			const result = await this.transport.postToThread(session.thread, {
				sessionId: session.id,
				title: session.title,
				summary: [`**${this.firstPromptLine(turn.prompt)}**`, '', turn.summary].join('\n'),
				status: 'progress',
				workspace: session.workspace,
				repliesReachChat: replyReachability(identityOf(session)) === 'no' ? false : undefined
			});
			this.suppressOwnMessage(session, result.postedMessageId);
		} catch (error) {
			this.logger.warn(`Could not post a turn summary: ${describeError(error)}`);
			return false;
		}

		// A turn is a sign of life exactly as a reply is, so it slides the idle window.
		session.lastActivityAt = this.now().toISOString();
		session.lastActivitySource = 'chat-turn';
		if (session.expiredAt) {
			session.expiredAt = undefined;
		}
		this.persist();
		return true;
	}

	/**
	 * Keeps a reply that could not be written anywhere, so a later pass can deliver it.
	 *
	 * Delivery refuses whenever the chat in front is not the reply's own, which is the
	 * common case while several chats are open. Without retention that refusal would
	 * destroy the instruction: it has already been marked seen, so no later poll would
	 * find it again in Teams.
	 */
	retain(routed: RoutedReply): void {
		this.hold(routed);
	}

	/** Drops a retained reply once something has actually acted on it. */
	release(sessionId: string, replyId: string): void {
		const session = this.getSession(sessionId);
		const remaining = (session?.pending ?? []).filter((held) => held.reply.id !== replyId);
		if (!session || remaining.length === (session.pending?.length ?? 0)) {
			return;
		}
		session.pending = remaining.length > 0 ? remaining : undefined;
		this.persist();
	}

	/**
	 * Offers every retained reply again.
	 *
	 * The chat a reply belongs to becomes reachable when the user moves to it, which is an
	 * event this bridge cannot observe. Retrying on each poll turns that into a delay of at
	 * most one interval rather than an instruction stuck until VS Code restarts.
	 */
	private async redeliverRetained(): Promise<void> {
		for (const session of this.sessions) {
			if (session.closed || session.expiredAt || !session.pending?.length) {
				continue;
			}
			for (const held of [...session.pending]) {
				await this.dispatch({
					session: { ...session },
					reply: held.reply,
					text: held.text,
					command: held.command
				});
			}
		}
	}

	private hold(routed: RoutedReply): void {
		const session = this.getSession(routed.session.id);
		if (!session) {
			return;
		}
		const pending = session.pending ?? [];
		if (pending.some((held) => held.reply.id === routed.reply.id)) {
			return;
		}
		pending.push({ reply: routed.reply, text: routed.text, command: routed.command });
		// Oldest first, so a thread nobody reads cannot grow without bound.
		session.pending = pending.slice(-MAX_UNDELIVERED);
		this.persist();
	}

	private ensureSession(key: string, title: string, sessionId?: string, chatValue?: string): Session {
		// An explicit id is unambiguous, so it always wins over key matching.
		if (sessionId) {
			const byId = this.sessions.find((session) => session.id === sessionId && !session.closed);
			if (byId) {
				return byId;
			}
		}

		// A chat is one conversation, whatever key the caller happened to use. The transcript
		// watcher opens a session for the chat under `chat-<uuid>`; a subsequent notify from
		// the model picks its own key. Matching the chat first — normalised through
		// asChatSessionResource so a legacy bare id and a full resource are the same chat —
		// keeps both under one session, so the Teams thread does not split in two.
		if (chatValue) {
			const normalisedChat = asChatSessionResource(chatValue);
			const byChat = this.sessions.find((session) => {
				if (session.closed) {
					return false;
				}
				const own = asChatSessionResource(
					session.identity?.chat?.kind === 'chat-session-resource' ? session.identity.chat.value : undefined
				) ?? asChatSessionResource(session.chatSessionResource);
				return own !== undefined && own === normalisedChat;
			});
			if (byChat) {
				if (normaliseKey(byChat.key) !== normaliseKey(key)) {
					// Diagnosable trail: a divergence between the caller's key and the owning
					// key means one chat is being addressed two ways, which is what caused
					// the split thread in the first place.
					this.logger.info(
						`Reusing session "${byChat.title}" (key "${byChat.key}") for chat notify under key "${key}"`
					);
				}
				return byChat;
			}
		}

		// Falling back to the key, matched loosely, because the model has no id to quote on
		// the first call and rarely repeats a key byte-for-byte afterwards.
		const normalised = normaliseKey(key);
		const existing = this.sessions.find((session) => normaliseKey(session.key) === normalised && !session.closed);
		if (existing) {
			return existing;
		}
		const timestamp = this.now().toISOString();
		const session: Session = {
			id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
			key,
			title,
			workspace: this.workspace,
			createdAt: timestamp,
			lastActivityAt: timestamp,
			seenReplyIds: [],
			status: 'progress'
		};
		this.sessions.push(session);
		// Keep the persisted registry small; old threads stay in Teams regardless.
		if (this.sessions.length > 100) {
			this.sessions = this.sessions.slice(-100);
		}
		return session;
	}

	/** The first non-empty line of a prompt, used to title a turn summary in Teams. */
	private firstPromptLine(prompt: string): string {
		const line = prompt.split('\n').map((entry) => entry.trim()).find(Boolean) ?? 'Continued';
		return line.length <= 90 ? line : `${line.slice(0, 89)}\u2026`;
	}

	/**
	 * Whether the model already told Teams about this turn itself.
	 *
	 * True when a notify call landed at or after the turn began: that call was made *during*
	 * the turn, so it is reporting this work rather than something earlier. Its wording is
	 * chosen by the model and knows what mattered, which no summary reconstructed from the
	 * transcript can match — so the automatic one gives way.
	 *
	 * A turn whose start time the editor did not record cannot be placed on that timeline,
	 * and is summarised rather than silently dropped: a missing update is worse than a
	 * duplicated one.
	 */
	private alreadyReported(session: Session, startedAt: number | undefined): boolean {
		if (!session.lastNotifyAt || !startedAt) {
			return false;
		}
		return Date.parse(session.lastNotifyAt) >= startedAt;
	}

	/**
	 * Sessions whose threads should be read on this poll.
	 *
	 * Idle time deliberately plays no part here: whether a session has lapsed is decided
	 * by expireIdleSessions after reading, so a reply that arrived during a quiet period
	 * is still delivered and revives the session.
	 */
	private activeSessions(): Session[] {
		return this.sessions.filter((session) => !session.closed && !session.expiredAt && session.thread !== undefined);
	}

	/**
	 * Sessions worth reading this tick.
	 *
	 * An expired thread is not read at all. Earlier this kept polling at a fraction of the
	 * rate, because a reply is proof somebody still wants the session and silently ignoring
	 * it was the worst failure this bridge had. That reasoning held only while the thread
	 * still *invited* a reply: now the expiry notice says replies will not reach Copilot and
	 * the footer says so on every message, the user is told before they type rather than
	 * after, and the session is revived from VS Code instead.
	 *
	 * Stopping dead is what keeps one quiet session from costing anything, while every other
	 * session keeps being read.
	 */
	private watchedSessions(): Session[] {
		if (this.expiredGraceMs <= 0) {
			return this.activeSessions();
		}
		// Retained for callers that deliberately opt into a grace period.
		const live = this.activeSessions();
		if (this.tick % EXPIRED_POLL_EVERY !== 0) {
			return live;
		}
		const cutoff = this.now().getTime() - this.expiredGraceMs;
		const lingering = this.sessions.filter(
			(session) =>
				!session.closed &&
				session.expiredAt !== undefined &&
				session.thread !== undefined &&
				Date.parse(session.expiredAt) >= cutoff
		);
		return [...live, ...lingering];
	}

	private markSeen(session: Session, id: string): void {
		session.seenReplyIds.push(id);
		if (session.seenReplyIds.length > MAX_SEEN_IDS) {
			session.seenReplyIds = session.seenReplyIds.slice(-MAX_SEEN_IDS);
		}
	}

	private advanceWatermark(session: Session, createdAt: string): void {
		const current = session.lastReplyAt ? Date.parse(session.lastReplyAt) : 0;
		const next = Date.parse(createdAt);
		if (!Number.isNaN(next) && next > current) {
			session.lastReplyAt = createdAt;
		}
	}

	private removeWaiter(sessionId: string, waiter: Waiter): void {
		const list = this.waiters.get(sessionId);
		if (!list) {
			return;
		}
		const index = list.indexOf(waiter);
		if (index >= 0) {
			list.splice(index, 1);
		}
		if (list.length === 0) {
			this.waiters.delete(sessionId);
		}
	}

	private persist(): void {
		void this.store.write(this.sessions.map((session) => ({ ...session })));
	}
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reduces a session key to a comparable form.
 *
 * Models are inconsistent about punctuation and casing between tool calls, and an exact
 * match would silently open a second Teams thread for the same task. Comparing on
 * lower-cased alphanumerics makes "Reserve API filter", "reserve-api-filter" and
 * "Reserve_API_Filter" the same session.
 */
export function normaliseKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Renders an idle window as text the user can read on their phone.
 *
 * Whole hours would round a one-minute test window down to "0 hours" and read as
 * "a while", which is what the owner hit while testing at sub-hour windows: the notice
 * could never state the real window. Under an hour is rendered in minutes so a short
 * window is truthful; hours-and-above is rendered in hours so a long one is not shouted
 * as thousands of minutes.
 */
export function formatIdleWindow(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) {
		return 'a moment';
	}
	if (ms < 60 * 60 * 1000) {
		const minutes = Math.max(1, Math.round(ms / 60_000));
		return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	}
	const hours = Math.max(1, Math.round(ms / 3_600_000));
	return `${hours} hour${hours === 1 ? '' : 's'}`;
}


