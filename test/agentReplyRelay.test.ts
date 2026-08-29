import * as assert from 'assert';
import { describe, it, before } from 'node:test';
import { useTempHome } from './support/tempHome';

// The relay itself falls back to noopDeliveredRepliesRegistry when no registry is supplied,
// so this is defensive: any registry construction added later — or brought in by a
// transitive import — would otherwise resolve its path from the real home.
useTempHome('ctb-relay-home-');

/**
 * The MCP server cannot wake an agent whose turn has ended, so its replies waited in a
 * queue until the user came back and typed something. The extension can open a chat
 * request and is always running, so it delivers on the server’s behalf.
 */

// One stub shared by every test, because Node caches the module after the first require
// and a per-test stub would leave later tests pointed at the first test’s store.
let storeContents = '[]';
let delivered: { text: string; session: { chatSessionResource?: string } }[] = [];
let resolveChat: () => Promise<string | undefined> = async () => undefined;
/** What Teams hands back when the extension reads a thread the MCP server owns. */
/** What the chat reports back; the tests about retention set it to 'unroutable'. */
let outcome: 'delivered' | 'held' | 'unroutable' | 'failed' = 'delivered';
/** Runs while a reply is being handed over, to stand in for the other process writing. */
let duringDelivery: () => void = () => undefined;
/** Captures what the relay reports, for the tests about noisy failures. */
let warned: (message: string) => void = () => undefined;
/** Captures info logs, for tests about outcomes that must stay traceable. */
let noted: (message: string) => void = () => undefined;
let threadReplies: () => Promise<{ id: string; threadId: string; text: string; from: string; createdAt: string }[]> =
	async () => [];

type Relay = { drain(): Promise<void>; dispose(): void; reactivate(sessionKey: string): Promise<unknown> };
let makeRelay: (extra?: {
	deliveredReplies?: { claim(id: string): boolean; release(id: string): void; has(id: string): boolean };
	idleMs?: number;
	onExpired?: (session: { id: string; title: string }) => void;
}) => Relay;

before(() => {
	// require(): the interception must happen at runtime, after the stub is built.
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);
	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode'
			? {
					Uri: { file: (p: string) => ({ fsPath: p }) },
					workspace: {
						createFileSystemWatcher: () => ({
							onDidChange: () => ({ dispose: () => undefined }),
							dispose: () => undefined
						}),
						fs: {
							readFile: async () => Buffer.from(storeContents),
							writeFile: async (_uri: unknown, content: Uint8Array) => {
								storeContents = Buffer.from(content).toString();
							}
						}
					}
				}
			: originalLoad(request, parent, isMain);

	const { AgentReplyRelay } = require('../src/hosts/vscode/agentReplyRelay') as {
		AgentReplyRelay: new (deps: Record<string, unknown>) => Relay;
	};
	/* eslint-enable @typescript-eslint/no-require-imports */
	Module._load = originalLoad;

	makeRelay = (extra): Relay =>
		new AgentReplyRelay({
			storeUri: { fsPath: 'sessions.json' },
			deliver: async (routed: { text: string; session: { chatSessionResource?: string } }) => {
				delivered.push(routed);
				duringDelivery();
				return outcome;
			},
			log: { info: (message: string) => noted(message), warn: (message: string) => warned(message), debug: () => undefined },
			intervalMs: () => 10_000,
			enabled: () => true,
			resolveChatSession: () => resolveChat(),
			fetchReplies: () => threadReplies(),
			deliveredReplies: extra?.deliveredReplies,
			idleMs: extra?.idleMs !== undefined ? () => extra.idleMs as number : undefined,
			onExpired: extra?.onExpired
		});
});

function sessionWith(pending: { id: string; text: string }[], key = 'icm'): string {
	return JSON.stringify([
		{
			id: 's1',
			key,
			title: 'IcM report',
			thread: { id: 't1' },
			createdAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			seenReplyIds: [],
			status: 'completed',
			pending: pending.map((p) => ({
				reply: { id: p.id, threadId: 't1', text: p.text, from: 'Rob', createdAt: new Date().toISOString() },
				text: p.text
			}))
		}
	]);
}

function reset(pending: { id: string; text: string }[]): void {
	storeContents = sessionWith(pending);
	delivered = [];
	// Identifiable by default; the tests that care about an unknown chat say so.
	resolveChat = async () => 'vscode-chat-session://local/ZGVmYXVsdA==';
	// Silent by default; the tests about reading a thread say what Teams is holding.
	threadReplies = async () => [];
	warned = () => undefined;
	noted = () => undefined;
	duringDelivery = () => undefined;
	outcome = 'delivered';
}

describe('AgentReplyRelay', () => {
	it('delivers replies an agent session could not act on', async () => {
		reset([{ id: 'r1', text: 'did you prepare the report?' }]);
		const relay = makeRelay();

		await relay.drain();

		assert.strictEqual(delivered.length, 1, 'a queued reply must reach the chat');
		assert.match(delivered[0].text, /prepare the report/);
		relay.dispose();
	});

	// The bug this was written for: the MCP server is spawned per tool call and exits, so
	// for most of a session's life nothing was reading its threads and a reply simply sat
	// in Teams unread. Nothing queued it, so no amount of draining would ever find it.
	it('reads a thread the MCP server was not running to read', async () => {
		reset([]);
		threadReplies = async () => [
			{ id: 'r9', threadId: 't1', text: 'is the report prepared?', from: 'Rob', createdAt: '2026-01-01T00:00:00Z' }
		];
		const relay = makeRelay();

		await relay.drain();

		assert.strictEqual(delivered.length, 1, 'a reply nobody queued must still arrive');
		assert.match(delivered[0].text, /report prepared/);
		relay.dispose();
	});

	// Both processes can now read the same thread, so the same reply can be seen twice.
	// Acting on an instruction twice is worse than acting on it late.
	it('does not act twice on a reply both processes saw', async () => {
		reset([]);
		threadReplies = async () => [
			{ id: 'r9', threadId: 't1', text: 'only once please', from: 'Rob', createdAt: '2026-01-01T00:00:00Z' }
		];
		const relay = makeRelay();

		await relay.drain();
		// The MCP server starts, sees the same reply and queues it, unaware it was handled.
		const store = JSON.parse(storeContents);
		store[0].pending = [
			{
				reply: { id: 'r9', threadId: 't1', text: 'only once please', from: 'Rob', createdAt: '2026-01-01T00:00:00Z' },
				text: 'only once please'
			}
		];
		storeContents = JSON.stringify(store);
		await relay.drain();

		assert.strictEqual(delivered.length, 1, 'the instruction must be acted on once');
		assert.ok(!JSON.parse(storeContents)[0].pending, 'the duplicate should be cleared, not left to retry');
		relay.dispose();
	});

	// A session's own reads must not be repeated either, or every pass would deliver again.
	it('reads each reply from a thread only once', async () => {
		reset([]);
		threadReplies = async () => [
			{ id: 'r9', threadId: 't1', text: 'same reply every time', from: 'Rob', createdAt: '2026-01-01T00:00:00Z' }
		];
		const relay = makeRelay();

		await relay.drain();
		await relay.drain();
		await relay.drain();

		assert.strictEqual(delivered.length, 1, 'a thread that keeps returning a reply must not repeat it');
		relay.dispose();
	});

	// A reply with nothing in it is never queued, so nothing downstream records it. Without
	// its own note the relay would fetch and discard the same message on every single pass.
	it('remembers a reply it read but had no reason to queue', async () => {
		reset([]);
		threadReplies = async () => [
			{ id: 'r7', threadId: 't1', text: '   ', from: 'Rob', createdAt: '2026-01-01T00:00:00Z' }
		];
		const relay = makeRelay();

		await relay.drain();

		assert.strictEqual(delivered.length, 0, 'an empty reply is not an instruction');
		const stored = JSON.parse(storeContents)[0];
		assert.ok(stored.seenReplyIds.includes('r7'), 'it should not be read again on every pass');
		relay.dispose();
	});

	// The bug that destroyed four real instructions on 2026-08-27. The chat could not be
	// identified, so nothing acted on the reply -- but it was consumed anyway and written
	// into deliveredReplyIds, which is a permanent tombstone. The user had already been
	// told 'Got it -- working on this'.
	it('keeps a reply that no chat accepted', async () => {
		reset([{ id: 'r1', text: 'do not wait for my approval' }]);
		outcome = 'unroutable';
		const relay = makeRelay();

		await relay.drain();

		const stored = JSON.parse(storeContents)[0];
		assert.strictEqual(stored.pending?.length, 1, 'an undelivered reply must not be consumed');
		assert.ok(
			!(stored.deliveredReplyIds ?? []).includes('r1'),
			'it must not be tombstoned as delivered, or it can never be retried'
		);
		relay.dispose();
	});

	// Retaining it is only useful if it is actually tried again once the chat is known.
	it('delivers a retained reply once its chat is identified', async () => {
		reset([{ id: 'r1', text: 'post to teams on every turn' }]);
		outcome = 'unroutable';
		const relay = makeRelay();
		await relay.drain();
		assert.strictEqual(delivered.length, 1, 'it was attempted');

		// The user opens the chat, so the next pass can route it.
		outcome = 'delivered';
		await relay.drain();

		assert.strictEqual(delivered.length, 2, 'the retained reply must be tried again');
		const stored = JSON.parse(storeContents)[0];
		assert.ok(!stored.pending, 'and consumed once it was accepted');
		assert.ok((stored.deliveredReplyIds ?? []).includes('r1'), 'and only then tombstoned');
		relay.dispose();
	});

	// A transient failure is not a reason to lose an instruction either.
	it('keeps a reply the chat failed to accept', async () => {
		reset([{ id: 'r1', text: 'keep 2 hrs for now' }]);
		outcome = 'failed';
		const relay = makeRelay();

		await relay.drain();

		const stored = JSON.parse(storeContents)[0];
		assert.strictEqual(stored.pending?.length, 1, 'a failed delivery must be retried');
		relay.dispose();
	});

	// A thread that has gone for good would otherwise repeat its failure every few seconds
	// and bury every other line in the log.
	it('warns once about a thread it cannot read', async () => {
		reset([]);
		const warnings: string[] = [];
		warned = (message: string) => warnings.push(message);
		threadReplies = async () => {
			throw new Error('UnknownError');
		};
		const relay = makeRelay();

		await relay.drain();
		await relay.drain();
		await relay.drain();

		assert.strictEqual(warnings.length, 1, 'a broken thread should be reported once, not every pass');
		assert.match(warnings[0], /IcM report/, 'the warning should name the session');
		relay.dispose();
	});

	// Delivering twice would repeat the instruction, which is worse than delivering late.
	it('clears what it delivered so nothing is repeated', async () => {
		reset([{ id: 'r1', text: 'only once' }]);
		const relay = makeRelay();

		await relay.drain();
		await relay.drain();

		assert.strictEqual(delivered.length, 1);
		const stored = JSON.parse(storeContents)[0];
		assert.ok(!stored.pending, 'the queue should be empty');
		// Removing it is not enough: the server still holds it in memory and would write it
		// back, which is what caused the same instruction to be injected every few seconds.
		assert.deepStrictEqual(stored.deliveredReplyIds, ['r1'], 'the delivery must be recorded');
		relay.dispose();
	});

	// The server owns the file and may write to it while replies are being delivered.
	it('keeps a reply that arrived while it was delivering', async () => {
		reset([{ id: 'r1', text: 'first' }]);
		const relay = makeRelay();

		// Written mid-delivery, which is the moment that matters: the reply is already
		// out of the queue this pass read, so only a fresh re-read can preserve it.
		duringDelivery = () => {
			storeContents = sessionWith([{ id: 'r1', text: 'first' }, { id: 'r2', text: 'second' }]);
			duringDelivery = () => undefined;
		};
		await relay.drain();

		const remaining = JSON.parse(storeContents)[0].pending ?? [];
		assert.strictEqual(remaining.length, 1, 'the newer reply must survive');
		assert.strictEqual(remaining[0].reply.id, 'r2');
		relay.dispose();
	});

	// An agent session records no chat of its own, so without this the reply goes to
	// whichever chat is focused — which is how one task's instruction reached another.
	it('addresses the reply to the chat that started the session', async () => {
		reset([{ id: 'r1', text: 'did you prepare the report?' }]);
		resolveChat = async () => 'vscode-chat-session://local/b3duaW5n';
		const relay = makeRelay();

		await relay.drain();

		assert.strictEqual(delivered[0].session.chatSessionResource, 'vscode-chat-session://local/b3duaW5n');
		relay.dispose();
	});

	// Guessing is what caused the problem: the transcript naming the chat is only written
	// when the turn ends, so a reply that beats it must wait rather than be misdelivered.
	it('waits rather than send an unidentified reply to the wrong chat', async () => {
		reset([{ id: 'r1', text: 'anyone there?' }]);
		resolveChat = async () => undefined;
		const relay = makeRelay();

		await relay.drain();

		assert.strictEqual(delivered.length, 0, 'an unaddressed reply must not be delivered yet');
		assert.strictEqual(JSON.parse(storeContents)[0].pending.length, 1, 'it must stay queued');
		relay.dispose();
	});

	// Waiting forever would strand a reply whose chat the user has deleted.
	it('gives up waiting and delivers unaddressed', async () => {
		reset([{ id: 'r1', text: 'anyone there?' }]);
		resolveChat = async () => undefined;
		const relay = makeRelay();

		for (let pass = 0; pass < 4; pass++) {
			await relay.drain();
		}

		assert.strictEqual(delivered.length, 1, 'the reply must eventually arrive');
		assert.strictEqual(delivered[0].session.chatSessionResource, undefined);
		relay.dispose();
	});

	// The bug of 2026-08-28: an MCP-server session whose key was minted as `chat-<uuid>`
	// by the transcript watcher had no chatSessionResource, so identityOf() saw "unknown",
	// HoldAdapter refused, and the reply was held forever. The key itself is authoritative
	// — it literally contains the chat id — so it must fill the gap here.
	it('routes a session by the chat id embedded in its key', async () => {
		storeContents = sessionWith(
			[{ id: 'r1', text: 'reply for a bridge-created chat session' }],
			'chat-0bc44a6c-3348-475b-a9c5-30e32a4d79dd'
		);
		delivered = [];
		threadReplies = async () => [];
		warned = () => undefined;
		duringDelivery = () => undefined;
		outcome = 'delivered';
		// Falsely returns nothing, so a pass requires the key to be the sole source.
		resolveChat = async () => undefined;
		const relay = makeRelay();

		await relay.drain();

		assert.strictEqual(delivered.length, 1, 'the reply must be routed, not held');
		assert.strictEqual(
			delivered[0].session.chatSessionResource,
			// The exact form VS Code writes, so downstream reveal and comparison work.
			'vscode-chat-session://local/' +
				Buffer.from('0bc44a6c-3348-475b-a9c5-30e32a4d79dd', 'utf8').toString('base64'),
			'the recovered resource must match the chat id encoded in the key'
		);
		relay.dispose();
	});

	// The bug this whole idle window addresses: the MCP store had no idle logic at all,
	// so the relay kept collecting and dispatching replies for a session that had gone
	// quiet hours earlier — the exact behaviour the owner requires ends at the window.
	it('stops collecting and dispatching once a session is idle past the window', async () => {
		const idle = 60_000;
		const oldActivity = new Date(Date.now() - idle - 1_000).toISOString();
		// Session is idle; a pending reply that beat the expiry check must be dropped, and
		// a thread read after expiry must not be dispatched even if it returns something.
		storeContents = JSON.stringify([
			{
				id: 's-idle',
				key: 'idle-task',
				title: 'Idle task',
				thread: { id: 't-idle' },
				createdAt: oldActivity,
				lastActivityAt: oldActivity,
				seenReplyIds: [],
				status: 'progress',
				pending: [
					{
						reply: { id: 'r-late', threadId: 't-idle', text: 'still queued', from: 'Rob', createdAt: oldActivity },
						text: 'still queued'
					}
				]
			}
		]);
		delivered = [];
		threadReplies = async () => [
			{ id: 'r-new', threadId: 't-idle', text: 'typed after expiry', from: 'Rob', createdAt: new Date().toISOString() }
		];
		outcome = 'delivered';
		let expiredCount = 0;
		const relay = makeRelay({ idleMs: idle, onExpired: () => { expiredCount++; } });

		await relay.drain();

		assert.strictEqual(delivered.length, 0, 'nothing must be dispatched for a session idle beyond the window');
		const stored = JSON.parse(storeContents)[0];
		assert.ok(stored.expiredAt, 'expiredAt must be persisted so the state is visible across polls');
		assert.strictEqual(expiredCount, 1, 'the expiry notice must fire exactly once');
		assert.ok(!stored.pending, 'the queue must be dropped, not left to be delivered on reactivation');
		relay.dispose();
	});

	// A common failure mode: expiry fires per poll, so the user gets the same alarming
	// notice over and over. The state is persisted, and the process also guards its own
	// firing to avoid a rewrite-then-re-notify loop.
	it('fires the expiry notice once, not on every poll', async () => {
		const idle = 60_000;
		const old = new Date(Date.now() - idle - 1_000).toISOString();
		storeContents = JSON.stringify([
			{
				id: 's-quiet',
				key: 'quiet',
				title: 'Quiet task',
				thread: { id: 't1' },
				createdAt: old,
				lastActivityAt: old,
				seenReplyIds: [],
				status: 'progress'
			}
		]);
		delivered = [];
		threadReplies = async () => [];
		let expiredCount = 0;
		const relay = makeRelay({ idleMs: idle, onExpired: () => { expiredCount++; } });

		await relay.drain();
		await relay.drain();
		await relay.drain();

		assert.strictEqual(expiredCount, 1, 'the expiry notice must fire exactly once across polls');
		relay.dispose();
	});

	// Reactivation must clear expiredAt AND advance the watermark, or a reply typed while
	// the thread was paused would be delivered late — contradicting what the user was told.
	it('reactivation clears expiredAt, advances the watermark, and drops replies queued while expired', async () => {
		const idle = 60_000;
		const old = new Date(Date.now() - idle - 1_000).toISOString();
		const staleLastReply = new Date(Date.now() - 2 * idle).toISOString();
		storeContents = JSON.stringify([
			{
				id: 's-1',
				key: 'idle-task',
				title: 'Idle task',
				thread: { id: 't1' },
				createdAt: old,
				lastActivityAt: old,
				lastReplyAt: staleLastReply,
				seenReplyIds: [],
				status: 'progress',
				expiredAt: new Date(Date.now() - 1_000).toISOString(),
				pending: [
					{
						reply: { id: 'r-while-paused', threadId: 't1', text: 'queued while paused', from: 'Rob', createdAt: old },
						text: 'queued while paused'
					}
				]
			}
		]);
		const relay = makeRelay({ idleMs: idle });

		const before = Date.now();
		const revived = await relay.reactivate('idle-task');
		const after = Date.now();

		assert.ok(revived, 'a reactivated session must be returned so the caller can post a resumed notice');
		const stored = JSON.parse(storeContents)[0];
		assert.strictEqual(stored.expiredAt, undefined, 'expiredAt must be cleared');
		const watermarkMs = Date.parse(stored.lastReplyAt);
		assert.ok(
			watermarkMs >= before && watermarkMs <= after,
			'the watermark must be advanced to the reactivation instant so older replies are skipped'
		);
		assert.ok(!stored.pending, 'anything queued while paused must be dropped, not delivered late');
		const activityMs = Date.parse(stored.lastActivityAt);
		assert.ok(activityMs >= before && activityMs <= after, 'lastActivityAt must be set to now');
		relay.dispose();
	});

	// Match by the same helper the delivery path uses so the two sides agree.
	it('reactivates a session whose key names a chat resource', async () => {
		const idle = 60_000;
		const old = new Date(Date.now() - idle - 1_000).toISOString();
		storeContents = JSON.stringify([
			{
				id: 's-chat',
				key: 'chat-0bc44a6c-3348-475b-a9c5-30e32a4d79dd',
				title: 'Chat task',
				thread: { id: 't1' },
				createdAt: old,
				lastActivityAt: old,
				seenReplyIds: [],
				status: 'progress',
				expiredAt: new Date(Date.now() - 1_000).toISOString()
			}
		]);
		const relay = makeRelay({ idleMs: idle });

		const revived = await relay.reactivate('chat-0bc44a6c-3348-475b-a9c5-30e32a4d79dd');

		assert.ok(revived, 'a chat-keyed session must be matched by its own key');
		assert.strictEqual(JSON.parse(storeContents)[0].expiredAt, undefined);
		relay.dispose();
	});


	// Fix 2 to the "will not reach Copilot" regression. The relay used to resolve the chat
	// on every pass without writing it back, so identityOf kept reporting "unknown" and
	// every later notification repeated the wrong footer even after replies had been
	// delivered successfully. The resolution must be persisted so the session self-corrects.
	it('persists a chat resolved from a chat-<uuid> key so the session self-corrects', async () => {
		storeContents = sessionWith(
			[{ id: 'r1', text: 'reply for a bridge-created chat session' }],
			'chat-0bc44a6c-3348-475b-a9c5-30e32a4d79dd'
		);
		delivered = [];
		threadReplies = async () => [];
		resolveChat = async () => undefined;
		outcome = 'delivered';
		const relay = makeRelay();

		await relay.drain();

		const stored = JSON.parse(storeContents)[0];
		assert.strictEqual(
			stored.chatSessionResource,
			'vscode-chat-session://local/' + Buffer.from('0bc44a6c-3348-475b-a9c5-30e32a4d79dd', 'utf8').toString('base64'),
			'the resource decoded from the key must be written back into the store'
		);
		relay.dispose();
	});

	it('persists a chat resolved by transcript search', async () => {
		reset([{ id: 'r1', text: 'and again' }]);
		resolveChat = async () => 'vscode-chat-session://local/dHJhbnNjcmlwdA==';
		const relay = makeRelay();

		await relay.drain();

		const stored = JSON.parse(storeContents)[0];
		assert.strictEqual(
			stored.chatSessionResource,
			'vscode-chat-session://local/dHJhbnNjcmlwdA==',
			'a transcript-resolved chat must be written back too'
		);
		relay.dispose();
	});

	// The store is authoritative: a resource the MCP server or transcript watcher has
	// already recorded must never be second-guessed by a later resolution here.
	it('does not overwrite an existing chatSessionResource in the store', async () => {
		const existing = 'vscode-chat-session://local/ZXhpc3Rpbmc=';
		storeContents = JSON.stringify([
			{
				id: 's1',
				key: 'chat-0bc44a6c-3348-475b-a9c5-30e32a4d79dd',
				title: 'IcM report',
				thread: { id: 't1' },
				chatSessionResource: existing,
				createdAt: new Date().toISOString(),
				lastActivityAt: new Date().toISOString(),
				seenReplyIds: [],
				status: 'progress',
				pending: [
					{ reply: { id: 'r1', threadId: 't1', text: 'x', from: 'Rob', createdAt: new Date().toISOString() }, text: 'x' }
				]
			}
		]);
		delivered = [];
		threadReplies = async () => [];
		resolveChat = async () => 'vscode-chat-session://local/b3RoZXI=';
		outcome = 'delivered';
		const relay = makeRelay();

		await relay.drain();

		assert.strictEqual(
			JSON.parse(storeContents)[0].chatSessionResource,
			existing,
			'an existing resource is authoritative and must not be second-guessed'
		);
		relay.dispose();
	});

	// The end-to-end confirmation for fix 1+2 together: once the resource is written back,
	// `identityOf` sees it and reports a deliverable identity, so `repliesReachChat` is
	// true and the next notification no longer denies replies.
	it('makes a subsequent identityOf report a deliverable identity', async () => {
		// Local imports so this test does not force them on the file, and the vscode stub
		// installed by the shared `before` block remains the only vscode substitute.
		/* eslint-disable @typescript-eslint/no-require-imports */
		const { identityOf, repliesReachChat } = require('../src/application/services/harness') as {
			identityOf: (session: unknown) => { harness: string; confidence: string; chat?: unknown };
			repliesReachChat: (identity: { harness: string; confidence: string; chat?: unknown }) => boolean;
		};
		/* eslint-enable @typescript-eslint/no-require-imports */

		storeContents = sessionWith(
			[{ id: 'r1', text: 'anything' }],
			'chat-0bc44a6c-3348-475b-a9c5-30e32a4d79dd'
		);
		delivered = [];
		threadReplies = async () => [];
		resolveChat = async () => undefined;
		outcome = 'delivered';
		const relay = makeRelay();

		await relay.drain();

		const stored = JSON.parse(storeContents)[0];
		const identity = identityOf(stored);
		assert.notStrictEqual(identity.harness, 'unknown', 'the harness is no longer unknown once the chat is on record');
		assert.notStrictEqual(identity.confidence, 'unknown', 'and the identity is deliverable');
		assert.strictEqual(repliesReachChat(identity), true, 'so the next footer will invite a reply, not deny it');
		relay.dispose();
	});

	// Root cause 2 of the 2026-08-29 silent failure: the warning was logged every ten
	// seconds forever, because a retained reply for a chat that cannot be identified from
	// this window would exhaust the resolution passes on every pass. The conclusion must
	// be logged once per reply id, not once per pass.
	it('logs the unidentified-chat conclusion once per reply, not once per pass', async () => {
		reset([{ id: 'r-noise', text: 'agent, do the thing' }]);
		resolveChat = async () => undefined;
		outcome = 'unroutable';
		const warnings: string[] = [];
		warned = (message: string) => warnings.push(message);
		const relay = makeRelay();

		// Enough passes for the resolution to be exhausted and several more polls afterwards.
		for (let pass = 0; pass < 8; pass++) {
			await relay.drain();
		}

		const unidentified = warnings.filter((message) => /Could not identify the chat/i.test(message));
		assert.strictEqual(unidentified.length, 1, 'the "chat could not be identified" warning must fire once');
		assert.match(
			unidentified[0],
			/queued for the agent/i,
			'and it must state what actually happens — the reply is left queued, not written into an unrelated chat'
		);
		assert.ok(
			!/focused chat/i.test(unidentified[0]),
			'and must not claim delivery to the focused chat, which HoldAdapter refuses'
		);
		relay.dispose();
	});

	// Root cause 3: an agent/CLI session has no VS Code chat, so re-attempting delivery
	// every poll only re-runs the same failure. The reply must stay in `pending` — the
	// queue an agent collects from via teams_check_replies — but the deliver call must
	// stop.
	it('parks a reply once delivery has proven un-routable, leaving it queued for the agent', async () => {
		reset([{ id: 'r-park', text: 'still needs doing' }]);
		resolveChat = async () => undefined;
		outcome = 'unroutable';
		const relay = makeRelay();

		// One extra pass past the resolution window, so the first deliver runs and parks.
		for (let pass = 0; pass < 4; pass++) {
			await relay.drain();
		}
		const deliveredAfterPark = delivered.length;
		// Several more passes; a parked reply must not be re-delivered.
		for (let pass = 0; pass < 4; pass++) {
			await relay.drain();
		}

		assert.strictEqual(
			delivered.length,
			deliveredAfterPark,
			'a parked reply must not be handed to the chat again on later passes'
		);
		const stored = JSON.parse(storeContents)[0];
		assert.strictEqual(stored.pending?.length, 1, 'and it must remain in pending so the agent still collects it');
		assert.strictEqual(stored.pending[0].reply.id, 'r-park');
		assert.ok(
			!(stored.deliveredReplyIds ?? []).includes('r-park'),
			'and must not be tombstoned as delivered, or it could never be retried'
		);
		relay.dispose();
	});

	// The un-park half of the same rule: if the session later gains a chatSessionResource
	// — the user may have opened the chat, or a concurrent process persisted the identity
	// — the parked reply must be tried again rather than stranded.
	it('un-parks a reply once the session gains a chatSessionResource', async () => {
		reset([{ id: 'r-unpark', text: 'ready when you are' }]);
		resolveChat = async () => undefined;
		outcome = 'unroutable';
		const relay = makeRelay();

		for (let pass = 0; pass < 4; pass++) {
			await relay.drain();
		}
		const deliveredBefore = delivered.length;

		// The user opens the chat: the resource is now on record and delivery succeeds.
		const store = JSON.parse(storeContents);
		store[0].chatSessionResource = 'vscode-chat-session://local/dW5wYXJr';
		storeContents = JSON.stringify(store);
		outcome = 'delivered';

		await relay.drain();

		assert.strictEqual(delivered.length, deliveredBefore + 1, 'the parked reply must be tried again');
		const stored = JSON.parse(storeContents)[0];
		assert.ok(!stored.pending, 'and consumed once it was accepted');
		assert.ok((stored.deliveredReplyIds ?? []).includes('r-unpark'), 'and only then tombstoned');
		relay.dispose();
	});

	// The parking rule must not swallow a reply the other delivery path has already
	// claimed: that reply is genuinely accounted for and must be consumed, not left in
	// pending forever.
	it('still consumes a reply already claimed by the other bridge path', async () => {
		reset([{ id: 'r-claimed', text: 'the extension already handled this' }]);
		resolveChat = async () => undefined;
		// If the parking check ran first, the deliver call would never happen and the
		// claims check below could never consume it.
		outcome = 'unroutable';
		const claimed = new Set<string>(['r-claimed']);
		const relay = makeRelay({
			deliveredReplies: {
				claim: () => true,
				release: () => undefined,
				has: (id: string) => claimed.has(id)
			}
		});

		await relay.drain();
		await relay.drain();

		assert.strictEqual(delivered.length, 0, 'a claimed reply must never be handed to the chat here');
		const stored = JSON.parse(storeContents)[0];
		assert.ok(!stored.pending, 'and it must be cleared from the queue rather than left forever');
		assert.deepStrictEqual(stored.deliveredReplyIds, ['r-claimed'], 'and recorded as delivered');
		relay.dispose();
	});
});
