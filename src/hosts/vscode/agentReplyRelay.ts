import * as vscode from 'vscode';
import type { RoutedReply } from '../../application/bridge';
import type { DeliveryOutcome } from '../../application/services/harness';
import { identityOf, mayResolveByTranscript, worthRetrying } from '../../application/services/harness';
import { chatSessionResourceFromKey } from '../../domain/chatSessionLink';
import { isEmptyReply, parseReply } from '../../domain/messageFormat';
import { markDelivered } from '../../domain/policies/sessionMerge';
import type { InboundReply, PendingReply, Session, ThreadRef } from '../../domain/types';
import { noopDeliveredRepliesRegistry, type DeliveredRepliesRegistry } from '../../infrastructure/deliveredReplies';

export interface AgentReplyRelayDeps {
	/** The MCP server’s session file, shared with agent and CLI sessions. */
	storeUri: vscode.Uri;
	/**
	 * Hands a reply to a chat and reports what became of it.
	 *
	 * The outcome decides whether the reply may be consumed. A reply that could not be
	 * routed has not been acted on by anything, so consuming it destroys an instruction the
	 * user has already been told was received.
	 */
	deliver(routed: RoutedReply): Promise<DeliveryOutcome>;
	log: vscode.LogOutputChannel;
	intervalMs(): number;
	enabled(): boolean;
	/**
	 * Names the chat that started a session. Agent sessions have no chat recorded, because
	 * the MCP server runs outside VS Code, so without this a reply goes to whichever chat
	 * is focused — which is rarely the one that asked.
	 */
	resolveChatSession?(session: Session): Promise<string | undefined>;
	/**
	 * Reads new replies for a session the MCP server owns.
	 *
	 * The server polls its own threads, but it is spawned per tool call and exits, so for
	 * most of a session's life nothing is watching and a reply sits in Teams unread. The
	 * extension is alive whenever VS Code is, so it collects into the same queue the server
	 * fills and everything downstream — de-duplication, routing, delivery — is unchanged.
	 */
	fetchReplies?(thread: ThreadRef, sinceIso: string | undefined): Promise<InboundReply[]>;
	/**
	 * Claims a reply id across every process sharing the on-disk registry.
	 *
	 * Optional so tests can leave it unset and get the pre-registry behaviour; production
	 * wires the {@link JsonDeliveredRepliesRegistry} through so a reply the extension's
	 * own Bridge path already delivered is not delivered a second time here.
	 */
	deliveredReplies?: DeliveredRepliesRegistry;
	/**
	 * How long the MCP store's sessions may sit idle before this relay stops reading them.
	 *
	 * The extension Bridge expires its own sessions after this window; the relay owns a
	 * second store (the MCP server's sessions.json) and without an idle check here that
	 * store is polled forever, so a reply typed hours after the user walked away still
	 * lands in a chat. Matching the same window keeps both stores under one rule.
	 *
	 * Optional so tests that predate the check keep their existing behaviour; production
	 * wires config.sessionIdleMs. Non-positive values disable the check.
	 */
	idleMs?(): number;
	/**
	 * Called once when this relay expires a session, so the user is told in Teams.
	 *
	 * Reused from Bridge.postExpiryNotice: the two stores are separate, but the notice the
	 * user reads must be the same for either — otherwise an agent-session lifecycle looks
	 * different from a sidebar-session lifecycle. Optional so tests may leave it unset;
	 * production wires bridge.postExpiryNotice.
	 */
	onExpired?(session: Session): void | Promise<void>;
}

/**
 * Passes to spend identifying a reply's chat before giving up and using the focused one.
 *
 * The transcript that names the chat is written when the turn ends, so a reply that beats
 * it needs a moment. A few passes covers that without stranding a reply whose chat has
 * genuinely gone, such as a conversation the user deleted.
 */
const RESOLVE_ATTEMPTS = 3;

/** The later of two timestamps, so a clock skew in one reply cannot rewind the watermark. */
function newest(current: string | undefined, candidate: string): string {
	return !current || candidate > current ? candidate : current;
}

/**
 * Delivers replies that an agent session collected but cannot act on.
 *
 * The MCP server has no way to wake an agent whose turn has ended: nothing in the protocol
 * lets a server push, so a reply sat in its queue until the user came back and typed
 * something. That defeats the point of replying from a phone.
 *
 * The extension has the one capability the server lacks — it can open a chat request — and
 * it is running the whole time VS Code is. So it watches the server’s store and delivers on
 * its behalf, giving agent sessions the same hands-off behaviour the sidebar already had.
 */
export class AgentReplyRelay {
	private timer: NodeJS.Timeout | undefined;
	private watcher: vscode.FileSystemWatcher | undefined;
	private running = false;
	/** Passes spent trying to identify a reply's chat, by reply id. */
	private readonly attempts = new Map<string, number>();

	/** Sessions whose thread could not be read, so the failure is only logged once. */
	private readonly failing = new Set<string>();

	/** The registry that decides which process delivers a given reply id first. */
	private readonly claims: DeliveredRepliesRegistry;

	/**
	 * Ids of sessions whose expiry notice has already fired this process lifetime.
	 *
	 * Persisting `expiredAt` in the store keeps the state visible across polls, but this
	 * memory guard is what prevents the notice being re-fired for a session that appears
	 * newly-expired on this pass. Without it, a race — expire, notify, another process
	 * writes the same session back without expiredAt — would fire the notice twice; the
	 * store already ignores repeat writes, so this set stays authoritative for firing.
	 */
	private readonly notified = new Set<string>();

	/**
	 * Session ids for which the "chat identified" log line has already fired this process
	 * lifetime, so the upgrade is diagnosable but the log is not flooded.
	 */
	private readonly upgraded = new Set<string>();

	/**
	 * Reply ids for which the "chat could not be identified" conclusion has already been
	 * logged this process lifetime.
	 *
	 * Without this the warning fires every poll — every ten seconds by default — for as
	 * long as the reply is retained, which for an agent/CLI session with no VS Code chat
	 * is forever. The user reported watching it repeat indefinitely; the fix is to log the
	 * conclusion the same way the "upgraded" set logs its own: once per reply, not once
	 * per pass.
	 */
	private readonly unidentifiedLogged = new Set<string>();

	/**
	 * Reply ids parked because no chat can ever be identified for them from this window.
	 *
	 * After the resolution passes are exhausted, an "unroutable" outcome from a session
	 * with no chatSessionResource proves the delivery attempt cannot succeed until the
	 * session gains one. Re-attempting on every poll only re-runs the same failure and
	 * re-logs the same warning, so a parked reply stays in `pending` — the queue an agent
	 * collects from via teams_check_replies — but is not handed to `deliver` again.
	 *
	 * Un-parked automatically when the session gains a chatSessionResource, so a chat the
	 * user later opens (or an identity that a concurrent process later persists) makes the
	 * reply deliverable again.
	 */
	private readonly parked = new Set<string>();

	constructor(private readonly deps: AgentReplyRelayDeps) {
		this.claims = deps.deliveredReplies ?? noopDeliveredRepliesRegistry;
	}

	start(): void {
		if (this.timer) {
			return;
		}
		// Watched for promptness and polled as a backstop, because a file written by another
		// process does not always raise an event.
		this.watcher = vscode.workspace.createFileSystemWatcher(this.deps.storeUri.fsPath, true, false, true);
		this.watcher.onDidChange(() => void this.drain());
		this.timer = setInterval(() => void this.drain(), this.deps.intervalMs());
		void this.drain();
		this.deps.log.info(`Relaying agent-session replies from ${this.deps.storeUri.fsPath}`);
	}

	/** Hands every queued reply to Copilot Chat, then clears it from the store. */
	async drain(): Promise<void> {
		if (this.running || !this.deps.enabled()) {
			return;
		}
		this.running = true;
		try {
			// Expire idle sessions BEFORE anything else in this pass so the collect step
			// does not fetch replies for a session that has just gone quiet, and the
			// dispatch step below does not deliver a reply that arrived in the same window.
			await this.expireIdleSessions();
			await this.collect();
			const sessions = await this.read();
			const waiting = sessions.filter(
				(session) => (session.pending?.length ?? 0) > 0 && !session.closed && !session.expiredAt
			);
			if (waiting.length === 0) {
				return;
			}

			/** Replies handed over this pass, so only those are cleared. */
			const taken = new Map<string, Set<string>>();

			for (const session of waiting) {
				const addressed = await this.addressed(session);
				// A session that has since gained a chatSessionResource can be tried again:
				// the user may have opened the chat, or the identity may have been persisted
				// by a concurrent writer, so any parked reply for it deserves another pass.
				if (addressed.chatSessionResource) {
					for (const held of session.pending ?? []) {
						if (this.parked.delete(held.reply.id)) {
							this.deps.log.info(
								`Un-parked a Teams reply for "${session.title}"; its chat is now on record.`
							);
						}
					}
				}
				for (const held of session.pending ?? []) {
					// Both processes can queue, so a reply already handed over is dropped rather
					// than delivered a second time.
					if (session.deliveredReplyIds?.includes(held.reply.id)) {
						const ids = taken.get(session.id) ?? new Set<string>();
						ids.add(held.reply.id);
						taken.set(session.id, ids);
						continue;
					}
					// A reply the other delivery path already claimed must not be dispatched
					// again — the extension's Bridge path (handOver) is the atomic claim
					// site, so an advisory `has()` check here is enough to skip the
					// dispatch without injecting and without posting a failure notice. This
					// stays ahead of the park check so a claimed-elsewhere reply is still
					// consumed rather than being left in pending forever.
					if (this.claims.has(held.reply.id)) {
						this.deps.log.info(
							`Teams reply ${held.reply.id} for "${session.title}" was already delivered by the other bridge path; consuming here.`
						);
						this.attempts.delete(held.reply.id);
						this.parked.delete(held.reply.id);
						const ids = taken.get(session.id) ?? new Set<string>();
						ids.add(held.reply.id);
						taken.set(session.id, ids);
						continue;
					}
					// A parked reply is one an earlier pass already tried, found unroutable,
					// and cannot resolve a chat for from this window. Retrying would only
					// re-run the same failure and re-log the same warning, so it stays in
					// pending — where an agent still collects it via teams_check_replies —
					// but the deliver call is skipped until the session gains a chat above.
					if (this.parked.has(held.reply.id)) {
						continue;
					}
					if (!addressed.chatSessionResource && this.worthWaitingFor(held, session)) {
						continue;
					}
					const outcome = await this.deliver(addressed, held);
					if (worthRetrying(outcome, identityOf(session))) {
						// Nothing acted on it, so consuming it would destroy the instruction:
						// clear() records a consumed id as delivered, and that tombstone is
						// permanent, so it would not be retried even once the chat is known.
						// If the resolution passes are already exhausted and the session
						// still has no chat, no future pass can deliver it from this window
						// either — so park it, leaving it in pending for the agent to collect
						// while sparing the log and Teams thread the repeated failure.
						if (outcome === 'unroutable' && !addressed.chatSessionResource) {
							this.parked.add(held.reply.id);
						}
						continue;
					}
					this.attempts.delete(held.reply.id);
					this.parked.delete(held.reply.id);
					const ids = taken.get(session.id) ?? new Set<string>();
					ids.add(held.reply.id);
					taken.set(session.id, ids);
				}
			}

			await this.clear(taken);
		} catch (error) {
			this.deps.log.warn(`Could not relay agent-session replies: ${String(error)}`);
		} finally {
			this.running = false;
		}
	}

	/**
	 * Marks sessions that have gone quiet in the MCP store as expired, and tells the user.
	 *
	 * Mirrors Bridge.expireIdleSessions for the second store this relay owns: without it,
	 * an agent/CLI session recorded in ~/.copilot-teams-bridge/sessions.json is polled
	 * forever, so a reply typed hours after the user walked away still reaches a chat.
	 * Once expired, the session's queued pending replies are dropped so nothing that was
	 * queued while it was actively being expired is later delivered by mistake.
	 *
	 * Expiring and announcing are two steps, not one, because they fail independently.
	 * Marking is a local write and effectively cannot fail; the notice is a network call to
	 * Teams. Expiry is most likely to be detected on the first poll after the editor starts
	 * or the machine wakes — precisely when the transport is least likely to be up. Doing
	 * both in one pass meant a failed post was lost for good: `expiredAt` was already
	 * persisted, so the session never appeared in the expiring set again, and the thread was
	 * left silently unwatched while still inviting a reply. Announcing is therefore driven
	 * by `expiryNoticeAt` and retried every pass until it lands.
	 */
	private async expireIdleSessions(): Promise<void> {
		const idleMs = this.deps.idleMs?.();
		if (!idleMs || idleMs <= 0) {
			return;
		}
		const cutoff = Date.now() - idleMs;
		const sessions = await this.read();
		const expiring = sessions.filter(
			(session) =>
				!session.closed &&
				!session.expiredAt &&
				session.thread !== undefined &&
				session.lastActivityAt !== undefined &&
				Date.parse(session.lastActivityAt) < cutoff
		);
		if (expiring.length > 0) {
			const timestamp = new Date().toISOString();
			for (const session of expiring) {
				session.expiredAt = timestamp;
				// Anything queued in the meantime must be dropped, or an instruction the user
				// posted just before the window lapsed would be delivered into a chat that has
				// been told the thread is no longer being read.
				session.pending = undefined;
				this.deps.log.info(`Agent session "${session.title}" expired after going quiet`);
			}
			await this.write(sessions);
		}

		await this.announceExpiry();
	}

	/**
	 * Posts the pause notice for any expired session that has not had one delivered.
	 *
	 * Runs every pass, so a notice that could not be posted when the session expired — a
	 * dead transport, a lapsed Agency session — is sent as soon as Teams is reachable again
	 * rather than being dropped. `expiryNoticeAt` is written only after the post resolves,
	 * which is what makes the retry terminate exactly once the user has been told.
	 */
	private async announceExpiry(): Promise<void> {
		if (!this.deps.onExpired) {
			return;
		}
		const sessions = await this.read();
		const owed = sessions.filter(
			(session) => session.expiredAt !== undefined && !session.expiryNoticeAt && !session.closed
		);
		if (owed.length === 0) {
			return;
		}

		const delivered: string[] = [];
		for (const session of owed) {
			try {
				await this.deps.onExpired({ ...session });
				delivered.push(session.id);
			} catch (error) {
				// Deliberately not marked: the next pass tries again. Logged once per
				// session per process so a persistently unreachable thread cannot bury
				// everything else in the log.
				if (!this.notified.has(session.id)) {
					this.notified.add(session.id);
					this.deps.log.warn(
						`Could not post the expiry notice for "${session.title}" yet; will retry: ${String(error)}`
					);
				}
			}
		}
		if (delivered.length === 0) {
			return;
		}

		// Re-read rather than reusing the list above: posting is slow, and another process
		// may have revived a session in the meantime. Reviving clears expiredAt, and
		// stamping a notice onto a session that is listening again would suppress the
		// notice it is owed the *next* time it goes quiet.
		const latest = await this.read();
		const timestamp = new Date().toISOString();
		let changed = false;
		for (const session of latest) {
			if (delivered.includes(session.id) && session.expiredAt && !session.expiryNoticeAt) {
				session.expiryNoticeAt = timestamp;
				this.notified.delete(session.id);
				changed = true;
			}
		}
		if (changed) {
			await this.write(latest);
		}
	}

	/**
	 * Reactivates the matching session in the MCP store when a chat turn or the extend
	 * command revives it in VS Code.
	 *
	 * Bridge.recordActivity already handles the extension's own memento store; this handles
	 * the second, on-disk store the MCP server also writes. Match is by session key or by
	 * the chat resource embedded in a `chat-<uuid>` key, using the same helper the
	 * delivery path uses so no new rules for matching are introduced here.
	 *
	 * Advances the reply watermark to *now* rather than merely clearing expiredAt: the
	 * user was told that anything posted while paused is discarded, so honouring a reply
	 * that arrived during the paused window would contradict what they were told.
	 *
	 * Returns true when a session was reactivated, so a caller can post its own resumed
	 * notice.
	 */
	async reactivate(sessionKey: string): Promise<Session | undefined> {
		const sessions = await this.read();
		const wanted = this.matchers(sessionKey);
		let changed = false;
		let revived: Session | undefined;
		for (const session of sessions) {
			if (session.closed || !this.matches(session, wanted)) {
				continue;
			}
			const timestamp = new Date().toISOString();
			if (session.expiredAt) {
				session.expiredAt = undefined;
				// The session is listening again, so the notice it was owed is spent.
				// Clearing it means the *next* time it goes quiet it is announced afresh
				// rather than being treated as already told.
				session.expiryNoticeAt = undefined;
				// The user was told replies posted while paused are ignored, so advance the
				// watermark to now: any reply older than that is permanently skipped.
				session.lastReplyAt = timestamp;
				// And drop anything queued while it was expired, for the same reason.
				session.pending = undefined;
				revived = { ...session };
				this.notified.delete(session.id);
				this.deps.log.info(
					`Agent session "${session.title}" reactivated; skipping any replies posted while it was paused`
				);
			}
			session.lastActivityAt = timestamp;
			changed = true;
		}
		if (changed) {
			await this.write(sessions);
		}
		return revived;
	}

	/**
	 * Every key form a session could match by.
	 *
	 * `chatSessionResourceFromKey` is reused so an extension side that knows a session by
	 * its `chat-<uuid>` key still matches an MCP-store entry whose key was recorded as the
	 * bare resource, and vice versa.
	 */
	private matchers(sessionKey: string): Set<string> {
		const set = new Set<string>();
		if (sessionKey) {
			set.add(sessionKey);
			const resource = chatSessionResourceFromKey(sessionKey);
			if (resource) {
				set.add(resource);
			}
		}
		return set;
	}

	private matches(session: Session, wanted: Set<string>): boolean {
		if (wanted.has(session.key)) {
			return true;
		}
		const resource = chatSessionResourceFromKey(session.key);
		return resource !== undefined && wanted.has(resource);
	}

	/**
	 * Reads the MCP server's threads on its behalf and queues anything new.
	 *
	 * Collecting into pending rather than delivering directly is deliberate: it is the
	 * same queue the server writes, so de-duplication, chat resolution and the delivered-id
	 * tombstones all apply exactly as they already did. Whether the server or the extension
	 * did the reading stops mattering anywhere downstream.
	 */
	private async collect(): Promise<void> {
		const fetch = this.deps.fetchReplies;
		if (!fetch) {
			return;
		}

		const found = new Map<string, InboundReply[]>();
		for (const session of await this.read()) {
			if (session.closed || session.expiredAt || !session.thread) {
				continue;
			}
			try {
				const replies = await fetch(session.thread, session.lastReplyAt);
				this.failing.delete(session.id);
				if (replies.length > 0) {
					found.set(session.id, replies);
				}
			} catch (error) {
				// A thread that has gone for good would otherwise repeat its failure every
				// few seconds and bury everything else in the log.
				const message = `Could not read the Teams thread for "${session.title}": ${String(error)}`;
				if (this.failing.has(session.id)) {
					this.deps.log.debug(message);
				} else {
					this.failing.add(session.id);
					this.deps.log.warn(message);
				}
			}
		}

		if (found.size === 0) {
			return;
		}

		// Re-read so replies the server queued while this was fetching are not written over.
		const current = await this.read();
		let changed = false;
		for (const session of current) {
			for (const reply of found.get(session.id) ?? []) {
				if (this.alreadyKnown(session, reply)) {
					continue;
				}
				// Recorded before any decision to skip it, so an unusable reply is not read
				// again on every pass for as long as the session lives.
				session.seenReplyIds = [...(session.seenReplyIds ?? []), reply.id].slice(-100);
				session.lastReplyAt = newest(session.lastReplyAt, reply.createdAt);
				changed = true;
				if (isEmptyReply(reply.text)) {
					continue;
				}
				const parsed = parseReply(reply.text);
				session.pending = [...(session.pending ?? []), { reply, text: parsed.text, command: parsed.command }];
				this.deps.log.info(`Read a Teams reply for agent session "${session.title}" the MCP server was not running to collect`);
			}
		}

		if (changed) {
			await this.write(current);
		}
	}

	/** Whether this reply has already been read or handed over by either process. */
	private alreadyKnown(session: Session, reply: InboundReply): boolean {
		return Boolean(
			session.seenReplyIds?.includes(reply.id) || session.deliveredReplyIds?.includes(reply.id)
		);
	}

	private async deliver(session: Session, held: PendingReply): Promise<DeliveryOutcome> {
		this.deps.log.info(`Relaying a Teams reply for agent session "${session.title}"`);
		return this.deps.deliver({
			session: await this.addressed(session),
			reply: held.reply,
			text: held.text,
			command: held.command
		});
	}

	/**
	 * Fills in the chat that started the session, when it can be found.
	 *
	 * Left alone when it cannot: the injector says so in the request it delivers, which is
	 * honest about the uncertainty rather than letting one task's instruction be read as
	 * another's.
	 */
	private async addressed(session: Session): Promise<Session> {
		if (session.chatSessionResource) {
			return session;
		}
		// The session key may itself name the chat that started the work — the transcript
		// watcher mints keys as `chat-<uuid>` — so a bridge-created session that reached
		// this relay without a chatSessionResource can be routed exactly rather than held.
		// Preferred over the transcript search below because it needs no I/O and cannot
		// misidentify: the key is what the watcher wrote when the chat first announced.
		const fromKey = chatSessionResourceFromKey(session.key);
		if (fromKey) {
			await this.persistChatResource(session.id, fromKey);
			return { ...session, chatSessionResource: fromKey };
		}
		if (!this.deps.resolveChatSession) {
			return session;
		}
		// A search can only match a transcript some *other* conversation wrote, so for a
		// harness that keeps none it is not a weaker answer — it is a wrong one.
		if (!mayResolveByTranscript(identityOf(session))) {
			return session;
		}
		const resource = await this.deps.resolveChatSession(session);
		if (!resource) {
			return session;
		}
		await this.persistChatResource(session.id, resource);
		return { ...session, chatSessionResource: resource };
	}

	/**
	 * Writes a newly-identified chat resource back into the MCP store.
	 *
	 * Without this every later notification for the same session would keep saying "replies
	 * here will not reach Copilot", because identityOf() sees no chat and reports
	 * "unknown". Uses the same read-merge-write approach as collect() so a concurrent
	 * writer is not clobbered, only writes when the value actually changes, and never
	 * overwrites an existing chatSessionResource — a resource the MCP server or transcript
	 * watcher recorded is authoritative and must not be second-guessed here.
	 */
	private async persistChatResource(sessionId: string, resource: string): Promise<void> {
		const current = await this.read();
		let changed = false;
		let upgraded: Session | undefined;
		for (const entry of current) {
			if (entry.id !== sessionId) {
				continue;
			}
			if (entry.chatSessionResource) {
				// Something else got there first — never overwrite what the store already has.
				return;
			}
			entry.chatSessionResource = resource;
			changed = true;
			upgraded = entry;
			break;
		}
		if (!changed) {
			return;
		}
		await this.write(current);
		if (upgraded && !this.upgraded.has(sessionId)) {
			this.upgraded.add(sessionId);
			this.deps.log.info(
				`Identified the chat for agent session "${upgraded.title}"; later notifications can invite replies again`
			);
		}
	}

	/**
	 * Whether to leave a reply queued in the hope of identifying its chat.
	 *
	 * VS Code writes a chat's transcript when the turn ends, so a reply that arrives in the
	 * moments before that cannot be matched yet. Delivering it then would send it to the
	 * focused chat — the very fault this avoids — so it waits a few passes first. A late
	 * reply costs seconds; one delivered into another task's context costs both tasks.
	 */
	private worthWaitingFor(held: PendingReply, session: Session): boolean {
		const tried = (this.attempts.get(held.reply.id) ?? 0) + 1;
		this.attempts.set(held.reply.id, tried);

		if (tried > RESOLVE_ATTEMPTS) {
			// Logged once per reply id, not once per pass: an agent/CLI session has no
			// VS Code chat to identify, so this conclusion is reached on every poll and
			// the log would otherwise repeat forever. The wording was also wrong — the
			// reply is not delivered to the focused chat, HoldAdapter refuses and it stays
			// queued for the agent that started the session.
			if (!this.unidentifiedLogged.has(held.reply.id)) {
				this.unidentifiedLogged.add(held.reply.id);
				this.deps.log.warn(
					`Could not identify the chat for "${session.title}"; leaving the reply queued for the agent that started this session rather than writing it into an unrelated chat.`
				);
			}
			return false;
		}
		this.deps.log.debug(`Holding a reply for "${session.title}" until its chat is known (${tried}).`);
		return true;
	}

	/**
	 * Records the delivered replies as delivered and drops them from the queue.
	 *
	 * The MCP server owns this file and may have written to it while the replies were being
	 * delivered, so the current contents are edited rather than an older copy written back.
	 * Removing them is not enough on its own: the server still holds them in memory and
	 * would restore them on its next write, which injected the same instruction into chat
	 * every few seconds. Recording the ids lets that stale write be reconciled instead.
	 */
	private async clear(taken: Map<string, Set<string>>): Promise<void> {
		if (taken.size === 0) {
			return;
		}
		const current = await this.read();
		let changed = false;

		for (const session of current) {
			const ids = taken.get(session.id);
			if (!ids?.size) {
				continue;
			}
			session.deliveredReplyIds = markDelivered(session, [...ids]);
			const remaining = (session.pending ?? []).filter((held) => !ids.has(held.reply.id));
			session.pending = remaining.length > 0 ? remaining : undefined;
			changed = true;
		}

		if (!changed) {
			return;
		}
		await this.write(current);
	}

	private async write(sessions: Session[]): Promise<void> {
		await vscode.workspace.fs.writeFile(
			this.deps.storeUri,
			Buffer.from(JSON.stringify(sessions, null, 2), 'utf8')
		);
	}

	private async read(): Promise<Session[]> {
		try {
			const bytes = await vscode.workspace.fs.readFile(this.deps.storeUri);
			const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
			return Array.isArray(parsed) ? (parsed as Session[]) : [];
		} catch {
			// No agent session has ever run, which is the normal case for many users.
			return [];
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.watcher?.dispose();
		this.watcher = undefined;
	}
}
