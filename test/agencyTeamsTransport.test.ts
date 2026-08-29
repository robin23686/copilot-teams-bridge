import * as assert from 'assert';
import { EventEmitter } from 'events';
import { describe, it, after } from 'node:test';
import { useTempHome } from './support/tempHome';

// Redirect the shared registry files onto a scratch directory before the transport is
// loaded, so tests neither read from nor write to the developer's home folder.
const tempHome = useTempHome('ctb-agency-');

import { AgencyTeamsTransport } from '../src/infrastructure/transports/agencyTeamsTransport';
import { noopPostedMessagesRegistry } from '../src/infrastructure/postedMessages';
import type { OutboundNotification } from '../src/domain/types';

const notification: OutboundNotification = {
	sessionId: 's1',
	title: 'Task A',
	summary: 'All done.',
	status: 'completed'
};

/** Stands in for the Agency MCP subprocess, replying to JSON-RPC on stdin. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly calls: { name: string; args: Record<string, unknown> }[] = [];
	killed = false;

	constructor(private readonly responder: (name: string, args: Record<string, unknown>) => unknown) {
		super();
	}

	readonly stdin = {
		write: (line: string): void => {
			const request = JSON.parse(line) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

			if (request.method === 'initialize') {
				this.reply({ id: request.id, result: { serverInfo: { name: 'fake' } } });
				return;
			}
			if (request.method === 'tools/call') {
				const name = request.params?.name ?? '';
				const args = request.params?.arguments ?? {};
				this.calls.push({ name, args });
				try {
					const payload = this.responder(name, args);
					this.reply({ id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } });
				} catch (error) {
					this.reply({
						id: request.id,
						result: { content: [{ type: 'text', text: (error as Error).message }], isError: true }
					});
				}
			}
		}
	};

	private reply(message: unknown): void {
		// Asynchronous, like a real process writing to a pipe.
		setImmediate(() => this.stdout.emit('data', `${JSON.stringify(message)}\n`));
	}

	kill(): void {
		this.killed = true;
	}
}

function makeTransport(responder: (name: string, args: Record<string, unknown>) => unknown): { transport: AgencyTeamsTransport; child: FakeChild } {
	const child = new FakeChild(responder);
	// setEncoding is called on the real streams; the fakes only need to tolerate it.
	(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
	(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

	const transport = new AgencyTeamsTransport({
		teamId: 'team-1',
		channelId: 'channel-1',
		requestTimeoutMs: 2_000,
		spawnImpl: (() => child) as never,
		// Kept off the user's disk during tests, so posts from one test do not appear as
		// self-posts in another.
		postedMessages: noopPostedMessagesRegistry
	});
	return { transport, child };
}

describe('AgencyTeamsTransport', () => {
	after(() => {
		tempHome.cleanup();
	});

	it('requires a team and channel', () => {
		assert.throws(() => new AgencyTeamsTransport({ teamId: '', channelId: 'c' }), /teamId/);
	});

	it('posts a root message and uses its id as the thread id', async () => {
		const { transport, child } = makeTransport(() => ({ id: '1787779475057' }));

		const result = await transport.createThread(notification);

		assert.strictEqual(result.thread.id, '1787779475057');
		const send = child.calls.find((c) => c.name === 'SendMessageToChannel');
		assert.ok(send, 'a channel message must be sent');
		// The MCP tool names this parameter 'content'; sending 'message' is rejected.
		assert.ok(typeof send.args.content === 'string');
		assert.strictEqual(send.args.contentType, 'html');
		assert.ok(String(send.args.subject).includes('Copilot'));
		transport.dispose();
	});

	it('tags the signed-in user on the root message', async () => {
		const child = new FakeChild((name) => {
			if (name === 'ListChannelMembers') {
				return { members: [{ userId: 'user-guid', displayName: 'Ada Lovelace', email: 'ada@example.com' }] };
			}
			return { id: 'msg-1' };
		});
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			spawnImpl: (() => child) as never,
            postedMessages: noopPostedMessagesRegistry
        });

		await transport.createThread(notification);

		const send = child.calls.find((c) => c.name === 'SendMessageToChannel');
		assert.ok(send, 'a channel message must be sent');
		// The server rewrites a bare @DisplayName using the mentions array.
		assert.ok(String(send.args.content).includes('@Ada Lovelace'), 'the body must reference the display name');
		const mentions = JSON.parse(String(send.args.mentions)) as { id: string; displayName: string; type: string }[];
		assert.deepStrictEqual(mentions, [{ displayName: 'Ada Lovelace', id: 'user-guid', type: 'user' }]);
		transport.dispose();
	});

	it('tags the user on follow-up messages when the update needs their input', async () => {
		const child = new FakeChild((name) => {
			if (name === 'ListChannelMembers') {
				return { members: [{ userId: 'u', displayName: 'Ada Lovelace' }] };
			}
			return { id: 'msg-2' };
		});
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		const transport = new AgencyTeamsTransport({ teamId: 't', channelId: 'c', requestTimeoutMs: 2_000, spawnImpl: (() => child) as never, postedMessages: noopPostedMessagesRegistry });

		// The default `keyMoments` policy tags on updates the user has to act on, so a
		// needs-input reply must still raise a Teams activity-feed ping.
		await transport.postToThread({ id: 'root' }, { ...notification, status: 'needs-input', question: 'Which one?' });

		const reply = child.calls.find((c) => c.name === 'ReplyToChannelMessage');
		assert.ok(reply);
		assert.ok(String(reply.args.mentions).includes('Ada Lovelace'));
		assert.ok(String(reply.args.content).includes('@Ada Lovelace'));
		transport.dispose();
	});

	it('does not tag on ordinary follow-up messages under the default policy', async () => {
		// The previous behaviour tagged the user on every message, which flooded the Teams
		// activity feed with a ping for every progress update. Under `keyMoments` a plain
		// progress or completion notice must post into the thread silently — no mentions
		// array, and no attempt to look up the signed-in user in the first place.
		const child = new FakeChild((name) => {
			if (name === 'ListChannelMembers') {
				throw new Error('ListChannelMembers must not be called when no mention is needed');
			}
			return { id: 'msg-2b' };
		});
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		const transport = new AgencyTeamsTransport({ teamId: 't', channelId: 'c', requestTimeoutMs: 2_000, spawnImpl: (() => child) as never, postedMessages: noopPostedMessagesRegistry });

		await transport.postToThread({ id: 'root' }, { ...notification, status: 'progress' });

		const reply = child.calls.find((c) => c.name === 'ReplyToChannelMessage');
		assert.ok(reply);
		assert.ok(!('mentions' in reply.args), 'no mentions array must be sent when the user is not tagged');
		assert.ok(!String(reply.args.content).includes('@Ada'), 'the body must not contain a bare @DisplayName either');
		assert.ok(!child.calls.some((c) => c.name === 'ListChannelMembers'), 'skipping resolveSelf saves a Teams call');
		transport.dispose();
	});

	it('tags on a follow-up when the session is awaiting a reply', async () => {
		const child = new FakeChild((name) => {
			if (name === 'ListChannelMembers') {
				return { members: [{ userId: 'u', displayName: 'Ada Lovelace' }] };
			}
			return { id: 'msg-wait' };
		});
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		const transport = new AgencyTeamsTransport({ teamId: 't', channelId: 'c', requestTimeoutMs: 2_000, spawnImpl: (() => child) as never, postedMessages: noopPostedMessagesRegistry });

		await transport.postToThread({ id: 'root' }, { ...notification, status: 'progress', awaitingReply: true });

		const reply = child.calls.find((c) => c.name === 'ReplyToChannelMessage');
		assert.ok(reply);
		assert.ok(String(reply.args.mentions).includes('Ada Lovelace'));
		transport.dispose();
	});

	it('respects mentionPolicy: everyMessage for backwards-compatible tagging', async () => {
		const child = new FakeChild((name) => {
			if (name === 'ListChannelMembers') {
				return { members: [{ userId: 'u', displayName: 'Ada Lovelace' }] };
			}
			return { id: 'msg-every' };
		});
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			mentionPolicy: 'everyMessage',
			spawnImpl: (() => child) as never,
			postedMessages: noopPostedMessagesRegistry
		});

		await transport.postToThread({ id: 'root' }, { ...notification, status: 'progress' });

		const reply = child.calls.find((c) => c.name === 'ReplyToChannelMessage');
		assert.ok(reply);
		assert.ok(String(reply.args.mentions).includes('Ada Lovelace'), 'everyMessage restores the previous tag-everywhere behaviour');
		assert.ok(String(reply.args.content).includes('@Ada Lovelace'));
		transport.dispose();
	});

	it('respects mentionPolicy: never even for the root message', async () => {
		const child = new FakeChild((name) => {
			if (name === 'ListChannelMembers') {
				throw new Error('ListChannelMembers must not be called when the policy is never');
			}
			return { id: 'msg-never' };
		});
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			mentionPolicy: 'never',
			spawnImpl: (() => child) as never,
			postedMessages: noopPostedMessagesRegistry
		});

		await transport.createThread({ ...notification, status: 'needs-input', question: 'Which one?' });

		const send = child.calls.find((c) => c.name === 'SendMessageToChannel');
		assert.ok(send);
		assert.ok(!('mentions' in send.args), 'never must not send a mentions array');
		assert.ok(!String(send.args.content).includes('@'), 'the body must not contain a bare @DisplayName');
		assert.ok(!child.calls.some((c) => c.name === 'ListChannelMembers'), 'never must not even resolve the signed-in user');
		transport.dispose();
	});

	it('treats the legacy mentionSelf: false as mentionPolicy: never', async () => {
		const child = new FakeChild((name) => {
			if (name === 'ListChannelMembers') {
				throw new Error('ListChannelMembers must not be called when mentionSelf is false');
			}
			return { id: 'msg-legacy' };
		});
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			mentionSelf: false,
			spawnImpl: (() => child) as never,
			postedMessages: noopPostedMessagesRegistry
		});

		await transport.createThread(notification);

		const send = child.calls.find((c) => c.name === 'SendMessageToChannel');
		assert.ok(send);
		assert.ok(!('mentions' in send.args));
		transport.dispose();
	});

	it('still posts when the member lookup fails', async () => {
		const child = new FakeChild((name) => {
			if (name === 'ListChannelMembers') {
				throw new Error('Forbidden');
			}
			return { id: 'msg-3' };
		});
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		const transport = new AgencyTeamsTransport({ teamId: 't', channelId: 'c', requestTimeoutMs: 2_000, spawnImpl: (() => child) as never, postedMessages: noopPostedMessagesRegistry });

		const result = await transport.createThread(notification);

		// A missing mention is cosmetic; losing the notification would not be.
		assert.strictEqual(result.thread.id, 'msg-3');
		transport.dispose();
	});

	it('replies into the existing thread rather than starting a new one', async () => {
		const { transport, child } = makeTransport(() => ({ id: 'reply-1' }));

		await transport.postToThread({ id: 'root-1' }, notification);

		const reply = child.calls.find((c) => c.name === 'ReplyToChannelMessage');
		assert.ok(reply);
		assert.strictEqual(reply.args.messageId, 'root-1');
		transport.dispose();
	});

	it('omits arguments that are undefined', async () => {
		const { transport, child } = makeTransport(() => ({ id: 'x' }));

		await transport.postToThread({ id: 'root-1' }, notification);

		assert.ok(!('subject' in child.calls[0].args), 'undefined values must not be sent');
		transport.dispose();
	});

	it('reads replies and strips their HTML', async () => {
		const now = Date.now();
		const { transport } = makeTransport((name) => {
			if (name === 'ListChannelMessageReplies') {
				return {
					messages: [
						{
							id: 'm1',
							createdDateTime: new Date(now + 60_000).toISOString(),
							from: { displayName: 'Rob Gupta' },
							body: { contentType: 'Html', content: '<p>ship it &mdash; then update docs</p>' }
						}
					]
				};
			}
			return {};
		});

		const replies = await transport.fetchReplies({ id: 'root-1' }, new Date(now).toISOString());

		assert.strictEqual(replies.length, 1);
		assert.strictEqual(replies[0].text, 'ship it — then update docs');
		assert.strictEqual(replies[0].from, 'Rob Gupta');
		transport.dispose();
	});

	it('ignores deleted and system messages', async () => {
		const now = Date.now();
		const { transport } = makeTransport(() => ({
			messages: [
				{ id: 'a', createdDateTime: new Date(now + 1000).toISOString(), deletedDateTime: new Date().toISOString(), body: { content: 'gone' } },
				{ id: 'b', createdDateTime: new Date(now + 2000).toISOString(), messageType: 'systemEventMessage', body: { content: 'joined' } },
				{ id: 'c', createdDateTime: new Date(now + 3000).toISOString(), body: { contentType: 'Html', content: '<p>real</p>' } }
			]
		}));

		const replies = await transport.fetchReplies({ id: 'root-1' }, new Date(now).toISOString());

		assert.deepStrictEqual(replies.map((r) => r.id), ['c']);
		transport.dispose();
	});

	it('honours the since watermark and orders oldest first', async () => {
		const now = Date.now();
		const { transport } = makeTransport(() => ({
			messages: [
				{ id: 'new2', createdDateTime: new Date(now + 120_000).toISOString(), body: { content: 'second' } },
				{ id: 'old', createdDateTime: new Date(now - 60_000).toISOString(), body: { content: 'history' } },
				{ id: 'new1', createdDateTime: new Date(now + 60_000).toISOString(), body: { content: 'first' } }
			]
		}));

		const replies = await transport.fetchReplies({ id: 'root-1' }, new Date(now).toISOString());

		assert.deepStrictEqual(replies.map((r) => r.id), ['new1', 'new2']);
		transport.dispose();
	});

	it('accepts the alternative collection shapes the tool may return', async () => {
		const now = Date.now();
		for (const shape of ['value', 'replies'] as const) {
			const { transport } = makeTransport(() => ({
				[shape]: [{ id: 'x', createdDateTime: new Date(now + 1000).toISOString(), body: { content: 'hi' } }]
			}));

			const replies = await transport.fetchReplies({ id: 'r' }, new Date(now).toISOString());

			assert.strictEqual(replies.length, 1, `shape "${shape}" should be understood`);
			transport.dispose();
		}
	});

	it('surfaces a tool error rather than returning nothing', async () => {
		const { transport } = makeTransport(() => {
			throw new Error("Unknown argument: 'message'");
		});

		await assert.rejects(() => transport.createThread(notification), /Unknown argument/);
		transport.dispose();
	});

	it('kills the subprocess when disposed', async () => {
		const { transport, child } = makeTransport(() => ({ id: 'x' }));
		await transport.createThread(notification);

		transport.dispose();

		assert.strictEqual(child.killed, true);
	});

	it('parses the payload when a diagnostic part is appended', async () => {
		// The real server returns the JSON payload and a plain-text "CorrelationId: ..."
		// part; concatenating them yields invalid JSON and silently loses every reply.
		const now = Date.now();
		const child = new FakeChild(() => ({}));
		(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;

		child.stdin.write = (line: string): void => {
			const request = JSON.parse(line) as { id: number; method: string };
			const message =
				request.method === 'initialize'
					? { id: request.id, result: {} }
					: {
						id: request.id,
						result: {
							content: [
								{
									type: 'text',
									text: JSON.stringify({
										messages: [{ id: 'm1', createdDateTime: new Date(now + 1000).toISOString(), from: { displayName: 'Rob' }, body: { contentType: 'Html', content: '<p>real reply</p>' } }]
									})
								},
								{ type: 'text', text: 'CorrelationId: abc-123, TimeStamp: 2026-08-26' }
							],
							isError: false
						}
					};
			setImmediate(() => child.stdout.emit('data', `${JSON.stringify(message)}\n`));
		};

		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			spawnImpl: (() => child) as never,
            postedMessages: noopPostedMessagesRegistry
        });

		const replies = await transport.fetchReplies({ id: 'root' }, new Date(now).toISOString());

		assert.strictEqual(replies.length, 1, 'the trailing diagnostic part must not break parsing');
		assert.strictEqual(replies[0].text, 'real reply');
		transport.dispose();
	});
});



/**
 * Stands in for an Agency subprocess whose upstream session has lapsed.
 *
 * The real launcher stays alive and healthy while the proxy behind it forgets the
 * session, so every later call fails with -32001 until a new process is started.
 */
class LapsingChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly calls: string[] = [];
	killed = false;

	constructor(private readonly lapsed: boolean) {
		super();
		(this.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
		(this.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
	}

	readonly stdin = {
		write: (line: string): void => {
			const request = JSON.parse(line) as { id: number; method: string; params?: { name?: string } };
			if (request.method === 'initialize') {
				this.send({ id: request.id, result: {} });
				return;
			}
			this.calls.push(request.params?.name ?? '');
			if (this.lapsed) {
				this.send({ id: request.id, error: { code: -32001, message: 'Session not found' } });
				return;
			}
			this.send({
				id: request.id,
				result: { content: [{ type: 'text', text: JSON.stringify({ messages: [] }) }], isError: false }
			});
		}
	};

	private send(message: unknown): void {
		setImmediate(() => this.stdout.emit('data', `${JSON.stringify(message)}\n`));
	}

	kill(): void {
		this.killed = true;
	}
}

describe('AgencyTeamsTransport session recovery', () => {
	it('restarts the subprocess and retries when the upstream session has lapsed', async () => {
		const children = [new LapsingChild(true), new LapsingChild(false)];
		let spawned = 0;
		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			spawnImpl: (() => children[spawned++]) as never,
		postedMessages: noopPostedMessagesRegistry
		});

		const replies = await transport.fetchReplies({ id: 'root' }, undefined);

		assert.deepStrictEqual(replies, [], 'the retry against the fresh process must succeed');
		assert.strictEqual(spawned, 2, 'a second subprocess must be started');
		assert.strictEqual(children[0].killed, true, 'the stale subprocess must be killed');
		transport.dispose();
	});

	it('gives up rather than looping when the fresh subprocess is also stale', async () => {
		const children = [new LapsingChild(true), new LapsingChild(true)];
		let spawned = 0;
		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			spawnImpl: (() => children[spawned++]) as never,
		postedMessages: noopPostedMessagesRegistry
		});

		await assert.rejects(() => transport.fetchReplies({ id: 'root' }, undefined), /Session not found/);
		assert.strictEqual(spawned, 2, 'exactly one retry, so a permanent failure surfaces instead of hanging');
		transport.dispose();
	});

	it('does not restart on an ordinary tool failure', async () => {
		const children = [new LapsingChild(false), new LapsingChild(false)];
		let spawned = 0;
		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			spawnImpl: (() => {
				const child = children[spawned++];
				child.stdin.write = ((line: string): void => {
					const request = JSON.parse(line) as { id: number; method: string };
					const message =
						request.method === 'initialize'
							? { id: request.id, result: {} }
							: { id: request.id, error: { code: -32602, message: 'Invalid pattern' } };
					setImmediate(() => child.stdout.emit('data', `${JSON.stringify(message)}\n`));
				}) as never;
				return child;
			}) as never,
			postedMessages: noopPostedMessagesRegistry
		});

		await assert.rejects(() => transport.fetchReplies({ id: 'root' }, undefined), /Invalid pattern/);
		assert.strictEqual(spawned, 1, 'a bad request must not be retried against a new process');
		transport.dispose();
	});
});
