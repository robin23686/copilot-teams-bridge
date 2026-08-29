import * as assert from 'assert';
import { describe, it, before, beforeEach } from 'node:test';

/**
 * Delivering when several chats are open.
 *
 * There is one mechanism: for every routed reply whose chat is known, the chat is opened
 * as an editor tab (which focuses it) and only *then* is the request written. Writing
 * before the reveal succeeded would land in whichever chat happened to be focused.
 *
 * Deliberately gone: the old "confirmed" fast path that skipped the reveal when a
 * transcript-recency heuristic claimed the target was already active. Transcript recency
 * is not proof of the focused chat — the target's transcript stays newest while the user
 * types in a different chat, which is the misrouting this exists to stop. Every known
 * target is revealed, even one reported as active.
 *
 * Because `TabInputChat` carries no session id, a successful reveal proves only that some
 * chat is in front. Delivery is therefore confirmed from the target transcript afterwards,
 * and an unproven write is never reported as a delivery.
 */

interface Call {
	command: string;
	query?: string;
	/** True when the text is only drafted into the input for the user to send. */
	draft?: boolean;
	/** The session a reveal was aimed at, for the editor-group route. */
	resource?: string;
}

let calls: Call[] = [];
/** Whether revealing a chat succeeds, standing in for the editor-group command. */
let revealSucceeds = true;
/** Whether the target transcript shows the request afterwards. */
let landed = true;
/** Sessions a reveal was requested for, in order. */
let revealed: string[] = [];

type Injector = {
	inject(routed: unknown, submit: boolean): Promise<string>;
	deliverHere(routed: unknown, submit: boolean): Promise<void>;
};
let makeInjector: () => Injector;
let makeInjectorWithLog: (logged: { info: string[]; warn: string[] }) => Injector;

let ChatInjectorCtor: new (options: unknown) => Injector;

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);

	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode'
			? {
					Uri: { parse: (value: string) => ({ toString: () => value }) },
					window: {
						showInformationMessage: () => Promise.resolve(undefined),
						showWarningMessage: () => Promise.resolve(undefined)
					},
					env: { clipboard: { writeText: () => Promise.resolve() } },
					commands: {
						executeCommand: async (command: string, arg: unknown) => {
							const options = arg as { query?: string; isPartialQuery?: boolean };
							calls.push({ command, query: options?.query, draft: options?.isPartialQuery });
						}
					}
				}
			: originalLoad(request, parent, isMain);

	const { ChatInjector } = require('../src/hosts/vscode/chatInjector') as {
		ChatInjector: new (options: unknown) => Injector;
	};
	/* eslint-enable @typescript-eslint/no-require-imports */
	Module._load = originalLoad;
	ChatInjectorCtor = ChatInjector;

	makeInjector = (): Injector =>
		new ChatInjector({
			log: { info: () => undefined, warn: () => undefined },
			holdUnroutable: () => true,
			revealChatSession: async (resource: string) => {
				revealed.push(resource);
				if (!revealSucceeds) {
					return false;
				}
				calls.push({ command: 'reveal', resource });
				return true;
			},
			confirmLanded: async () => landed
		});

	makeInjectorWithLog = (logged: { info: string[]; warn: string[] }): Injector =>
		new ChatInjectorCtor({
			log: {
				info: (message: string) => logged.info.push(message),
				warn: (message: string) => logged.warn.push(message)
			},
			holdUnroutable: () => true,
			revealChatSession: async (resource: string) => {
				revealed.push(resource);
				if (!revealSucceeds) {
					return false;
				}
				calls.push({ command: 'reveal', resource });
				return true;
			},
			confirmLanded: async () => landed
		});
});

function resourceFor(name: string): string {
	return `vscode-chat-session://local/${name}`;
}

function replyFor(name: string): unknown {
	return {
		session: {
			id: name,
			key: name,
			title: `Task ${name}`,
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'progress',
			chatSessionResource: resourceFor(name)
		},
		reply: {
			id: `r-${name}`,
			threadId: `t-${name}`,
			text: `work on ${name}`,
			from: 'Rob',
			createdAt: new Date().toISOString()
		},
		text: `work on ${name}`
	};
}

describe('delivering with several chats open', () => {
	beforeEach(() => {
		calls = [];
		revealed = [];
		revealSucceeds = true;
		landed = true;
	});

	// The reveal is the whole safety property. A known target is *always* brought forward
	// before writing, because the only pre-reveal signal available — transcript recency —
	// is not proof that the target is the focused chat.
	it('reveals the owning chat and sends when its resource is known', async () => {
		const injector = makeInjector();

		const outcome = await injector.inject(replyFor('mine'), true);

		assert.strictEqual(outcome, 'delivered');
		assert.deepStrictEqual(revealed, [resourceFor('mine')], 'the reply must steer to its own chat');
		const written = calls.filter((call) => call.command === 'workbench.action.chat.open');
		assert.strictEqual(written.length, 1, 'and then be written');
		assert.notStrictEqual(written[0].draft, true, 'and submitted, since the chat was brought to it');
	});

	// Order is the safety property: writing before the reveal succeeds would put the text
	// in whatever chat happened to be focused.
	it('reveals before writing, never after', async () => {
		const injector = makeInjector();

		await injector.inject(replyFor('mine'), true);

		const order = calls.map((call) => call.command);
		assert.strictEqual(order[0], 'reveal', 'the chat must be brought forward first');
		assert.strictEqual(order[1], 'workbench.action.chat.open', 'and only then written to');
	});

	// Regression for the misrouting fix: even a target that a caller might report as
	// "already active" (for example, because its transcript grew most recently) must still
	// be revealed before any write. Transcript recency is not proof of focus, and skipping
	// the reveal is exactly what put replies into the wrong focused chat.
	it('reveals every known target, even one a caller might report as active', async () => {
		const injector = makeInjector();

		await injector.inject(replyFor('mine'), true);
		await injector.inject(replyFor('mine'), true);

		assert.deepStrictEqual(
			revealed,
			[resourceFor('mine'), resourceFor('mine')],
			'no signal short of the reveal itself proves this is the focused chat'
		);
		const written = calls.filter((call) => call.command === 'workbench.action.chat.open');
		assert.strictEqual(written.length, 2, 'both writes must be preceded by a reveal');
	});

	// A reveal that fails leaves the wrong chat in front, so writing would misroute.
	it('writes nothing when the owning chat cannot be brought forward', async () => {
		revealSucceeds = false;
		const injector = makeInjector();

		const outcome = await injector.inject(replyFor('mine'), true);

		assert.strictEqual(outcome, 'unroutable');
		assert.deepStrictEqual(
			calls.filter((call) => call.command === 'workbench.action.chat.open'),
			[],
			'a failed reveal must not be followed by a write'
		);
	});

	// TabInputChat carries no session id, so a reveal reporting success proves only that
	// *a* chat is in front. The transcript is what proves it was the right one.
	it('does not claim delivery when the transcript cannot confirm it', async () => {
		landed = false;
		const injector = makeInjector();

		const outcome = await injector.inject(replyFor('mine'), true);

		assert.strictEqual(outcome, 'unroutable', 'an unproven delivery must not be reported as one');
	});

	// Retrying an unproven delivery would write into that same wrong conversation again.
	it('stops steering a reply whose delivery could not be proved', async () => {
		landed = false;
		const injector = makeInjector();
		const reply = replyFor('mine');

		await injector.inject(reply, true);
		revealed = [];
		calls = [];
		await injector.inject(reply, true);

		assert.deepStrictEqual(revealed, [], 'the second attempt must not steer again');
		assert.deepStrictEqual(
			calls.filter((call) => call.command === 'workbench.action.chat.open'),
			[],
			'nor write again'
		);
	});

	// A given-up reply must be terminal: reporting it as retryable again causes the harness
	// to retain it, redeliver it on the next poll, and log the same "cannot steer" line
	// every ten seconds forever, plus a repeated Teams failure notice. Returning a
	// non-retryable `abandoned` outcome is what lets the caller consume the reply once and
	// stop trying.
	it('reports a given-up reply as abandoned rather than unroutable', async () => {
		landed = false;
		const logged: { info: string[]; warn: string[] } = { info: [], warn: [] };
		const injector = makeInjectorWithLog(logged);
		const reply = replyFor('mine');

		const first = await injector.inject(reply, true);
		const explanationFirst = logged.info.filter((line) => line.startsWith('Not writing the Teams reply'));
		const warnFirst = [...logged.warn];

		const second = await injector.inject(reply, true);
		const explanationSecond = logged.info.filter((line) => line.startsWith('Not writing the Teams reply'));

		assert.strictEqual(first, 'unroutable', 'the first attempt must ask the caller to retain and notify');
		assert.strictEqual(
			second,
			'abandoned',
			'the second attempt must be terminal so the caller stops retaining and re-notifying'
		);
		// The "Not writing the Teams reply for ..." explanation is what a user reads. It
		// used to appear on every ten-second poll while the caller retained the reply — the
		// terminal outcome is what stops that. The trace line ([route] outcome=...) still
		// fires per attempt, but the caller consumes the reply after abandoned so this call
		// site never runs again.
		assert.deepStrictEqual(
			explanationSecond,
			explanationFirst,
			'the "Not writing the Teams reply" line must not repeat on the retry'
		);
		// The transcript-unconfirmed warning is a first-time diagnostic; a second attempt
		// on the same reply must not re-log it, or the user gets the same alarm every poll.
		assert.deepStrictEqual(
			logged.warn,
			warnFirst,
			'the transcript-unconfirmed warning must not repeat on the retry'
		);
	});

	// Without a chat on record there is nothing to reveal, so the old guard still applies.
	it('writes nothing when no chat is recorded for the reply', async () => {
		const injector = makeInjector();
		const orphan = replyFor('mine') as { session: { chatSessionResource?: string } };
		orphan.session.chatSessionResource = undefined;

		const outcome = await injector.inject(orphan, true);

		assert.strictEqual(outcome, 'unroutable');
		assert.deepStrictEqual(revealed, [], 'there is nothing to steer to');
		assert.deepStrictEqual(
			calls.filter((call) => call.command === 'workbench.action.chat.open'),
			[],
			'and nothing may be written on a guess'
		);
	});

	// Ten chats, ten replies. Every one gets its own reveal — there is no fast path that
	// could quietly drop one and let it land in whatever chat happened to be focused.
	it('reveals every reply when many chats are in play', async () => {
		const injector = makeInjector();
		const names = Array.from({ length: 10 }, (_, index) => `chat-${index}`);

		for (const name of names) {
			await injector.inject(replyFor(name), true);
		}

		assert.deepStrictEqual(
			revealed,
			names.map(resourceFor),
			'every reply must reveal its own chat first'
		);
		const delivered = calls.filter((call) => call.command === 'workbench.action.chat.open');
		assert.strictEqual(delivered.length, 10, 'every reply must be delivered');
		assert.strictEqual(
			delivered.filter((call) => call.draft === true).length,
			0,
			'each reply was steered to its own chat, so none should have needed drafting'
		);
	});

	// With steering turned off — `replyTargeting: sidebarOnly` — the guard is all there is,
	// so a reply that cannot be revealed must never be written into whatever is focused.
	it('writes nothing when steering is off', async () => {
		revealSucceeds = false;
		const injector = makeInjector();

		const outcome = await injector.inject(replyFor('mine'), true);

		assert.strictEqual(outcome, 'unroutable');
		assert.deepStrictEqual(
			calls.filter((call) => call.command === 'workbench.action.chat.open'),
			[],
			'a failed reveal must not be written into'
		);
	});

	// The escape hatch: the user looked at the notification, put the chat they want in
	// front, and asked for it. Consent is the only thing that licenses an unproven write.
	it('writes to the focused chat when the user explicitly asks', async () => {
		revealSucceeds = false;
		const injector = makeInjector();
		const reply = replyFor('mine');

		assert.strictEqual(await injector.inject(reply, true), 'unroutable');
		await injector.deliverHere(reply, true);

		const delivered = calls.filter((call) => call.command === 'workbench.action.chat.open');
		assert.strictEqual(delivered.length, 1, 'consent must deliver exactly once');
		assert.notStrictEqual(delivered[0].draft, true, 'and send it, since the user chose this chat');
	});

	// Retries keep running until something consumes the reply, so a consented delivery must
	// not be repeated into whatever chat is in front on the next poll.
	it('does not write a consented reply a second time', async () => {
		const injector = makeInjector();
		const reply = replyFor('mine');

		await injector.deliverHere(reply, true);
		const outcome = await injector.inject(reply, true);

		assert.strictEqual(outcome, 'delivered', 'so the caller stops retaining it');
		assert.strictEqual(
			calls.filter((call) => call.command === 'workbench.action.chat.open').length,
			1,
			'the instruction must appear once, not once per poll'
		);
		assert.deepStrictEqual(revealed, [], 'and a consented reply must not steer anything');
	});
});
