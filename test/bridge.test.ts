import { InMemorySessionStore } from '../src/application/ports';
import * as assert from 'assert';
import { describe, it } from 'node:test';
import { Bridge } from '../src/application/bridge';
import { type ThreadedTransport } from '../src/application/ports';
import { type InboundReply, type OutboundNotification, type PostResult, type SessionIdentity, type ThreadRef } from '../src/domain/types';

/** Scriptable transport that records posts and serves queued replies. */
class FakeTransport implements ThreadedTransport {
	readonly kind = 'file' as const;
	posts: { thread?: string; notification: OutboundNotification }[] = [];
	created = 0;
	fetches = 0;
	private queued: InboundReply[] = [];
	readonly ownMessageIds: string[] = [];
	private counter = 0;

	constructor(readonly supportsReplies = true) {}

	async createThread(notification: OutboundNotification): Promise<PostResult> {
		this.created++;
		this.posts.push({ notification });
		return { thread: { id: `t${this.created}` }, postedMessageId: `own-${this.counter++}` };
	}

	async postToThread(thread: ThreadRef, notification: OutboundNotification): Promise<PostResult> {
		this.posts.push({ thread: thread.id, notification });
		const id = `own-${this.counter++}`;
		this.ownMessageIds.push(id);
		return { thread, postedMessageId: id };
	}

	async fetchReplies(thread: ThreadRef, sinceIso: string | undefined): Promise<InboundReply[]> {
		this.fetches++;
		const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
		return this.queued.filter((reply) => reply.threadId === thread.id && Date.parse(reply.createdAt) > sinceMs);
	}

	queue(reply: Partial<InboundReply> & { threadId: string }): void {
		this.queued.push({
			id: reply.id ?? `r${this.queued.length}`,
			threadId: reply.threadId,
			text: reply.text ?? 'hello',
			from: reply.from ?? 'Tester',
			createdAt: reply.createdAt ?? new Date(Date.now() + 60_000 * (this.queued.length + 1)).toISOString()
		});
	}
}

function makeBridge(transport: ThreadedTransport): Bridge {
	return new Bridge({
		transport,
		store: new InMemorySessionStore(),
		pollIntervalMs: 10_000,
		// Timers are driven manually so tests stay deterministic.
		setTimer: () => 1,
		clearTimer: () => undefined
	});
}

const notification = { sessionKey: 'task-a', title: 'Task A', summary: 'done', status: 'completed' as const };

describe('Bridge.notify', () => {
	it('creates a thread on first notify and reuses it afterwards', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		const first = await bridge.notify(notification);
		const second = await bridge.notify({ ...notification, summary: 'more work' });

		assert.strictEqual(transport.created, 1);
		assert.strictEqual(first.session.id, second.session.id);
		assert.strictEqual(second.session.thread?.id, 't1');
		assert.strictEqual(transport.posts.length, 2);
	});

	it('routes by session id when one is supplied', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const first = await bridge.notify(notification);

		// An id is exact, so it wins even when the key says something entirely different.
		const second = await bridge.notify({
			...notification,
			sessionId: first.session.id,
			sessionKey: 'a completely unrelated key'
		});

		assert.strictEqual(transport.created, 1);
		assert.strictEqual(second.session.id, first.session.id);
	});

	it('falls back to the key when the id is unknown', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const first = await bridge.notify(notification);

		// A stale id from an earlier machine must not strand the update in a new thread.
		const second = await bridge.notify({ ...notification, sessionId: 'no-longer-exists' });

		assert.strictEqual(transport.created, 1);
		assert.strictEqual(second.session.id, first.session.id);
	});

	it('treats punctuation and casing variants of a key as one session', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		// A model rarely repeats a key byte-for-byte across calls; without normalisation
		// each variant would open its own Teams thread for the same task.
		const first = await bridge.notify({ ...notification, sessionKey: 'Reserve API filter' });
		const second = await bridge.notify({ ...notification, sessionKey: 'reserve-api-filter' });
		const third = await bridge.notify({ ...notification, sessionKey: 'Reserve_API_Filter' });

		assert.strictEqual(transport.created, 1, 'all three must share one thread');
		assert.strictEqual(first.session.id, second.session.id);
		assert.strictEqual(second.session.id, third.session.id);
	});

	it('still separates genuinely different tasks', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		await bridge.notify({ ...notification, sessionKey: 'reserve-api-filter' });
		await bridge.notify({ ...notification, sessionKey: 'suggestion-job-retry' });

		assert.strictEqual(transport.created, 2, 'unrelated work must not be merged');
	});

	it('creates separate threads for different session keys', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		const a = await bridge.notify(notification);
		const b = await bridge.notify({ ...notification, sessionKey: 'task-b', title: 'Task B' });

		assert.strictEqual(transport.created, 2);
		assert.notStrictEqual(a.session.id, b.session.id);
	});

	it('keeps the session open after a completed notification', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify({ ...notification, status: 'completed' });

		// Reporting completion means "this piece of work is done", not "stop listening":
		// a follow-up reply must still reach the same session.
		assert.strictEqual(bridge.getSession(posted.session.id)?.closed, false);

		transport.queue({ threadId: 't1', text: 'now also add logging' });
		const routed = await bridge.poll();

		assert.strictEqual(routed.length, 1);
		assert.strictEqual(routed[0].session.id, posted.session.id, 'the reply must continue the same session');
		assert.strictEqual(routed[0].session.key, 'task-a');
	});

	it('reuses the same thread for follow-up work after completion', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify({ ...notification, status: 'completed' });

		await bridge.notify({ ...notification, status: 'progress', summary: 'picking the work back up' });

		assert.strictEqual(transport.created, 1, 'a follow-up must not start a second thread');
		assert.strictEqual(transport.posts.length, 2);
	});

	it('reports when the transport cannot receive replies', async () => {
		const bridge = makeBridge(new FakeTransport(false));
		const result = await bridge.notify(notification);
		assert.strictEqual(result.repliesSupported, false);
	});
});

describe('Bridge.poll', () => {
	it('routes a reply to the owning session', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		transport.queue({ threadId: 't1', text: 'now add logging' });

		const routed = await bridge.poll();

		assert.strictEqual(routed.length, 1);
		assert.strictEqual(routed[0].text, 'now add logging');
		assert.strictEqual(routed[0].session.id, posted.session.id);
	});

	it('does not deliver the same reply twice', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		transport.queue({ threadId: 't1', id: 'dup', text: 'once' });

		assert.strictEqual((await bridge.poll()).length, 1);
		assert.strictEqual((await bridge.poll()).length, 0);
	});

	it('ignores the bridge\'s own posted messages', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		// Simulates Graph echoing back the message the bridge just posted.
		transport.queue({ threadId: 't1', id: 'own-0', text: 'copilot output' });

		assert.strictEqual((await bridge.poll()).length, 0);
	});

	it('skips empty replies', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		transport.queue({ threadId: 't1', text: '   ' });

		assert.strictEqual((await bridge.poll()).length, 0);
	});

	it('closes a session when the user replies /stop', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		transport.queue({ threadId: 't1', text: '/stop' });

		const routed = await bridge.poll();

		assert.strictEqual(routed[0].command, 'stop');
		assert.strictEqual(bridge.getSession(posted.session.id)?.closed, true);
	});

	it('keeps polling isolated per session', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		await bridge.notify({ ...notification, sessionKey: 'task-b', title: 'Task B' });
		transport.queue({ threadId: 't2', text: 'for B only' });

		const routed = await bridge.poll();

		assert.strictEqual(routed.length, 1);
		assert.strictEqual(routed[0].session.key, 'task-b');
	});

	it('invokes registered reply handlers', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		transport.queue({ threadId: 't1', text: 'handled' });

		const seen: string[] = [];
		bridge.onReply((routed) => {
			seen.push(routed.text);
		});
		await bridge.poll();

		assert.deepStrictEqual(seen, ['handled']);
	});
});

describe('Bridge.waitForReply', () => {
	it('resolves with the reply that arrives in the waiting session', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		transport.queue({ threadId: 't1', text: 'use Dapper' });

		const routed = await bridge.waitForReply(posted.session.id, 5_000);

		assert.ok(routed);
		assert.strictEqual(routed?.text, 'use Dapper');
	});

	it('gives the reply to the waiter instead of the generic handler', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		const handled: string[] = [];
		bridge.onReply((routed) => {
			handled.push(routed.text);
		});
		transport.queue({ threadId: 't1', text: 'answer' });

		const routed = await bridge.waitForReply(posted.session.id, 5_000);

		assert.strictEqual(routed?.text, 'answer');
		assert.deepStrictEqual(handled, []);
	});

	it('returns undefined immediately when replies are unsupported', async () => {
		const bridge = makeBridge(new FakeTransport(false));
		const posted = await bridge.notify(notification);
		assert.strictEqual(await bridge.waitForReply(posted.session.id, 5_000), undefined);
	});
});

describe('Bridge session expiry', () => {
	function makeExpiringBridge(transport: FakeTransport, idleMs: number, clock: { now: number }): Bridge {
		return new Bridge({
			transport,
			store: new InMemorySessionStore(),
			sessionIdleMs: idleMs,
			now: () => new Date(clock.now),
			setTimer: () => 1,
			clearTimer: () => undefined
		});
	}

	it('expires a session that has gone quiet and notifies handlers once', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		const expired: string[] = [];
		bridge.onSessionExpired((session) => {
			expired.push(session.id);
		});

		clock.now += 61_000;
		await bridge.poll();
		await bridge.poll();

		assert.deepStrictEqual(expired, [posted.session.id], 'the warning must fire exactly once');
		assert.ok(bridge.getSession(posted.session.id)?.expiredAt);
	});

	it('stops reading replies once expired', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		await bridge.notify(notification);

		clock.now += 61_000;
		await bridge.poll();
		transport.queue({ threadId: 't1', text: 'this arrives too late' });
		const routed = await bridge.poll();

		assert.strictEqual(routed.length, 0, 'an expired thread must not be read');
	});

	it('resumes reading after the session is extended, and skips replies posted while it was expired', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		clock.now += 61_000;
		await bridge.poll();

		// Posted while the session was expired. With the default (grace 0) it was never
		// fetched, and reactivating the session must not go back and pick it up: the user
		// was told replies would not reach Copilot, so honouring that reply now would
		// contradict what they were told.
		const whileExpiredAt = new Date(clock.now).toISOString();
		transport.queue({ threadId: 't1', text: 'while expired', createdAt: whileExpiredAt });

		clock.now += 1_000;
		const extended = bridge.extendSession(posted.session.id);
		assert.ok(extended);
		assert.strictEqual(extended?.expiredAt, undefined);

		// Only replies posted after reactivation count.
		clock.now += 1_000;
		transport.queue({
			threadId: 't1',
			text: 'picked up after extending',
			createdAt: new Date(clock.now).toISOString()
		});

		const routed = await bridge.poll();
		assert.deepStrictEqual(
			routed.map((entry) => entry.text),
			['picked up after extending'],
			'only replies posted after extension are delivered'
		);
	});

	it('lists expired sessions so they can be offered for extension', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		await bridge.notify(notification);

		assert.strictEqual(bridge.listExpiredSessions().length, 0);
		clock.now += 61_000;
		await bridge.poll();

		assert.strictEqual(bridge.listExpiredSessions().length, 1);
	});

	it('slides the window on every reply rather than expiring from session start', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		// Two replies, each arriving just before the window would lapse. If the window ran
		// from session start the session would be long expired by the end of this.
		for (const text of ['first follow-up', 'second follow-up']) {
			clock.now += 50_000;
			transport.queue({ threadId: 't1', text, createdAt: new Date(clock.now).toISOString() });
			const routed = await bridge.poll();
			assert.strictEqual(routed.length, 1, `"${text}" should have been read`);
		}

		clock.now += 50_000;
		await bridge.poll();

		// 150s have passed in total against a 60s window, but never 60s without activity.
		assert.strictEqual(bridge.getSession(posted.session.id)?.expiredAt, undefined);
	});

	it('slides the window when Copilot reports progress', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		clock.now += 50_000;
		await bridge.notify({ ...notification, status: 'progress', summary: 'still working' });
		clock.now += 50_000;
		await bridge.poll();

		assert.strictEqual(bridge.getSession(posted.session.id)?.expiredAt, undefined);
	});

	it('expires only after a full quiet window with no activity at all', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		clock.now += 50_000;
		transport.queue({ threadId: 't1', text: 'keeps it alive', createdAt: new Date(clock.now).toISOString() });
		await bridge.poll();

		assert.strictEqual(bridge.getSession(posted.session.id)?.expiredAt, undefined);

		clock.now += 61_000;
		await bridge.poll();

		assert.ok(bridge.getSession(posted.session.id)?.expiredAt, 'a full quiet window must expire it');
	});

	it('never reads its own expiry and resume notices back as replies', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		clock.now += 61_000;
		await bridge.poll();

		// The transport echoes back everything in the thread, including the bridge's own
		// posts. Without suppression these would be routed to Copilot as instructions.
		const expiredSession = bridge.getSession(posted.session.id) as NonNullable<ReturnType<Bridge['getSession']>>;
		await bridge.postExpiryNotice(expiredSession, 60_000);
		const extended = bridge.extendSession(posted.session.id);
		assert.ok(extended);
		await bridge.postResumedNotice(extended);

		for (const own of transport.ownMessageIds) {
			transport.queue({ threadId: 't1', id: own, text: 'echo of a bridge notice' });
		}
		const routed = await bridge.poll();

		assert.strictEqual(routed.length, 0, 'the bridge must not instruct itself');
	});

	it('delivers a reply that arrived during the quiet period instead of expiring it', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		// Models VS Code being closed: the user replies, then a poll happens much later.
		// Expiring before reading would silently discard that reply.
		clock.now += 30_000;
		transport.queue({ threadId: 't1', text: 'replied while nobody was looking', createdAt: new Date(clock.now).toISOString() });
		clock.now += 61_000;

		const routed = await bridge.poll();

		assert.strictEqual(routed.length, 1, 'the pending reply must still be delivered');
		assert.strictEqual(bridge.getSession(posted.session.id)?.expiredAt, undefined, 'and it should revive the session');
	});

	it('does not expire a session a tool call is waiting on', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		// A blocked tool call is active work, even though the thread looks quiet.
		// The reply is queued first so the waiter resolves without leaving a pending timer.
		transport.queue({ threadId: 't1', text: 'answer' });
		const routed = await bridge.waitForReply(posted.session.id, 5_000);

		clock.now += 61_000;
		assert.strictEqual(routed?.text, 'answer');
		assert.strictEqual(bridge.getSession(posted.session.id)?.expiredAt, undefined);
		bridge.dispose();
	});

	it('revives an expired session when new work is reported', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify(notification);

		clock.now += 61_000;
		await bridge.poll();
		await bridge.notify({ ...notification, summary: 'more work' });

		assert.strictEqual(bridge.getSession(posted.session.id)?.expiredAt, undefined);
	});

	// With grace 0 (the new default) an expired thread is not watched at all: the transport
	// must not even see a fetchReplies for it, so a reply that arrives after expiry cannot
	// be delivered late.
	it('does not fetch or deliver replies for an expired session when grace is 0', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		await bridge.notify(notification);

		clock.now += 61_000;
		await bridge.poll();
		const fetchesBefore = transport.fetches;

		// The user replies anyway, but grace is 0, so the thread is not read at all.
		clock.now += 5_000;
		transport.queue({
			threadId: 't1',
			text: 'typed after expiry',
			createdAt: new Date(clock.now).toISOString()
		});
		const routed = await bridge.poll();

		assert.strictEqual(routed.length, 0, 'a reply posted while expired must never be delivered');
		assert.strictEqual(
			transport.fetches,
			fetchesBefore,
			'the expired thread must not be polled at all with grace 0'
		);
	});

	// recordActivity must revive the session AND skip everything that piled up while it
	// was expired — the user was told those replies would not be read.
	it('recordActivity revives a session and skips replies posted while it was expired', async () => {
		const transport = new FakeTransport();
		const clock = { now: Date.now() };
		const bridge = makeExpiringBridge(transport, 60_000, clock);
		const posted = await bridge.notify({ ...notification, sessionKey: 'chat-alpha' });

		clock.now += 61_000;
		await bridge.poll();
		assert.ok(bridge.getSession(posted.session.id)?.expiredAt, 'the session must have expired');

		// A reply typed while it was expired. It must never be delivered.
		transport.queue({
			threadId: 't1',
			text: 'while expired',
			createdAt: new Date(clock.now).toISOString()
		});

		clock.now += 1_000;
		const activity = bridge.recordActivity('chat-alpha', 'chat-turn');
		assert.strictEqual(activity?.revived, true);

		// A reply typed after reactivation must arrive.
		clock.now += 1_000;
		transport.queue({
			threadId: 't1',
			text: 'after reviving',
			createdAt: new Date(clock.now).toISOString()
		});
		const routed = await bridge.poll();

		assert.deepStrictEqual(
			routed.map((entry) => entry.text),
			['after reviving'],
			'only replies posted after reactivation are delivered'
		);
	});

	// Regression: the two stores (bridge memento and AgentReplyRelay's ~/.copilot-teams-bridge/sessions.json)
	// hold disjoint session ids. Before the fix, postExpiryNotice and postResumedNotice
	// used getSession() and silently returned when the id was unknown to the memento —
	// which is exactly the case for every agent/MCP session. The fallback must post using
	// the session that was passed in, so the user is still told the thread has paused and
	// resumed.
	it('postExpiryNotice falls back to the passed-in session when its id is unknown to the memento', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		// A session the bridge has never seen — as owned by the AgentReplyRelay's store.
		const foreign = {
			id: 's-foreign',
			key: 'agent-task',
			title: 'Agent task',
			thread: { id: 't-foreign' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};

		await bridge.postExpiryNotice(foreign, 60_000);

		const paused = transport.posts.filter((post) => post.thread === 't-foreign' && post.notification.status === 'paused');
		assert.strictEqual(paused.length, 1, 'a foreign session must still get its pause notice');
	});

	it('postResumedNotice falls back to the passed-in session when its id is unknown to the memento', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		const foreign = {
			id: 's-foreign',
			key: 'agent-task',
			title: 'Agent task',
			thread: { id: 't-foreign' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};

		await bridge.postResumedNotice(foreign);

		const resumed = transport.posts.filter((post) => post.thread === 't-foreign' && post.notification.status === 'progress');
		assert.strictEqual(resumed.length, 1, 'a foreign session must still get its resume notice');
	});

	// Both stores can hold a record for the same underlying Teams thread, so the
	// de-duplication is keyed on the thread rather than the session id — the thread is
	// what the user reads, and posting the same lifecycle transition once per store would
	// spam the thread with duplicate notices.
	it('posts exactly one pause notice per thread across repeated calls with different session records', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const mementoLike = {
			id: 's-memento',
			key: 'k',
			title: 'Task',
			thread: { id: 't-shared' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};
		const relayLike = { ...mementoLike, id: 's-relay' };

		await bridge.postExpiryNotice(mementoLike, 60_000);
		await bridge.postExpiryNotice(relayLike, 60_000);
		await bridge.postExpiryNotice(mementoLike, 60_000);

		const paused = transport.posts.filter((post) => post.thread === 't-shared' && post.notification.status === 'paused');
		assert.strictEqual(paused.length, 1, 'exactly one pause notice per thread across all stores');
	});

	it('posts exactly one resume notice per thread across repeated calls with different session records', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const mementoLike = {
			id: 's-memento',
			key: 'k',
			title: 'Task',
			thread: { id: 't-shared' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};
		const relayLike = { ...mementoLike, id: 's-relay' };

		// A prior pause is needed for the resume to be a real transition.
		await bridge.postExpiryNotice(mementoLike, 60_000);
		await bridge.postResumedNotice(mementoLike);
		await bridge.postResumedNotice(relayLike);
		await bridge.postResumedNotice(mementoLike);

		const resumed = transport.posts.filter(
			(post) => post.thread === 't-shared' && post.notification.status === 'progress'
		);
		assert.strictEqual(resumed.length, 1, 'exactly one resume notice per thread across all stores');
	});

	it('alternates pause and resume notices per thread, so each transition is announced once', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const foreign = {
			id: 's-foreign',
			key: 'k',
			title: 'Agent task',
			thread: { id: 't-alt' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};

		await bridge.postExpiryNotice(foreign, 60_000);
		await bridge.postResumedNotice(foreign);
		await bridge.postExpiryNotice(foreign, 60_000);
		await bridge.postResumedNotice(foreign);

		const paused = transport.posts.filter((post) => post.thread === 't-alt' && post.notification.status === 'paused');
		const resumed = transport.posts.filter((post) => post.thread === 't-alt' && post.notification.status === 'progress');
		assert.strictEqual(paused.length, 2, 'each pause transition posts a fresh notice');
		assert.strictEqual(resumed.length, 2, 'each resume transition posts a fresh notice');
	});

	// The bridge suppresses its own posts so they are not read back as replies. That has
	// to keep working for the fallback path as well: without it, an agent-session's own
	// pause notice would be re-routed to Copilot as an instruction the next time the
	// relay reads the thread.
	it('records the postedMessageId of a fallback pause notice so it is never read back as a reply', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const foreign = {
			id: 's-foreign',
			key: 'k',
			title: 'Agent task',
			thread: { id: 't-echo' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};

		await bridge.postExpiryNotice(foreign, 60_000);
		await bridge.postResumedNotice(foreign);

		assert.ok(transport.ownMessageIds.length >= 2, 'both fallback notices must be recorded as own posts');
	});

	// The bug this regression covers: a sidebar (memento) session must not be silently
	// skipped just because an unrelated agent session (relay store) has recently paused.
	// The thread-lifecycle map is keyed per thread, so a pause posted for the agent
	// session's thread must not block a pause posted for a sidebar session's thread.
	it('one thread pausing does not gag a different thread from posting its own pause or resume', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		// The agent session, unknown to the memento, whose expiry was previously silent.
		const agent = {
			id: 's-agent',
			key: 'agent',
			title: 'Agent task',
			thread: { id: 't-agent' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};
		await bridge.postExpiryNotice(agent, 60_000);

		// The sidebar session, in the memento, on a different thread. Its pause and resume
		// must still be announced.
		const sidebar = await bridge.notify({
			sessionKey: 'sidebar-task',
			title: 'Sidebar task',
			summary: 'starting',
			status: 'progress'
		});
		const sidebarSession = bridge.getSession(sidebar.session.id) as NonNullable<ReturnType<Bridge['getSession']>>;
		await bridge.postExpiryNotice(sidebarSession, 60_000);
		await bridge.postResumedNotice(sidebarSession);

		const sidebarPause = transport.posts.filter(
			(post) => post.thread === sidebarSession.thread?.id && post.notification.status === 'paused'
		);
		const sidebarResume = transport.posts.filter(
			(post) => post.thread === sidebarSession.thread?.id && post.notification.status === 'progress' &&
				/active again/.test(post.notification.summary)
		);
		assert.strictEqual(sidebarPause.length, 1, 'the sidebar thread must get its own pause notice');
		assert.strictEqual(sidebarResume.length, 1, 'the sidebar thread must get its own resume notice');
	});

	// Regression for the interaction the fix introduces: a sidebar Teams reply must still
	// be routed to its chat AFTER an unrelated agent session has been marked paused in the
	// (foreign) relay store. The bridge's poll cycle owns the memento sessions only, and
	// the thread-lifecycle map records the agent's thread — never the sidebar's — so
	// nothing about the sidebar's delivery path can be gagged by the agent's expiry.
	it('a sidebar reply still routes to its chat after an unrelated agent session paused elsewhere', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const routed: string[] = [];
		bridge.onReply((entry) => {
			routed.push(entry.text);
		});

		// Simulate the relay having just marked an agent session paused: postExpiryNotice
		// on a session unknown to the memento. This exercises the new fallback path.
		const agent = {
			id: 's-agent',
			key: 'agent',
			title: 'Agent task',
			thread: { id: 't-agent' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};
		await bridge.postExpiryNotice(agent, 60_000);

		// Now announce a sidebar session and let a Teams reply arrive for it.
		const sidebar = await bridge.notify({
			sessionKey: 'sidebar-task',
			title: 'Sidebar task',
			summary: 'starting',
			status: 'progress'
		});
		transport.queue({
			threadId: sidebar.session.thread?.id ?? '',
			text: 'please continue',
			createdAt: new Date(Date.now() + 60_000).toISOString()
		});
		const delivered = await bridge.poll();

		assert.strictEqual(delivered.length, 1, 'the sidebar reply must still be routed');
		assert.strictEqual(delivered[0].session.id, sidebar.session.id, 'and to its own session');
		assert.deepStrictEqual(routed, ['please continue'], 'the reply handler must see it');
	});
});

describe('Bridge rename', () => {
	it('renames a session and rewrites the thread opening message', async () => {
		const transport = new FakeTransport();
		const renamed: { threadId: string; title: string }[] = [];
		(transport as unknown as { renameThread: unknown }).renameThread = async (
			thread: { id: string },
			payload: { title: string }
		): Promise<void> => {
			renamed.push({ threadId: thread.id, title: payload.title });
		};

		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);

		const ok = await bridge.renameSession(posted.session.id, 'Reserve API filter work');

		assert.strictEqual(ok, true);
		assert.strictEqual(bridge.getSession(posted.session.id)?.title, 'Reserve API filter work');
		assert.deepStrictEqual(renamed, [{ threadId: 't1', title: 'Reserve API filter work' }]);
	});

	it('ignores an empty or unknown rename', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);

		assert.strictEqual(await bridge.renameSession(posted.session.id, '   '), false);
		assert.strictEqual(await bridge.renameSession('no-such-session', 'x'), false);
		assert.strictEqual(bridge.getSession(posted.session.id)?.title, 'Task A');
	});

	it('renames without a transport that supports editing', async () => {
		// FakeTransport has no renameThread, mirroring a transport that cannot edit posts.
		const bridge = makeBridge(new FakeTransport());
		const posted = await bridge.notify(notification);

		assert.strictEqual(await bridge.renameSession(posted.session.id, 'New name'), true);
		assert.strictEqual(bridge.getSession(posted.session.id)?.title, 'New name');
	});
});

describe('Bridge persistence', () => {
	it('restores sessions from the store', async () => {
		const store = new InMemorySessionStore();
		const transport = new FakeTransport();
		const first = new Bridge({ transport, store, setTimer: () => 1, clearTimer: () => undefined });
		await first.notify(notification);

		const second = new Bridge({ transport, store, setTimer: () => 1, clearTimer: () => undefined });

		assert.strictEqual(second.listSessions().length, 1);
		assert.strictEqual(second.listSessions()[0].key, 'task-a');
	});
});



describe('Bridge undelivered replies', () => {
	it('holds a reply when nothing is waiting instead of discarding it', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		transport.queue({ threadId: posted.session.thread!.id, text: 'carry on' });

		await bridge.poll();

		const held = bridge.takeUndelivered();
		assert.strictEqual(held.length, 1, 'a reply with no consumer must survive the poll that marked it seen');
		assert.strictEqual(held[0].text, 'carry on');
		assert.strictEqual(bridge.takeUndelivered().length, 0, 'draining must be destructive so it is never replayed');
	});

	it('does not hold replies when a handler consumed them', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const seen: string[] = [];
		bridge.onReply((routed) => {
			seen.push(routed.text);
		});
		const posted = await bridge.notify(notification);
		transport.queue({ threadId: posted.session.thread!.id, text: 'delivered' });

		await bridge.poll();

		assert.deepStrictEqual(seen, ['delivered']);
		assert.strictEqual(bridge.takeUndelivered().length, 0);
	});

	it('gives a late handler the replies that arrived before it registered', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		transport.queue({ threadId: posted.session.thread!.id, text: 'early' });
		await bridge.poll();

		const seen: string[] = [];
		bridge.onReply((routed) => {
			seen.push(routed.text);
		});
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepStrictEqual(seen, ['early'], 'a reply must not be lost just because the host attached late');
	});

	it('waitForReply consumes a reply collected by an earlier poll', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		transport.queue({ threadId: posted.session.thread!.id, text: 'answered already' });
		await bridge.poll();

		const routed = await bridge.waitForReply(posted.session.id, 1_000);

		assert.strictEqual(routed?.text, 'answered already');
	});

	it('keeps replies for other sessions when draining one session', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const a = await bridge.notify(notification);
		const b = await bridge.notify({ ...notification, sessionKey: 'task-b', title: 'Task B' });
		transport.queue({ threadId: a.session.thread!.id, text: 'for a' });
		transport.queue({ threadId: b.session.thread!.id, text: 'for b' });
		await bridge.poll();

		const forA = bridge.takeUndelivered(a.session.id);

		assert.deepStrictEqual(
			forA.map((r) => r.text),
			['for a']
		);
		assert.deepStrictEqual(
			bridge.takeUndelivered().map((r) => r.text),
			['for b']
		);
	});
});

describe('Bridge poll failures', () => {
	it('reports a thread it could not read rather than looking like an empty thread', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		transport.fetchReplies = async (): Promise<never> => {
			throw new Error('Session not found');
		};

		const routed = await bridge.poll();

		assert.strictEqual(routed.length, 0);
		assert.strictEqual(bridge.lastPollFailures.length, 1);
		assert.strictEqual(bridge.lastPollFailures[0].sessionId, posted.session.id);
		assert.match(bridge.lastPollFailures[0].reason, /Session not found/);
	});

	it('clears the failure once the thread can be read again', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		const working = transport.fetchReplies.bind(transport);
		transport.fetchReplies = async (): Promise<never> => {
			throw new Error('Session not found');
		};
		await bridge.poll();
		assert.strictEqual(bridge.lastPollFailures.length, 1);

		transport.fetchReplies = working;
		await bridge.poll();

		assert.deepStrictEqual(bridge.lastPollFailures, [], 'a recovered transport must not keep reporting a stale failure');
	});
});

describe('Bridge returnUndelivered', () => {
	it('re-dispatches to a handler rather than leaving the reply to be polled for', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const seen: string[] = [];
		bridge.onReply((routed) => {
			seen.push(routed.text);
		});
		const posted = await bridge.notify(notification);
		transport.queue({ threadId: posted.session.thread!.id, text: 'handed back' });
		await bridge.poll();
		const [routed] = seen.splice(0, 1);
		assert.strictEqual(routed, 'handed back');

		const captured = { session: bridge.getSession(posted.session.id)!, reply: { id: 'x', threadId: 't1', text: 'handed back', from: 'Rob', createdAt: new Date().toISOString() }, text: 'handed back' };
		bridge.returnUndelivered(captured);
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepStrictEqual(seen, ['handed back'], 'the handler must get a second chance at the reply');
		assert.strictEqual(bridge.takeUndelivered().length, 0, 'it must not also sit in the buffer');
	});

	it('buffers instead when no handler exists', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		const captured = { session: bridge.getSession(posted.session.id)!, reply: { id: 'x', threadId: 't1', text: 'nobody home', from: 'Rob', createdAt: new Date().toISOString() }, text: 'nobody home' };

		bridge.returnUndelivered(captured);
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepStrictEqual(
			bridge.takeUndelivered().map((r) => r.text),
			['nobody home']
		);
	});
});

describe('Bridge poll backoff', () => {
	it('slows down while the transport keeps failing and recovers on success', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		const working = transport.fetchReplies.bind(transport);
		transport.fetchReplies = async (): Promise<never> => {
			throw new Error('429 Too Many Requests');
		};

		await bridge.poll();
		const afterOne = bridge.pollDelayMs;
		await bridge.poll();
		const afterTwo = bridge.pollDelayMs;

		assert.strictEqual(afterOne, 20_000, 'the first failure must double the 10s interval');
		assert.strictEqual(afterTwo, 40_000, 'repeated failures must keep backing off');

		transport.fetchReplies = working;
		await bridge.poll();

		assert.strictEqual(bridge.pollDelayMs, 10_000, 'a successful poll must return to the normal interval');
	});

	it('caps the backoff so a broken upstream is still retried', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		transport.fetchReplies = async (): Promise<never> => {
			throw new Error('503 Service Unavailable');
		};

		for (let attempt = 0; attempt < 20; attempt++) {
			await bridge.poll();
		}

		assert.strictEqual(bridge.pollDelayMs, 5 * 60 * 1000, 'backoff must stop at the ceiling, not grow forever');
	});

	it('resets the backoff when someone starts waiting for a reply', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const posted = await bridge.notify(notification);
		const working = transport.fetchReplies.bind(transport);
		transport.fetchReplies = async (): Promise<never> => {
			throw new Error('429 Too Many Requests');
		};
		await bridge.poll();
		await bridge.poll();
		assert.ok(bridge.pollDelayMs > 10_000);

		transport.fetchReplies = working;
		transport.queue({ threadId: posted.session.thread!.id, text: 'here' });
		const routed = await bridge.waitForReply(posted.session.id, 1_000);

		assert.strictEqual(routed?.text, 'here');
		assert.strictEqual(bridge.pollDelayMs, 10_000, 'an active wait must not be left polling minutes apart');
	});
});

describe('Bridge reply after expiry', () => {
	// The window closing must not cost other sessions anything — that is the whole point of
	// expiring one thread rather than pausing the bridge.
	it('stops reading an expired thread but keeps reading every other', async () => {
		const transport = new FakeTransport();
		let now = Date.now();
		const bridge = new Bridge({
			transport,
			store: new InMemorySessionStore(),
			pollIntervalMs: 10_000,
			sessionIdleMs: 60_000,
			now: () => new Date(now),
			setTimer: () => 1,
			clearTimer: () => undefined
		});

		await bridge.notify({ ...notification, sessionKey: 'quiet', title: 'Quiet task' });
		const quiet = bridge.listSessions().find((entry) => entry.key === 'quiet')!;

		// Long enough that the first session lapses.
		now += 120_000;
		await bridge.poll();
		assert.ok(bridge.listSessions().find((entry) => entry.key === 'quiet')?.expiredAt);

		// A second session, still being used.
		await bridge.notify({ ...notification, sessionKey: 'busy', title: 'Busy task' });
		const busy = bridge.listSessions().find((entry) => entry.key === 'busy')!;

		now += 30_000;
		transport.queue({ threadId: quiet.thread!.id, text: 'too late', createdAt: new Date(now).toISOString() });
		transport.queue({ threadId: busy.thread!.id, text: 'still here', createdAt: new Date(now).toISOString() });

		let routed: Awaited<ReturnType<typeof bridge.poll>> = [];
		for (let attempt = 0; attempt < 8; attempt++) {
			routed = [...routed, ...(await bridge.poll())];
		}

		assert.deepStrictEqual(
			routed.map((entry) => entry.text.trim()),
			['still here'],
			'the live session must keep working while the expired one is left alone'
		);
		bridge.dispose();
	});

	// The old behaviour, still available to anyone who opts into it. Replying is the plainest
	// statement that a thread is still wanted, and before the thread said otherwise that was
	// the right signal to act on. It is no longer the default: the expiry notice and every
	// message footer now say replies will not reach Copilot, so acting on one anyway would
	// contradict what the user was told.
	it('resumes an expired session on reply when a grace period is configured', async () => {
		const transport = new FakeTransport();
		let now = Date.now();
		const bridge = new Bridge({
			transport,
			store: new InMemorySessionStore(),
			pollIntervalMs: 10_000,
			sessionIdleMs: 60_000,
			expiredGraceMs: 24 * 60 * 60 * 1000,
			now: () => new Date(now),
			setTimer: () => 1,
			clearTimer: () => undefined
		});

		await bridge.notify(notification);
		const session = bridge.listSessions()[0];

		// Nothing happens for long enough that the session expires.
		now += 120_000;
		await bridge.poll();
		assert.ok(bridge.listSessions()[0].expiredAt, 'the session should have expired');

		// The user replies anyway, well after the window closed.
		now += 60_000;
		transport.queue({ threadId: session.thread!.id, text: 'carry on please', createdAt: new Date(now).toISOString() });

		// Expired threads are read on a slower cadence, so several ticks may pass.
		let routed: Awaited<ReturnType<typeof bridge.poll>> = [];
		for (let attempt = 0; attempt < 8 && routed.length === 0; attempt++) {
			routed = await bridge.poll();
		}

		assert.strictEqual(routed.length, 1, 'the reply must still be delivered');
		assert.match(routed[0].text, /carry on please/);
		assert.strictEqual(bridge.listSessions()[0].expiredAt, undefined, 'the session should be live again');
		bridge.dispose();
	});

	it('stops reading a thread once the grace period is over', async () => {
		const transport = new FakeTransport();
		let now = Date.now();
		const bridge = new Bridge({
			transport,
			store: new InMemorySessionStore(),
			pollIntervalMs: 10_000,
			sessionIdleMs: 60_000,
			expiredGraceMs: 60_000,
			now: () => new Date(now),
			setTimer: () => 1,
			clearTimer: () => undefined
		});

		await bridge.notify(notification);
		const session = bridge.listSessions()[0];
		now += 120_000;
		await bridge.poll();

		// Long past both the idle window and the grace period.
		now += 600_000;
		transport.queue({ threadId: session.thread!.id, text: 'far too late', createdAt: new Date(now).toISOString() });

		let routed: Awaited<ReturnType<typeof bridge.poll>> = [];
		for (let attempt = 0; attempt < 8 && routed.length === 0; attempt++) {
			routed = await bridge.poll();
		}

		assert.strictEqual(routed.length, 0, 'an abandoned thread must not be read forever');
		bridge.dispose();
	});

	// With a grace period configured, a restart must not waste the one poll that matters
	// most: the editor may have been closed for hours, which is exactly when a reply is
	// most likely to be waiting.
	it('reads expired threads on the first poll after a restart', async () => {
		const transport = new FakeTransport();
		const store = new InMemorySessionStore();
		let now = Date.now();
		const options = {
			transport,
			store,
			pollIntervalMs: 10_000,
			sessionIdleMs: 60_000,
			expiredGraceMs: 24 * 60 * 60 * 1000,
			now: () => new Date(now),
			setTimer: () => 1,
			clearTimer: () => undefined
		};

		const before = new Bridge(options);
		await before.notify(notification);
		const thread = before.listSessions()[0].thread!.id;
		now += 120_000;
		await before.poll();
		assert.ok(before.listSessions()[0].expiredAt, 'the session should have expired');
		before.dispose();

		// The user replies, then VS Code restarts and reads the sessions back.
		now += 60_000;
		transport.queue({ threadId: thread, text: 'still here', createdAt: new Date(now).toISOString() });
		const after = new Bridge(options);

		const routed = await after.poll();

		assert.strictEqual(routed.length, 1, 'the waiting reply must arrive on the first poll');
		assert.match(routed[0].text, /still here/);
		after.dispose();
	});
});

describe('Bridge.acknowledgeReply', () => {
	// Until the agent posts its own first update there is no sign a reply arrived, which
	// is indistinguishable from it having been lost.
	it('tells the user their reply was picked up', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		const session = bridge.listSessions()[0];
		transport.queue({ threadId: session.thread!.id, text: 'do the thing' });
		const [routed] = await bridge.poll();

		await bridge.acknowledgeReply(routed);

		const last = transport.posts[transport.posts.length - 1];
		assert.match(last.notification.summary, /working on this/);
		bridge.dispose();
	});

	// A stop needs no promise of work; the agent confirms having stopped.
	it('says nothing when the reply was a stop', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		const session = bridge.listSessions()[0];
		transport.queue({ threadId: session.thread!.id, text: '/stop' });
		const [routed] = await bridge.poll();
		const before = transport.posts.length;

		await bridge.acknowledgeReply(routed);

		assert.strictEqual(transport.posts.length, before);
		bridge.dispose();
	});

	it('can be turned off', async () => {
		const transport = new FakeTransport();
		const bridge = new Bridge({
			transport,
			store: new InMemorySessionStore(),
			pollIntervalMs: 10_000,
			acknowledgeReplies: false,
			setTimer: () => 1,
			clearTimer: () => undefined
		});
		await bridge.notify(notification);
		const session = bridge.listSessions()[0];
		transport.queue({ threadId: session.thread!.id, text: 'do the thing' });
		const [routed] = await bridge.poll();
		const before = transport.posts.length;

		await bridge.acknowledgeReply(routed);

		assert.strictEqual(transport.posts.length, before);
		bridge.dispose();
	});

	// The live silent-failure of 2026-08-29: an MCP-server session lives only in the
	// relay's on-disk store, so the memento lookup returned nothing and the "got it" ack
	// was a silent no-op -- indistinguishable from the reply being lost. The fallback
	// must use the session it was handed.
	it('posts for a session the Bridge does not own', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const nonOwned = {
			id: 'not-in-memento-ack',
			key: 'agent-ack',
			title: 'Agent-only ack',
			thread: { id: 't-agent-ack' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};
		const routed = {
			session: nonOwned,
			reply: { id: 'r-ack', threadId: 't-agent-ack', text: 'do it', from: 'Rob', createdAt: new Date().toISOString() },
			text: 'do it'
		};

		await bridge.acknowledgeReply(routed);

		assert.strictEqual(transport.posts.length, 1, 'the non-owned session must still be acknowledged');
		assert.strictEqual(transport.posts[0].thread, 't-agent-ack');
		assert.match(transport.posts[0].notification.summary, /working on this/);
		bridge.dispose();
	});
});

describe('Bridge background collection', () => {
	// Only a blocking wait ever started the poll loop. Once blocking stopped being the
	// default, a reply sent after the agent finished its turn was never read at all: not
	// delayed, never seen, because nothing was polling.
	it('collects a reply with nobody waiting for it', async () => {
		const transport = new FakeTransport();
		const timers: (() => void)[] = [];
		const bridge = new Bridge({
			transport,
			store: new InMemorySessionStore(),
			pollIntervalMs: 10_000,
			// Captured so the loop can be driven without real time passing.
			setTimer: (handler) => {
				timers.push(handler);
				return timers.length;
			},
			clearTimer: () => undefined
		});

		await bridge.notify(notification);
		const session = bridge.listSessions()[0];
		transport.queue({ threadId: session.thread!.id, text: 'did you prepare the report?' });

		// No tool call, no waiter, no handler: only the background loop can find this.
		bridge.start();
		assert.strictEqual(timers.length, 1, 'start() must schedule a poll');
		timers[0]();
		await new Promise((resolve) => setImmediate(resolve));

		const collected = bridge.takeUndelivered();
		assert.strictEqual(collected.length, 1, 'the reply must be collected and held');
		assert.match(collected[0].text, /prepare the report/);
		bridge.dispose();
	});

	// Collecting marks the reply seen and advances the watermark, so holding it only in
	// memory would lose it for good when the process stops - which is exactly what happens
	// to an MCP server once the agent using it finishes.
	it('keeps a collected reply across a restart', async () => {
		const transport = new FakeTransport();
		const store = new InMemorySessionStore();
		const options = {
			transport,
			store,
			pollIntervalMs: 10_000,
			setTimer: () => 1,
			clearTimer: () => undefined
		};

		const before = new Bridge(options);
		await before.notify(notification);
		const session = before.listSessions()[0];
		transport.queue({ threadId: session.thread!.id, text: 'did you prepare the report?' });

		// Collected in the background, with nobody waiting.
		await before.poll();
		before.dispose();

		// The process restarts and reads the sessions back.
		const after = new Bridge(options);
		const recovered = after.takeUndelivered();

		assert.strictEqual(recovered.length, 1, 'the reply must survive the restart');
		assert.match(recovered[0].text, /prepare the report/);
		after.dispose();
	});

	it('hands a held reply to only one caller', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		await bridge.notify(notification);
		const session = bridge.listSessions()[0];
		transport.queue({ threadId: session.thread!.id, text: 'only once' });
		await bridge.poll();

		assert.strictEqual(bridge.takeUndelivered().length, 1, 'the first caller gets it');
		assert.strictEqual(bridge.takeUndelivered().length, 0, 'it must not be handed out twice');
		bridge.dispose();
	});
});

describe('Bridge.postUnroutableNotice', () => {
	function bridgeWith(): { transport: FakeTransport; bridge: Bridge } {
		const transport = new FakeTransport();
		const bridge = new Bridge({
			transport,
			store: new InMemorySessionStore(),
			pollIntervalMs: 10_000,
			setTimer: () => 1,
			clearTimer: () => undefined
		});
		return { transport, bridge };
	}

	// Telling a CLI user their chat "could not be identified" is untrue -- it is known, and
	// simply out of reach -- and implies the reply is still on its way. The honest answer
	// names the situation and says where to go instead.
	it('tells an unreachable session that replying there will not resume the work', async () => {
		const { transport, bridge } = bridgeWith();
		await bridge.notify({
			sessionKey: 'cli',
			title: 'CLI task',
			summary: 's',
			status: 'progress',
			identity: {
				harness: 'cli-runtime',
				chat: { kind: 'cli-debug-log', value: 'cli-session' },
				confidence: 'exact',
				capturedBy: 'mcp-ingest',
				capturedAt: new Date().toISOString()
			}
		});
		const session = bridge.listSessions()[0];
		const routed = {
			session,
			reply: { id: 'r1', threadId: session.thread!.id, text: 'carry on', from: 'Rob', createdAt: new Date().toISOString() },
			text: 'carry on'
		};

		await bridge.postUnroutableNotice(routed);
		await bridge.postUnroutableNotice(routed);

		const notices = transport.posts.filter((post) => /will not resume the work/i.test(post.notification.summary));
		assert.strictEqual(notices.length, 1, 'said plainly, and only once -- repeating it would bury the thread');
		assert.match(notices[0].notification.summary, /Copilot CLI runtime/i, 'and names why it cannot be reached');
		assert.match(notices[0].notification.summary, /VS Code/i, 'and where to continue instead');
		bridge.dispose();
	});

	// A chat that has merely not been identified yet may still become deliverable, so this
	// one must not tell the user to give up -- the reply is kept for it. When the harness
	// itself is unknown too (an agent/CLI session with no chat on record), the honest thing
	// to say is that the reply is queued for that agent -- not to send the user chasing a
	// chat that does not exist.
	it('keeps a not-yet-identified session hopeful', async () => {
		const { transport, bridge } = bridgeWith();
		await bridge.notify({ sessionKey: 'unknown', title: 'Unknown task', summary: 's', status: 'progress' });
		const session = bridge.listSessions()[0];

		await bridge.postUnroutableNotice({
			session,
			reply: { id: 'r1', threadId: session.thread!.id, text: 'carry on', from: 'Rob', createdAt: new Date().toISOString() },
			text: 'carry on'
		});

		const notice = transport.posts.find((post) => /queued for the agent/i.test(post.notification.summary));
		assert.ok(notice, 'a session with no chat and no harness is queued for the agent, not asked to open a chat');
		assert.match(notice.notification.summary, /nothing is lost/i, 'and says nothing is lost');
		assert.ok(
			!/Open the chat for this task/i.test(notice.notification.summary),
			'and must not tell the user to open a chat that never existed'
		);
		bridge.dispose();
	});

	// The reason has to be true. Telling a user their chat "has not been identified" when it
	// is on record sends them looking for a problem that does not exist -- and hides the one
	// that does, which is that the chat could not be brought to the front.
	it('names the real reason when the chat is known but was not reached', async () => {
		const { transport, bridge } = bridgeWith();
		await bridge.notify({
			sessionKey: 'known',
			title: 'Known chat',
			summary: 's',
			status: 'progress',
			identity: {
				harness: 'vscode-sidebar',
				chat: { kind: 'chat-session-resource', value: 'vscode-chat-session://local/abc' },
				confidence: 'exact',
				capturedBy: 'chat-watcher',
				capturedAt: new Date().toISOString()
			}
		});
		const session = bridge.listSessions()[0];

		await bridge.postUnroutableNotice({
			session,
			reply: { id: 'r1', threadId: session.thread!.id, text: 'go on', from: 'Rob', createdAt: new Date().toISOString() },
			text: 'go on'
		});

		const notice = transport.posts.find((post) => /has not been handed over yet/i.test(post.notification.summary));
		assert.ok(notice, 'the notice must say the chat was not reached');
		assert.ok(
			!/has not been identified/i.test(notice.notification.summary),
			'and must not claim the chat is unknown when it is on record'
		);
		assert.match(notice.notification.summary, /Open that chat/i, 'and must say what makes it reachable');
		bridge.dispose();
	});

	/**
	 * The live failure of 2026-08-28: a retained reply is retried on every poll, and each
	 * attempt posted the same notice again. The user watched one undelivered instruction
	 * become an identical wall of failures every ten seconds, which buried the very
	 * conversation the thread existed to report on.
	 */
	it('tells the user a reply is waiting once, not once per retry', async () => {
		const { transport, bridge } = bridgeWith();
		await bridge.notify({
			sessionKey: 'noisy',
			title: 'Noisy',
			summary: 's',
			status: 'progress',
			identity: {
				harness: 'vscode-sidebar',
				chat: { kind: 'chat-session-resource', value: 'vscode-chat-session://local/abc' },
				confidence: 'exact',
				capturedBy: 'chat-watcher',
				capturedAt: new Date().toISOString()
			}
		});
		const session = bridge.listSessions()[0];
		const routed = {
			session,
			reply: { id: 'r1', threadId: session.thread!.id, text: 'go on', from: 'Rob', createdAt: new Date().toISOString() },
			text: 'go on'
		};
		transport.posts.length = 0;

		// Three polls, one undelivered reply.
		await bridge.postUnroutableNotice(routed);
		await bridge.postUnroutableNotice(routed);
		await bridge.postUnroutableNotice(routed);

		assert.strictEqual(transport.posts.length, 1, 'the same reply must be reported once');
		bridge.dispose();
	});

	// The live silent-failure of 2026-08-29: a session created via the MCP server lives
	// only in the AgentReplyRelay's on-disk store. Bridge.getSession searched only the
	// memento, so postUnroutableNotice returned early and the user was told nothing while
	// the reply sat stranded. The fallback path must post using the session it was handed.
	it('posts for a session the Bridge does not own', async () => {
		const { transport, bridge } = bridgeWith();
		// Deliberately never announced through bridge.notify, so this id is not in
		// listSessions(). This is the non-owned case the relay hits every pass.
		const nonOwned = {
			id: 'not-in-memento',
			key: 'agent-key',
			title: 'Agent-only task',
			thread: { id: 't-agent' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};
		const routed = {
			session: nonOwned,
			reply: { id: 'r-agent', threadId: 't-agent', text: 'do it', from: 'Rob', createdAt: new Date().toISOString() },
			text: 'do it'
		};

		await bridge.postUnroutableNotice(routed);

		assert.strictEqual(transport.posts.length, 1, 'the non-owned session must still get a notice');
		assert.strictEqual(transport.posts[0].thread, 't-agent', 'and it must post to the session it was handed');
		bridge.dispose();
	});

	// The dedup fields live on the Bridge's own session records, so a non-owned session
	// cannot persist them. Without an in-memory guard the same notice would post every
	// poll for as long as the reply is retained -- the storm this fix is supposed to end.
	it('posts exactly once across repeated calls for the same non-owned reply', async () => {
		const { transport, bridge } = bridgeWith();
		const nonOwned = {
			id: 'not-in-memento-2',
			key: 'agent-key-2',
			title: 'Agent-only task 2',
			thread: { id: 't-agent-2' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress' as const
		};
		const routed = {
			session: nonOwned,
			reply: { id: 'r-once', threadId: 't-agent-2', text: 'do it', from: 'Rob', createdAt: new Date().toISOString() },
			text: 'do it'
		};

		await bridge.postUnroutableNotice(routed);
		await bridge.postUnroutableNotice(routed);
		await bridge.postUnroutableNotice(routed);

		assert.strictEqual(transport.posts.length, 1, 'a retained reply must only get one notice');
		bridge.dispose();
	});

	// The other half of that rule: a genuinely new reply is still worth reporting, or
	// silencing the noise would silence the signal too.
	it('still reports a different reply that could not be delivered', async () => {
		const { transport, bridge } = bridgeWith();
		await bridge.notify({ sessionKey: 'two', title: 'Two', summary: 's', status: 'progress' });
		const session = bridge.listSessions()[0];
		const replyOf = (id: string): { session: typeof session; reply: { id: string; threadId: string; text: string; from: string; createdAt: string }; text: string } => ({
			session,
			reply: { id, threadId: session.thread!.id, text: 'go on', from: 'Rob', createdAt: new Date().toISOString() },
			text: 'go on'
		});
		transport.posts.length = 0;

		await bridge.postUnroutableNotice(replyOf('r1'));
		await bridge.postUnroutableNotice(replyOf('r2'));

		assert.strictEqual(transport.posts.length, 2, 'each distinct reply is still reported');
		bridge.dispose();
	});

	/**
	 * Posting a summary on every finished chat turn.
	 *
	 * The user asked to be told about every turn, not only the ones where the model chose to
	 * call the notify tool. That makes the transcript the trigger, which brings two risks
	 * worth pinning down: a turn must not start a Teams thread the user never announced, and
	 * a transcript re-read — which happens on every write and after every reload — must not
	 * replay the conversation.
	 */
	describe('Bridge.postTurnSummary', () => {
		async function announced(): Promise<{ transport: FakeTransport; bridge: Bridge }> {
			const made = bridgeWith();
			await made.bridge.notify({ sessionKey: 'chat-1', title: 'A task', summary: 's', status: 'progress' });
			made.transport.posts.length = 0;
			return made;
		}

		it('posts a finished turn into that chat\u2019s own thread', async () => {
			const { transport, bridge } = await announced();

			const posted = await bridge.postTurnSummary('chat-1', {
				requestId: 'r1',
				prompt: 'fix the build',
				summary: 'Fixed the build.'
			});

			assert.strictEqual(posted, true);
			assert.strictEqual(transport.posts.length, 1, 'into the existing thread, not a new one');
			assert.match(transport.posts[0].notification.summary, /fix the build/, 'naming what was asked');
			assert.match(transport.posts[0].notification.summary, /Fixed the build/, 'and what came of it');
			bridge.dispose();
		});

		// The transcript is re-read from the start every time it changes, so without a record
		// of what has been posted the whole conversation would be replayed into Teams.
		it('posts each turn once, however often the transcript is rescanned', async () => {
			const { transport, bridge } = await announced();
			const turn = { requestId: 'r1', prompt: 'p', summary: 's' };

			await bridge.postTurnSummary('chat-1', turn);
			const second = await bridge.postTurnSummary('chat-1', turn);

			assert.strictEqual(second, false);
			assert.strictEqual(transport.posts.length, 1, 'a rescan must not repost');
			bridge.dispose();
		});

		// The user chooses which conversations Teams hears about. A turn is not that choice.
		it('stays silent for a chat that was never announced', async () => {
			const { transport, bridge } = bridgeWith();

			const posted = await bridge.postTurnSummary('never-announced', {
				requestId: 'r1',
				prompt: 'p',
				summary: 's'
			});

			assert.strictEqual(posted, false);
			assert.deepStrictEqual(transport.posts, [], 'a turn must not open a thread on its own');
			bridge.dispose();
		});

		// Closing a thread from Teams means stop; carrying on posting would ignore that.
		it('stays silent once the session is closed', async () => {
			const { transport, bridge } = await announced();
			bridge.closeSession(bridge.listSessions()[0].id);

			const posted = await bridge.postTurnSummary('chat-1', { requestId: 'r1', prompt: 'p', summary: 's' });

			assert.strictEqual(posted, false);
			assert.deepStrictEqual(transport.posts, []);
			bridge.dispose();
		});

		// A turn is as good a sign of life as a Teams reply, so it must slide the idle window
		// rather than letting a session expire while it is plainly being worked on.
		it('slides the idle window when a turn is posted', async () => {
			const { bridge } = await announced();

			await bridge.postTurnSummary('chat-1', { requestId: 'r1', prompt: 'p', summary: 's' });

			const after = bridge.listSessions()[0];
			assert.strictEqual(after.lastActivitySource, 'chat-turn');
			assert.strictEqual(after.expiredAt, undefined);
			bridge.dispose();
		});

		// Copilot's own update is written by something that knows what mattered in the turn.
		// Posting a reconstructed summary alongside it would say everything twice.
		it('stays quiet when Copilot already reported that turn itself', async () => {
			const { transport, bridge } = await announced();
			// notify() during the turn, which is what a real status update looks like.
			await bridge.notify({ sessionKey: 'chat-1', title: 'A task', summary: 'Done it.', status: 'completed' });
			transport.posts.length = 0;

			const posted = await bridge.postTurnSummary('chat-1', {
				requestId: 'r1',
				prompt: 'p',
				summary: 'reconstructed from the transcript',
				startedAt: Date.now() - 60_000
			});

			assert.strictEqual(posted, false);
			assert.deepStrictEqual(transport.posts, [], 'the model\u2019s own words stand alone');
			bridge.dispose();
		});

		// The other half of that rule: an update sent *before* the turn began was reporting
		// earlier work, so it must not silence this turn.
		it('still posts when the last update predates the turn', async () => {
			const { transport, bridge } = await announced();
			await bridge.notify({ sessionKey: 'chat-1', title: 'A task', summary: 'Earlier.', status: 'progress' });
			transport.posts.length = 0;

			const posted = await bridge.postTurnSummary('chat-1', {
				requestId: 'r1',
				prompt: 'p',
				summary: 'a later turn',
				startedAt: Date.now() + 60_000
			});

			assert.strictEqual(posted, true);
			assert.strictEqual(transport.posts.length, 1);
			bridge.dispose();
		});

		// A missing update is worse than a duplicated one, so an unplaceable turn is posted.
		it('posts a turn whose start time was not recorded', async () => {
			const { bridge } = await announced();
			await bridge.notify({ sessionKey: 'chat-1', title: 'A task', summary: 'Now.', status: 'progress' });

			const posted = await bridge.postTurnSummary('chat-1', {
				requestId: 'r1',
				prompt: 'p',
				summary: 's',
				startedAt: 0
			});

			assert.strictEqual(posted, true);
			bridge.dispose();
		});

		// Suppression must still count as handled, or every rescan would re-evaluate it.
		it('does not reconsider a turn it deliberately skipped', async () => {
			const { transport, bridge } = await announced();
			await bridge.notify({ sessionKey: 'chat-1', title: 'A task', summary: 'Done.', status: 'completed' });
			transport.posts.length = 0;
			const turn = { requestId: 'r1', prompt: 'p', summary: 's', startedAt: Date.now() - 60_000 };

			await bridge.postTurnSummary('chat-1', turn);
			await bridge.postTurnSummary('chat-1', turn);

			assert.deepStrictEqual(transport.posts, [], 'a skipped turn stays skipped');
			bridge.dispose();
		});
	});
});


// The regression the tri-state exists to prevent. A session created through the
// standalone MCP server records no identity: it cannot see VS Code, so `identityOf` reports
// "unknown". Under the old boolean this asserted "will not reach Copilot" in the footer,
// even though the relay resolves such sessions lazily and replies usually arrive. The
// footer must fall through to the normal reply invitation instead.
describe('Bridge.notify · reply invitation for an unidentified chat', () => {
	it('does not deny replies when the chat has not been identified yet', async () => {
		const transport = new FakeTransport();
		const bridge = new Bridge({
			transport,
			store: new InMemorySessionStore(),
			pollIntervalMs: 10_000,
			setTimer: () => 1,
			clearTimer: () => undefined
		});

		await bridge.notify({ sessionKey: 'mcp-only', title: 'MCP session', summary: 's', status: 'progress' });

		assert.strictEqual(transport.posts.length, 1);
		const notification = transport.posts[0].notification;
		assert.strictEqual(
			notification.repliesReachChat,
			undefined,
			'"unknown" means not yet identified, so the field must not assert the negative'
		);
		bridge.dispose();
	});

	it('still denies replies for a genuinely undeliverable harness', async () => {
		const transport = new FakeTransport();
		const bridge = new Bridge({
			transport,
			store: new InMemorySessionStore(),
			pollIntervalMs: 10_000,
			setTimer: () => 1,
			clearTimer: () => undefined
		});

		await bridge.notify({
			sessionKey: 'cli',
			title: 'CLI session',
			summary: 's',
			status: 'progress',
			identity: {
				harness: 'cli-runtime',
				chat: { kind: 'cli-debug-log', value: 'cli-session' },
				confidence: 'exact',
				capturedBy: 'mcp-ingest',
				capturedAt: new Date().toISOString()
			}
		});

		const notification = transport.posts[0].notification;
		assert.strictEqual(
			notification.repliesReachChat,
			false,
			'a harness with no adapter is still undeliverable and must say so'
		);
		bridge.dispose();
	});
});

/**
 * The live split-thread of 2026-08-29: transcript watcher opened a session for chat X
 * under `chat-<uuid>`, then the model called notify with its own key eight seconds later.
 * ensureSession only matched on key, so a second session (and a second Teams thread)
 * appeared for the same conversation. A chat is one conversation whatever key was picked.
 */
describe('Bridge.notify · one chat is one session', () => {
	const chatId = '2ed9a15a-1420-454b-8745-cd7c78da64af';
	const chatResource = `vscode-chat-session://local/${Buffer.from(chatId, 'utf8').toString('base64')}`;

	function chatIdentity(value: string): SessionIdentity {
		return {
			harness: 'vscode-sidebar' as const,
			chat: { kind: 'chat-session-resource' as const, value },
			confidence: 'exact' as const,
			capturedBy: 'chat-watcher' as const,
			capturedAt: new Date().toISOString()
		};
	}

	it('reuses the watcher-opened session when the model calls under a different key', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		// Transcript watcher announces the chat first, under `chat-<uuid>`.
		const opened = await bridge.notify({
			sessionKey: `chat-${chatId}`,
			title: 'Chat X',
			summary: 'opened',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});

		// Model then picks its own key for the same chat.
		const second = await bridge.notify({
			sessionKey: 'testing-copilot-session-1-bridge',
			title: 'Chat X',
			summary: 'now the model reports',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});

		assert.strictEqual(transport.created, 1, 'one chat, one Teams thread');
		assert.strictEqual(second.session.id, opened.session.id, 'the second call must reuse the session');
		assert.strictEqual(second.session.key, opened.session.key, 'the owning key is what the caller must quote back');
		assert.strictEqual(bridge.listSessions().length, 1);
		bridge.dispose();
	});

	it('merges when the model notifies first and the watcher announces second', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		const modelFirst = await bridge.notify({
			sessionKey: 'testing-copilot-session-1-bridge',
			title: 'Chat X',
			summary: 'model first',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});

		const watcher = await bridge.notify({
			sessionKey: `chat-${chatId}`,
			title: 'Chat X',
			summary: 'watcher second',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});

		assert.strictEqual(transport.created, 1);
		assert.strictEqual(watcher.session.id, modelFirst.session.id);
		bridge.dispose();
	});

	it('matches a legacy bare chat id against a full resource for the same chat', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		// Older session stored the bare id (as chatSessionResource) — a real record shape.
		const legacy = await bridge.notify({
			sessionKey: 'legacy',
			title: 'Chat X',
			summary: 's',
			status: 'progress',
			chatSessionResource: chatId
		});

		const modern = await bridge.notify({
			sessionKey: 'later-key',
			title: 'Chat X',
			summary: 's',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});

		assert.strictEqual(transport.created, 1, 'the two forms of the same chat must merge');
		assert.strictEqual(modern.session.id, legacy.session.id);
		bridge.dispose();
	});

	it('keeps two genuinely different chats separate', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);
		const otherId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
		const otherResource = `vscode-chat-session://local/${Buffer.from(otherId, 'utf8').toString('base64')}`;

		const a = await bridge.notify({
			sessionKey: `chat-${chatId}`,
			title: 'Chat X',
			summary: 's',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});
		const b = await bridge.notify({
			sessionKey: `chat-${otherId}`,
			title: 'Chat Y',
			summary: 's',
			status: 'progress',
			chatSessionResource: otherResource,
			identity: chatIdentity(otherResource)
		});

		assert.strictEqual(transport.created, 2);
		assert.notStrictEqual(a.session.id, b.session.id);
		bridge.dispose();
	});

	it('does not affect a session with no chat identity (agent/MCP/CLI)', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		// No chat resource, no identity.chat — the classic MCP-only shape.
		const first = await bridge.notify({ sessionKey: 'mcp-task', title: 'MCP', summary: 's', status: 'progress' });
		const second = await bridge.notify({ sessionKey: 'unrelated-mcp', title: 'MCP2', summary: 's', status: 'progress' });

		assert.strictEqual(transport.created, 2, 'without a chat, key matching alone still applies');
		assert.notStrictEqual(first.session.id, second.session.id);
		bridge.dispose();
	});

	it('lets an explicit sessionId still win over a chat match', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		const chatSession = await bridge.notify({
			sessionKey: `chat-${chatId}`,
			title: 'Chat X',
			summary: 's',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});
		const otherSession = await bridge.notify({
			sessionKey: 'other',
			title: 'Other',
			summary: 's',
			status: 'progress'
		});

		// Explicit id names the *other* session even though the call also carries this chat.
		const routed = await bridge.notify({
			sessionId: otherSession.session.id,
			sessionKey: 'anything',
			title: 'Other',
			summary: 's',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});

		assert.strictEqual(routed.session.id, otherSession.session.id);
		assert.notStrictEqual(routed.session.id, chatSession.session.id);
		bridge.dispose();
	});

	it('does not reuse a closed session that owned the chat', async () => {
		const transport = new FakeTransport();
		const bridge = makeBridge(transport);

		const opened = await bridge.notify({
			sessionKey: `chat-${chatId}`,
			title: 'Chat X',
			summary: 's',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});
		// Simulate the session being closed (the /stop path sets this flag).
		bridge.closeSession(opened.session.id);

		const next = await bridge.notify({
			sessionKey: 'fresh-key',
			title: 'Chat X again',
			summary: 's',
			status: 'progress',
			chatSessionResource: chatResource,
			identity: chatIdentity(chatResource)
		});

		assert.strictEqual(transport.created, 2, 'a closed session must never be resurrected');
		assert.notStrictEqual(next.session.id, opened.session.id);
		bridge.dispose();
	});
});
