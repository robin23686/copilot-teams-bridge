import { InMemorySessionStore } from '../src/application/ports';
import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Bridge } from '../src/application/bridge';
import { DEFAULT_WAIT_TIMEOUT_MS, HOST_CALL_LIMIT_MS, McpServer, PROTOCOL_VERSION } from '../src/hosts/mcp/server';
import { LineProtocol } from '../src/hosts/mcp/jsonRpc';
import { type ThreadedTransport } from '../src/application/ports';
import { type InboundReply, type OutboundNotification, type PostResult, type ThreadRef } from '../src/domain/types';

const bridges: Bridge[] = [];

after(() => {
	// Polling loops keep the process alive otherwise.
	for (const bridge of bridges) {
		bridge.dispose();
	}
});

class FakeTransport implements ThreadedTransport {
	readonly kind = 'file' as const;
	readonly supportsReplies = true;
	posts: OutboundNotification[] = [];
	private threads = 0;
	private queued: InboundReply[] = [];

	async createThread(notification: OutboundNotification): Promise<PostResult> {
		this.posts.push(notification);
		// Distinct per thread, as Teams gives, so replies to one session cannot be mistaken
		// for replies to another. The first keeps the historic id so existing tests still read.
		const id = this.threads === 0 ? 't1' : `t${this.threads + 1}`;
		this.threads++;
		return { thread: { id, webUrl: `https://teams.example/${id}` } };
	}
	async postToThread(thread: ThreadRef, notification: OutboundNotification): Promise<PostResult> {
		this.posts.push(notification);
		return { thread };
	}
	async fetchReplies(thread: ThreadRef): Promise<InboundReply[]> {
		const out = this.queued.filter((r) => r.threadId === thread.id);
		this.queued = this.queued.filter((r) => r.threadId !== thread.id);
		return out;
	}
	queue(text: string, threadId = 't1'): void {
		this.queued.push({ id: `r${Date.now()}${Math.random()}`, threadId, text, from: 'Rob', createdAt: new Date(Date.now() + 60_000).toISOString() });
	}
}

interface Harness {
	send(method: string, params?: unknown, id?: number | null): Promise<unknown>;
	transport: FakeTransport;
	bridge: Bridge;
	raw: string[];
}

function harness(opts: { harness?: import('../src/domain/types').HarnessKind; boundSessionKey?: string; workspace?: string; delegated?: boolean } = {}): Harness {
	const transport = new FakeTransport();
	// Real timers with a short interval, because waitForReply depends on the polling loop
	// picking up a reply that arrives after the call is already blocked.
	const bridge = new Bridge({ transport, store: new InMemorySessionStore(), pollIntervalMs: 20, workspace: opts.workspace });
	bridges.push(bridge);
	const raw: string[] = [];
	const pending = new Map<number | string, (value: unknown) => void>();

	const server = new McpServer({
		bridge,
		waitTimeoutMs: 5_000,
		harness: opts.harness,
		boundSessionKey: opts.boundSessionKey,
		delegated: opts.delegated,
		write: (line) => {
			raw.push(line);
			const parsed = JSON.parse(line) as { id: number | string | null };
			if (parsed.id !== null && pending.has(parsed.id)) {
				pending.get(parsed.id)?.(parsed);
				pending.delete(parsed.id);
			}
		}
	});

	let nextId = 1;
	return {
		transport,
		bridge,
		raw,
		send(method, params, id) {
			const requestId = id === undefined ? nextId++ : id;
			const promise =
				requestId === null
					? Promise.resolve(undefined)
					: new Promise<unknown>((resolve) => pending.set(requestId, resolve));
			server.push(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
			return promise;
		}
	};
}

describe('LineProtocol', () => {
	it('reassembles a message split across chunks', () => {
		const seen: unknown[] = [];
		const protocol = new LineProtocol((m) => seen.push(m));

		protocol.push('{"jsonrpc":"2.0","id":1,');
		protocol.push('"method":"ping"}\n');

		assert.strictEqual(seen.length, 1);
		assert.deepStrictEqual(seen[0], { jsonrpc: '2.0', id: 1, method: 'ping' });
	});

	it('handles several messages in one chunk', () => {
		const seen: unknown[] = [];
		const protocol = new LineProtocol((m) => seen.push(m));

		protocol.push('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n');

		assert.strictEqual(seen.length, 2);
	});

	it('reports malformed JSON without throwing', () => {
		const errors: Error[] = [];
		const protocol = new LineProtocol(() => undefined, (e) => errors.push(e));

		protocol.push('{ not json }\n');

		assert.strictEqual(errors.length, 1);
	});
});

describe('McpServer handshake', () => {
	it('reports protocol version and tool capability', async () => {
		const h = harness();
		const response = (await h.send('initialize', { protocolVersion: PROTOCOL_VERSION })) as {
			result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
		};

		assert.strictEqual(response.result.protocolVersion, PROTOCOL_VERSION);
		assert.ok(response.result.capabilities.tools);
		assert.strictEqual(response.result.serverInfo.name, 'copilot-teams-bridge');
	});

	it('answers ping', async () => {
		const h = harness();
		const response = (await h.send('ping')) as { result: unknown };
		assert.deepStrictEqual(response.result, {});
	});

	it('rejects an unknown method', async () => {
		const h = harness();
		const response = (await h.send('does/notExist')) as { error: { code: number } };
		assert.strictEqual(response.error.code, -32601);
	});

	it('does not answer notifications', async () => {
		const h = harness();
		await h.send('notifications/initialized', {}, null);
		assert.strictEqual(h.raw.length, 0, 'a notification must produce no response');
	});
});

describe('McpServer tools', () => {
	it('advertises the notify tool with a usable schema', async () => {
		const h = harness();
		const response = (await h.send('tools/list')) as { result: { tools: { name: string; inputSchema: { required: string[] } }[] } };
		const notify = response.result.tools.find((t) => t.name === 'teams_notify');

		assert.ok(notify, 'teams_notify must be advertised');
		assert.deepStrictEqual(notify.inputSchema.required, ['title', 'summary', 'status']);
		assert.strictEqual(response.result.tools.length, 3);
	});

	it('accepts the same arguments as the VS Code tool so one instruction file serves both', async () => {
		// The instructions are shared by both hosts. If the two schemas drift, the model is
		// told to pass an argument that one of them silently ignores.
		const h = harness();
		const response = (await h.send('tools/list')) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } };
		const notify = response.result.tools.find((t) => t.name === 'teams_notify');

		const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
			contributes: { languageModelTools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] };
		};
		const lmTool = pkg.contributes.languageModelTools.find((t) => t.name === 'copilotTeamsBridge_notify');

		assert.ok(notify && lmTool, 'both the MCP tool and the VS Code tool must exist');
		assert.deepStrictEqual(
			Object.keys(notify.inputSchema.properties).sort(),
			Object.keys(lmTool.inputSchema.properties).sort()
		);
	});

	it('routes a follow-up by sessionId back to the same thread', async () => {
		const h = harness();
		const first = (await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'First', summary: 'Starting.', status: 'progress', sessionKey: 'routing' }
		})) as { result: { content: { text: string }[] } };

		const id = /sessionId: "([^"]+)"/.exec(first.result.content[0].text)?.[1];
		assert.ok(id, 'the reply must expose the sessionId for follow-ups');

		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Second', summary: 'Done.', status: 'completed', sessionId: id, sessionKey: 'a-deliberately-wrong-key' }
		});

		const sessions = (await h.send('tools/call', { name: 'teams_list_sessions', arguments: {} })) as {
			result: { content: { text: string }[] };
		};
		assert.strictEqual(
			(sessions.result.content[0].text.match(/key=/g) ?? []).length,
			1,
			'sessionId must win over a mismatched sessionKey instead of opening a second thread'
		);
	});

	it('posts a notification', async () => {
		const h = harness();
		const response = (await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Build done', summary: 'All green.', status: 'completed', sessionKey: 'build' }
		})) as { result: { content: { text: string }[]; isError: boolean } };

		assert.strictEqual(response.result.isError, false);
		assert.match(response.result.content[0].text, /build/);
		assert.strictEqual(h.transport.posts.length, 1);
		assert.strictEqual(h.transport.posts[0].title, 'Build done');
	});

	it('returns an error result rather than throwing on bad input', async () => {
		const h = harness();
		const response = (await h.send('tools/call', { name: 'teams_notify', arguments: { title: '' } })) as {
			result: { content: { text: string }[]; isError: boolean };
		};

		assert.strictEqual(response.result.isError, true);
		assert.match(response.result.content[0].text, /required/);
	});

	it('rejects an unknown tool', async () => {
		const h = harness();
		const response = (await h.send('tools/call', { name: 'nope', arguments: {} })) as { result: { isError: boolean } };
		assert.strictEqual(response.result.isError, true);
	});

	it('returns the user reply when waitForReply is set', async () => {
		const h = harness();
		const call = h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Need a decision', summary: 'Blocked.', status: 'needs-input', question: 'Ship?', waitForReply: true }
		});

		// The reply arrives after the call is already waiting.
		setTimeout(() => h.transport.queue('yes, ship it'), 10);

		const response = (await call) as { result: { content: { text: string }[] } };
		assert.match(response.result.content[0].text, /yes, ship it/);
		assert.match(response.result.content[0].text, /next instruction/);
	});

	it('surfaces a stop command as an instruction to halt', async () => {
		const h = harness();
		const call = h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Long task', summary: 'Working.', status: 'progress', waitForReply: true }
		});
		setTimeout(() => h.transport.queue('/stop'), 10);

		const response = (await call) as { result: { content: { text: string }[] } };
		assert.match(response.result.content[0].text, /STOP/);
	});

	it('lists sessions once one exists', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'Task A', summary: 's', status: 'completed', sessionKey: 'a' } });

		const response = (await h.send('tools/call', { name: 'teams_list_sessions', arguments: {} })) as {
			result: { content: { text: string }[] };
		};

		assert.match(response.result.content[0].text, /Task A/);
		assert.match(response.result.content[0].text, /key=a/);
	});

	it('checks for replies without posting', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' } });
		h.transport.queue('an unsolicited instruction');

		const response = (await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k' } })) as {
			result: { content: { text: string }[] };
		};

		assert.match(response.result.content[0].text, /an unsolicited instruction/);

		// Checking replies is a read, not a status update. The one exception is the short
		// acknowledgement, so the user can see their reply landed before any work is reported.
		const summaries = h.transport.posts.map((post) => post.summary);
		assert.strictEqual(summaries.length, 2, `unexpected posts: ${JSON.stringify(summaries)}`);
		assert.match(summaries[1], /working on this/);
	});
});

describe('McpServer reply visibility', () => {
	it('reports a Teams read failure instead of claiming there are no replies', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' } });
		h.transport.fetchReplies = async (): Promise<never> => {
			throw new Error('ListChannelMessageReplies failed: Session not found');
		};

		const response = (await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k' } })) as {
			result: { content: { text: string }[]; isError: boolean };
		};

		assert.strictEqual(response.result.isError, true, 'a broken read must not be reported as a clean "no replies"');
		assert.match(response.result.content[0].text, /Session not found/);
	});

	it('returns a reply that an earlier background poll had already collected', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' } });
		h.transport.queue('picked up in the background');
		// Simulates the polling loop running between tool calls, with nothing waiting.
		await h.bridge.poll();

		const response = (await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k' } })) as {
			result: { content: { text: string }[] };
		};

		assert.match(response.result.content[0].text, /picked up in the background/);
	});

	it('does not replay a reply that was already reported', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' } });
		h.transport.queue('only once');
		await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k' } });

		const second = (await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k' } })) as {
			result: { content: { text: string }[] };
		};

		assert.match(second.result.content[0].text, /No new Teams replies/);
	});

	// A reply is delivered as a tool result, which chat UIs collapse. Without an explicit
	// nudge the agent acts on an instruction the user can never see on screen.
	it('asks for the reply to be shown to the user, whichever path delivered it', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' } });
		h.transport.queue('deploy to PPE next');

		const batch = (await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k' } })) as {
			result: { content: { text: string }[] };
		};

		assert.match(batch.result.content[0].text, /deploy to PPE next/);
		assert.match(batch.result.content[0].text, /Quote this reply back to the user/);
	});

	it('asks for the reply to be shown when a blocking notify returns one', async () => {
		const h = harness();
		h.transport.queue('use the other branch');

		const response = (await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'needs-input', question: 'which branch?', sessionKey: 'k', waitForReply: true }
		})) as { result: { content: { text: string }[] } };

		assert.match(response.result.content[0].text, /use the other branch/);
		assert.match(response.result.content[0].text, /Quote this reply back to the user/);
	});

	// A bare command carries no text. It used to reach the agent as an empty message, so
	// the user saw nothing happen while the engine had already closed the session.
	it('tells the agent what a bare slash command means', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' } });
		h.transport.queue('/status');

		const response = (await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k' } })) as {
			result: { content: { text: string }[] };
		};

		const text = response.result.content[0].text;
		assert.match(text, /\/status/, 'the command itself must be visible, not a blank line');
		assert.match(text, /STATUS UPDATE/, 'the agent must be told what to do about it');
	});

	it('recognises every command that closes the session, not just stop', async () => {
		for (const command of ['/stop', '/cancel', '/close', '/done']) {
			const h = harness();
			h.transport.queue(command);

			const response = (await h.send('tools/call', {
				name: 'teams_notify',
				arguments: { title: 'T', summary: 's', status: 'needs-input', question: 'q?', sessionKey: 'k', waitForReply: true }
			})) as { result: { content: { text: string }[] } };

			assert.match(
				response.result.content[0].text,
				/STOP this task/,
				`${command} closes the session, so the agent must be told to stop`
			);
		}
	});});

describe('McpServer long waits', () => {
	it('returns a reply to the queue when the client abandons the call', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' } });
		const before = h.raw.length;

		// Not awaited: an abandoned call must never answer, so the promise never settles.
		void h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'needs-input', sessionKey: 'k', waitForReply: true } }, 99);
		await new Promise((resolve) => setTimeout(resolve, 30));
		await h.send('notifications/cancelled', { requestId: 99 }, null);
		h.transport.queue('the answer the client never saw');

		await new Promise((resolve) => setTimeout(resolve, 200));

		assert.ok(
			!h.raw.slice(before).some((line) => line.includes('"id":99')),
			'a cancelled request must not be answered'
		);
		const recovered = (await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k' } })) as {
			result: { content: { text: string }[] };
		};
		assert.match(
			recovered.result.content[0].text,
			/the answer the client never saw/,
			'the reply must survive the abandoned call that consumed it'
		);
	});

	it('blocks on teams_check_replies until a reply arrives', async () => {
		const h = harness();
		await h.send('tools/call', { name: 'teams_notify', arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' } });
		setTimeout(() => h.transport.queue('late answer'), 40);

		const response = (await h.send('tools/call', { name: 'teams_check_replies', arguments: { sessionKey: 'k', waitSeconds: 3 } })) as {
			result: { content: { text: string }[] };
		};

		assert.match(response.result.content[0].text, /late answer/);
	});

	it('points an empty wait window back at the chat, and still offers a way to keep listening', async () => {
		const h = harness();

		const response = (await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'needs-input', sessionKey: 'k', waitForReply: true }
		})) as { result: { content: { text: string }[] } };

		const text = response.result.content[0].text;
		// Blocking again would leave Teams as the only way to reach the agent.
		assert.match(text, /answer in this chat or in Teams/, 'the chat is a reply route too');
		assert.match(text, /teams_check_replies/, 'a way to carry on waiting must still be offered');
		assert.doesNotMatch(text, /Stop and wait/, 'an empty window is not the same as the user declining to answer');
	});

	// Blocking freezes the turn, so the user cannot answer in the chat they are looking at.
	it('does not advertise blocking as the default', async () => {
		const h = harness();
		const listed = (await h.send('tools/list', {})) as {
			result: {
				tools: { name: string; description: string; inputSchema: { properties: Record<string, { description: string }> } }[];
			};
		};

		const notify = listed.result.tools.find((tool) => tool.name === 'teams_notify');
		assert.ok(notify, 'teams_notify must be listed');
		assert.match(notify.description, /LEAVE waitForReply UNSET/, 'blocking must not be the advertised default');
		assert.match(notify.description, /answer in either place/, 'both reply routes must be described');
		assert.match(notify.inputSchema.properties.waitForReply.description, /prevents them answering in this chat/);
	});

	it('waits in windows short enough for the host to still be listening', () => {
		// A wait that outlives the host is worse than a short one: the reply is consumed and
		// the response thrown away, so the user's message is lost rather than merely delayed.
		assert.ok(
			DEFAULT_WAIT_TIMEOUT_MS < HOST_CALL_LIMIT_MS / 1.5,
			`default wait ${DEFAULT_WAIT_TIMEOUT_MS}ms must leave headroom under the ${HOST_CALL_LIMIT_MS}ms host limit`
		);
	});

	// Posting to Teams used to read as 'the update has been delivered', so the agent replied
	// with a bare 'posted to Teams' and the user in VS Code saw nothing of their own work.
	it('tells the agent to answer in the chat as well as Teams', async () => {
		const h = harness();

		for (const status of ['progress', 'completed', 'failed', 'needs-input']) {
			const response = (await h.send('tools/call', {
				name: 'teams_notify',
				arguments: { title: 'T', summary: 's', status, question: 'q?', sessionKey: `k-${status}` }
			})) as { result: { content: { text: string }[] } };

			assert.match(
				response.result.content[0].text,
				/not a replacement for this chat/,
				`a ${status} update must still be reported in the chat`
			);
		}
	});

	// One MCP server is shared by every agent session, so an unscoped check hands one agent
	// another's reply AND consumes it, leaving the rightful owner waiting for something taken.
	it('gives each agent only the replies for its own session', async () => {
		const h = harness();
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Reserve API', summary: 's', status: 'needs-input', sessionKey: 'reserve-api' }
		});
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Cohort IcM', summary: 's', status: 'needs-input', sessionKey: 'cohort-icm' }
		});

		for (const session of h.bridge.listSessions()) {
			h.transport.queue(`instruction for ${session.key}`, session.thread?.id);
		}

		const mine = (await h.send('tools/call', {
			name: 'teams_check_replies',
			arguments: { sessionKey: 'reserve-api' }
		})) as { result: { content: { text: string }[] } };

		assert.match(mine.result.content[0].text, /instruction for reserve-api/);
		assert.doesNotMatch(
			mine.result.content[0].text,
			/instruction for cohort-icm/,
			'another task must not have its reply handed over'
		);

		const theirs = (await h.send('tools/call', {
			name: 'teams_check_replies',
			arguments: { sessionKey: 'cohort-icm' }
		})) as { result: { content: { text: string }[] } };

		assert.match(theirs.result.content[0].text, /instruction for cohort-icm/, 'the owner must still receive it');
	});

});

describe('McpServer harness identity', () => {
	// The bug this fix closes: two callers spawn the stdio server and used to arrive with
	// no identity, so identityOf() reported "unknown" for both. The reply-invitation
	// footer could not be right for both — either denying a resolvable session or
	// inviting a reply that could never reach a chat. The server now stamps the harness
	// the launcher told it about, and the footer follows automatically.
	it('stamps the harness on every session it creates from the env-provided value', async () => {
		const h = harness({ harness: 'vscode-agent-mcp' });
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'stamped' }
		});

		const [session] = h.bridge.listSessions();
		assert.strictEqual(session.identity?.harness, 'vscode-agent-mcp');
		assert.strictEqual(session.identity?.confidence, 'exact', 'the host told us; no inference required');
		assert.strictEqual(session.identity?.capturedBy, 'mcp-ingest');
	});

	// Legacy behaviour must survive: a server built before this env var existed, or one
	// launched by a caller that did not set it, stamps nothing so the relay can still
	// resolve the session lazily (via chatSessionResource or transcript search).
	it('leaves identity alone when the launcher did not name a harness', async () => {
		const h = harness();
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'unstamped' }
		});

		const [session] = h.bridge.listSessions();
		assert.strictEqual(session.identity, undefined, 'unknown harness stamps nothing');
	});

	// preferIdentity must not be bypassed: a later, better identity (with a chat) has to
	// still win over the mcp-ingest stamp that names no chat.
	it('does not downgrade a later identity that names a chat', async () => {
		const h = harness({ harness: 'vscode-agent-mcp' });
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'upgradable' }
		});

		// Simulate a later notify from the notify tool that carries a real chat.
		const better = await h.bridge.notify({
			sessionKey: 'upgradable',
			title: 'T',
			summary: 's',
			status: 'progress',
			identity: {
				harness: 'vscode-sidebar',
				chat: { kind: 'chat-session-resource', value: 'vscode-chat-session://local/real' },
				confidence: 'exact',
				capturedBy: 'notify-tool',
				capturedAt: new Date().toISOString()
			}
		});
		assert.strictEqual(better.session.identity?.chat?.value, 'vscode-chat-session://local/real');
		assert.strictEqual(better.session.identity?.harness, 'vscode-sidebar');
	});

	// The other direction: a stamped identity must not be erased by a subsequent notify
	// that carries nothing.
	it('does not let a later blind notify erase the harness', async () => {
		const h = harness({ harness: 'cli-runtime' });
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'sticky' }
		});
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's-2', status: 'progress', sessionKey: 'sticky' }
		});
		const [session] = h.bridge.listSessions();
		assert.strictEqual(session.identity?.harness, 'cli-runtime');
	});

	// The footer follows the identity: a CLI-hosted agent now gets an accurate wording
	// instead of a false invitation.
	it('renders the cli-runtime footer once identity is stamped', async () => {
		const h = harness({ harness: 'cli-runtime' });
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'k' }
		});
		const [post] = h.transport.posts;
		assert.strictEqual(post.repliesReachChat, false, 'cli-runtime is not deliverable from this window');
		assert.strictEqual(post.unreachableHarness, 'cli-runtime');
	});
});

describe('McpServer session scoping', () => {
	// An unscoped call on a shared server used to silently drain another session's queue.
	// The tool now rejects it at the JSON-RPC layer, which the model cannot mistake for a
	// normal empty answer.
	it('rejects an unscoped teams_check_replies with a JSON-RPC error', async () => {
		const h = harness();
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'owner' }
		});

		const response = (await h.send('tools/call', {
			name: 'teams_check_replies',
			arguments: {}
		})) as { error?: { code: number; message: string }; result?: unknown };

		assert.ok(response.error, 'a JSON-RPC error, not a tool result');
		assert.strictEqual(response.error?.code, -32602, 'invalidParams');
		assert.match(response.error?.message ?? '', /sessionId or sessionKey/);
	});

	// A bound server takes its scope from the launcher, not the arguments. This is the
	// mechanism for per-agent isolation the launcher does not yet plumb a value into.
	it('scopes every check to the bound session, ignoring caller arguments', async () => {
		const h = harness({ boundSessionKey: 'reserved' });
		// A stray notify with a different sessionKey is coerced onto the bound one.
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'T', summary: 's', status: 'progress', sessionKey: 'trying-something-else' }
		});
		const [session] = h.bridge.listSessions();
		assert.strictEqual(session.key, 'reserved', 'bound key wins over the argument');

		h.transport.queue('instruction for reserved', session.thread?.id);
		const response = (await h.send('tools/call', {
			name: 'teams_check_replies',
			arguments: { sessionKey: 'not-this-one' }
		})) as { result: { content: { text: string }[] } };
		assert.match(response.result.content[0].text, /instruction for reserved/);
	});

	// A bound server discloses only its own session. Other agents on the machine may not
	// see it, and it may not see them.
	it('lists only the bound session', async () => {
		const h = harness({ boundSessionKey: 'reserved' });
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Mine', summary: 's', status: 'progress', sessionKey: 'reserved' }
		});
		// A stranger appears in the same bridge (e.g. a session left over from elsewhere).
		h.bridge.notify({
			sessionKey: 'stranger',
			title: 'Not mine',
			summary: 's',
			status: 'progress'
		});

		const listed = (await h.send('tools/call', { name: 'teams_list_sessions', arguments: {} })) as {
			result: { content: { text: string }[] };
		};
		assert.match(listed.result.content[0].text, /key=reserved/);
		assert.doesNotMatch(listed.result.content[0].text, /key=stranger/);
	});

	// Unbound listing still helps an agent re-find its own thread, but not by browsing
	// what other harnesses or workspaces have opened.
	it('hides sessions from a different harness or workspace when unbound', async () => {
		const h = harness({ harness: 'vscode-agent-mcp', workspace: 'ws-a' });
		// Our own session.
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Mine', summary: 's', status: 'progress', sessionKey: 'mine' }
		});
		// A session from a different harness. Insert directly so we control the identity.
		await h.bridge.notify({
			sessionKey: 'cli-neighbour',
			title: 'CLI-only',
			summary: 's',
			status: 'progress',
			identity: {
				harness: 'cli-runtime',
				confidence: 'exact',
				capturedBy: 'mcp-ingest',
				capturedAt: new Date().toISOString()
			}
		});

		const listed = (await h.send('tools/call', { name: 'teams_list_sessions', arguments: {} })) as {
			result: { content: { text: string }[] };
		};
		assert.match(listed.result.content[0].text, /key=mine/);
		assert.doesNotMatch(listed.result.content[0].text, /key=cli-neighbour/, 'other harnesses are private');
	});

	// The list shape has shrunk to the minimum an agent needs to identify its own thread.
	// A cadence field like lastActivity leaks how often another agent runs.
	it('discloses only key/title/status in list output', async () => {
		const h = harness({ harness: 'vscode-agent-mcp' });
		await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Mine', summary: 's', status: 'progress', sessionKey: 'mine' }
		});

		const listed = (await h.send('tools/call', { name: 'teams_list_sessions', arguments: {} })) as {
			result: { content: { text: string }[] };
		};
		const text = listed.result.content[0].text;
		assert.match(text, /key=mine/);
		assert.match(text, /status=/);
		assert.doesNotMatch(text, /lastActivity/, 'cadence must not leak between agents');
	});
});

/**
 * A delegated MCP session is a short-lived process spawned by a parent agent. It has no
 * long-lived thread to watch, so any Teams conversation opened from it would be a dead
 * letterbox: a reply sent there is collected only while the process is still running, and
 * never once it exits. The server therefore hides the three Teams tools from tools/list —
 * an agent that cannot see a tool will not try to use it — and refuses a stale-list call
 * with a tool error that tells the agent to report to the agent that spawned it. No
 * session is created, no thread is opened, and the store is left untouched.
 */
describe('McpServer delegated mode', () => {
	it('advertises no tools when delegated, but all three when not', async () => {
		const delegated = harness({ delegated: true });
		const normal = harness({ delegated: false });

		const delegatedList = (await delegated.send('tools/list')) as { result: { tools: { name: string }[] } };
		const normalList = (await normal.send('tools/list')) as { result: { tools: { name: string }[] } };

		assert.deepStrictEqual(delegatedList.result.tools, [], 'delegated must hide every Teams tool');
		assert.deepStrictEqual(
			normalList.result.tools.map((t) => t.name).sort(),
			['teams_check_replies', 'teams_list_sessions', 'teams_notify']
		);
	});

	for (const name of ['teams_notify', 'teams_check_replies', 'teams_list_sessions'] as const) {
		it(`refuses ${name} with a "report to your parent" tool error and touches no state`, async () => {
			const h = harness({ delegated: true });
			const args = name === 'teams_notify'
				? { title: 'x', summary: 's', status: 'progress', sessionKey: 'k' }
				: { sessionKey: 'k' };

			const response = (await h.send('tools/call', { name, arguments: args })) as {
				result: { content: { text: string }[]; isError: boolean };
			};

			assert.strictEqual(response.result.isError, true, `${name} must be refused as a tool error`);
			assert.match(response.result.content[0].text, /delegated mode/i);
			assert.match(response.result.content[0].text, /spawned you/i, 'the message must point to the parent');
			// The store must be untouched: no session created, no thread opened.
			assert.strictEqual(h.transport.posts.length, 0, `${name} must not post to Teams`);
			assert.deepStrictEqual(h.bridge.listSessions(), [], `${name} must not create a session`);
		});
	}

	it('non-delegated still posts and lists as before', async () => {
		const h = harness({ delegated: false });
		const posted = (await h.send('tools/call', {
			name: 'teams_notify',
			arguments: { title: 'Live', summary: 'still on', status: 'progress', sessionKey: 'live' }
		})) as { result: { isError: boolean } };

		assert.strictEqual(posted.result.isError, false);
		assert.strictEqual(h.transport.posts.length, 1);

		const listed = (await h.send('tools/call', { name: 'teams_list_sessions', arguments: {} })) as {
			result: { content: { text: string }[]; isError: boolean };
		};
		assert.strictEqual(listed.result.isError, false);
		assert.match(listed.result.content[0].text, /key=live/);
	});
});


