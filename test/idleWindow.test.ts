import * as assert from 'assert';
import { describe, it } from 'node:test';
import { Bridge } from '../src/application/bridge';
import { InMemorySessionStore } from '../src/application/ports';
import type { InboundReply, OutboundNotification, PostResult, ThreadRef } from '../src/domain/types';
import type { ThreadedTransport } from '../src/application/ports';

/**
 * The two-hour window: it slides on activity from either side, closes with a notice, stops
 * costing anything while closed, and reopens when the work resumes.
 *
 * Driven by a fake clock rather than by waiting, so the boundary itself can be tested —
 * one second either side of two hours — which real time cannot do.
 */

class Transport implements ThreadedTransport {
	readonly kind = 'file' as const;
	readonly supportsReplies = true;
	posts: { thread?: string; summary: string }[] = [];
	reads: string[] = [];
	private queued: InboundReply[] = [];
	private next = 1;

	async createThread(notification: OutboundNotification): Promise<PostResult> {
		this.posts.push({ summary: notification.summary });
		return { thread: { id: 'thread-1' }, postedMessageId: `own-${this.next++}` };
	}
	async postToThread(thread: ThreadRef, notification: OutboundNotification): Promise<PostResult> {
		this.posts.push({ thread: thread.id, summary: notification.summary });
		return { thread, postedMessageId: `own-${this.next++}` };
	}
	async fetchReplies(thread: ThreadRef): Promise<InboundReply[]> {
		this.reads.push(thread.id);
		const due = this.queued;
		this.queued = [];
		return due;
	}
	queue(reply: InboundReply): void {
		this.queued.push(reply);
	}
}

const TWO_HOURS = 2 * 60 * 60 * 1000;

function build(): { transport: Transport; bridge: Bridge; advance(ms: number): void } {
	const transport = new Transport();
	let now = Date.parse('2026-08-28T09:00:00.000Z');
	const bridge = new Bridge({
		transport,
		store: new InMemorySessionStore(),
		pollIntervalMs: 10_000,
		sessionIdleMs: TWO_HOURS,
		now: () => new Date(now),
		setTimer: () => 1,
		clearTimer: () => undefined
	});
	return {
		transport,
		bridge,
		advance: (ms: number) => {
			now += ms;
		}
	};
}

async function start(bridge: Bridge, key = 'task'): Promise<void> {
	await bridge.notify({ sessionKey: key, title: 'A task', summary: 'started', status: 'progress' });
}

function replyAt(text: string): InboundReply {
	return { id: `r-${text}`, threadId: 'thread-1', text, from: 'Rob', createdAt: new Date().toISOString() };
}

describe('the two-hour window', () => {
	// The boundary itself, which is the part that cannot be checked by waiting.
	it('stays open right up to two hours and closes just after', async () => {
		const near = build();
		await start(near.bridge);
		near.advance(TWO_HOURS - 1_000);
		await near.bridge.poll();
		assert.strictEqual(near.bridge.listSessions()[0].expiredAt, undefined, 'one second early must still be live');
		near.bridge.dispose();

		const past = build();
		await start(past.bridge);
		past.advance(TWO_HOURS + 1_000);
		await past.bridge.poll();
		assert.ok(past.bridge.listSessions()[0].expiredAt, 'one second late must have closed');
		past.bridge.dispose();
	});

	// Sliding, not fixed: a reply inside the window buys another full two hours.
	it('slides on a Teams reply', async () => {
		const { transport, bridge, advance } = build();
		await start(bridge);

		advance(TWO_HOURS - 60_000);
		transport.queue(replyAt('still here'));
		await bridge.poll();
		assert.strictEqual(bridge.listSessions()[0].expiredAt, undefined, 'the reply must keep it alive');

		// Well past the ORIGINAL deadline, but inside the new one.
		advance(TWO_HOURS - 60_000);
		await bridge.poll();
		assert.strictEqual(
			bridge.listSessions()[0].expiredAt,
			undefined,
			'the window must run from the reply, not from the start'
		);
		bridge.dispose();
	});

	// The half that was missing: a conversation carried on entirely in the editor was
	// declared idle while the user was mid-sentence in it.
	it('slides on a turn taken in VS Code', async () => {
		const { bridge, advance } = build();
		await start(bridge, 'chat-abc');

		advance(TWO_HOURS - 60_000);
		const activity = bridge.recordActivity('chat-abc', 'chat-turn');
		assert.ok(activity, 'the session must be found by its key, which is what the watcher knows');
		assert.strictEqual(activity?.revived, false, 'it had not expired, so this is not a revival');

		advance(TWO_HOURS - 60_000);
		await bridge.poll();
		assert.strictEqual(bridge.listSessions()[0].expiredAt, undefined, 'an editor turn is as good as a reply');
		bridge.dispose();
	});

	// Going quiet has to be said out loud: the user is about to type into a thread that is
	// no longer being read.
	it('says so in Teams when it closes', async () => {
		const { transport, bridge, advance } = build();
		await start(bridge);
		advance(TWO_HOURS + 1_000);
		await bridge.poll();

		const session = bridge.listSessions()[0];
		await bridge.postExpiryNotice(session, 2 * 60 * 60 * 1000);

		const notice = transport.posts.find((post) => /quiet for 2 hours/i.test(post.summary));
		assert.ok(notice, 'the thread must be told it has gone quiet');
		assert.match(notice.summary, /VS Code/i, 'and where to revive it');
		bridge.dispose();
	});

	// Stopping dead is the point: one quiet session must cost nothing, while every other
	// session keeps being read.
	it('stops reading a closed thread but keeps reading the others', async () => {
		const { transport, bridge, advance } = build();
		await start(bridge, 'quiet');
		advance(TWO_HOURS + 1_000);
		await bridge.poll();
		assert.ok(bridge.listSessions()[0].expiredAt, 'the first session should have closed');

		await bridge.notify({ sessionKey: 'busy', title: 'Busy', summary: 's', status: 'progress' });
		transport.reads = [];
		await bridge.poll();
		await bridge.poll();

		assert.ok(transport.reads.length > 0, 'the live session must still be polled');
		bridge.dispose();
	});

	// And reopening has to be said out loud too, because the user was told it had stopped.
	it('reopens on a turn in VS Code and says so', async () => {
		const { transport, bridge, advance } = build();
		await start(bridge, 'chat-xyz');
		advance(TWO_HOURS + 1_000);
		await bridge.poll();
		assert.ok(bridge.listSessions()[0].expiredAt, 'it should have closed');

		const activity = bridge.recordActivity('chat-xyz', 'chat-turn');
		assert.strictEqual(activity?.revived, true, 'working in the chat must reopen it');
		assert.strictEqual(bridge.listSessions()[0].expiredAt, undefined, 'and clear the closed mark');

		await bridge.postResumedNotice(activity!.session);
		const notice = transport.posts.find((post) => /active again/i.test(post.summary));
		assert.ok(notice, 'the user was told it had stopped, so they must be told it has not');
		bridge.dispose();
	});

	// The label the user reads for a normal lifecycle event. "Failed" (the old status)
	// rendered a red X heading for an expected event, which the owner reported as
	// mislabelled and alarming — nothing failed. "Paused" states what happened truthfully.
	it('posts the expiry notice with the paused status, not failed', async () => {
		const { transport, bridge, advance } = build();
		await start(bridge);
		advance(TWO_HOURS + 1_000);
		await bridge.poll();

		const session = bridge.listSessions()[0];
		await bridge.postExpiryNotice(session, TWO_HOURS);

		const notice = transport.posts.find((post) => /quiet for/i.test(post.summary));
		assert.ok(notice, 'the expiry notice must be posted');
		// The transport records the notification, but this class captures only the
		// summary. The behaviour the paused status buys us is a truthful body: it must
		// say replies are ignored, not that they arrive when Copilot listens again.
		assert.match(notice.summary, /ignored/i, 'the body must say replies are ignored');
		assert.doesNotMatch(
			notice.summary,
			/until it is listening again/i,
			'the body must not promise deferred delivery that will never happen'
		);
		assert.doesNotMatch(
			notice.summary,
			/as soon as Copilot posts its next update/i,
			'the body must not misdescribe how reactivation works'
		);
		bridge.dispose();
	});

	// The owner tests at 1 minute; whole-hour rounding read as "0 hours" and rendered
	// as "a while", so the notice could never state the real window. Minutes below an
	// hour, hours at and above one — same helper, one rule for both message paths.
	it('formats a sub-hour window in minutes', async () => {
		const { transport, bridge, advance } = build();
		await start(bridge);
		advance(TWO_HOURS + 1_000);
		await bridge.poll();
		const session = bridge.listSessions()[0];
		await bridge.postExpiryNotice(session, 60_000);
		const notice = transport.posts.find((post) => /quiet for 1 minute/i.test(post.summary));
		assert.ok(notice, 'a one-minute window must render as "1 minute", not "0 hours" or "a while"');
		bridge.dispose();
	});

	// The resumed notice is what the user sees after coming back to VS Code. It must
	// state that anything typed while paused was not picked up, so they know to resend.
	it('resumed notice tells the user replies posted while paused were not picked up', async () => {
		const { transport, bridge, advance } = build();
		await start(bridge, 'chat-abc');
		advance(TWO_HOURS + 1_000);
		await bridge.poll();
		const activity = bridge.recordActivity('chat-abc', 'chat-turn');
		await bridge.postResumedNotice(activity!.session);
		const notice = transport.posts.find((post) => /active again/i.test(post.summary));
		assert.ok(notice);
		assert.match(
			notice.summary,
			/not picked up|was not picked up|while it was paused/i,
			'the resumed notice must say posts while paused were not picked up'
		);
		bridge.dispose();
	});
});
