import type { Bridge, RoutedReply } from '../../application/bridge';
import type { HarnessKind, NotificationStatus, SessionIdentity } from '../../domain/types';
import { identityOf } from '../../application/services/harness';
import { isClosingCommand } from '../../domain/messageFormat';
import { JSON_RPC_ERRORS, LineProtocol, failure, serialise, success, type JsonRpcRequest, type JsonRpcResponse } from './jsonRpc';

/**
 * Model Context Protocol server exposing the Teams bridge.
 *
 * Publishing the bridge as an MCP server rather than only a VS Code extension means any
 * MCP client — Claude Desktop, Cursor, Copilot CLI, VS Code — can post to Teams and block
 * on a reply, without the bridge knowing anything about the host.
 */

export const PROTOCOL_VERSION = '2024-11-05';

/**
 * How long a blocking call waits before returning empty.
 *
 * Hosts abandon a tool call that runs too long — VS Code gives up around five minutes and
 * does not send a progress token, so there is no way to ask for an extension. A wait that
 * outlives the host is worse than a short one: the reply is consumed, the response is
 * discarded, and the user's message is gone. Waiting in windows comfortably inside that
 * limit keeps every reply recoverable, and callers rebuild a long wait from several.
 */
const DEFAULT_WAIT_MS = 150_000;

/** Where VS Code abandons a tool call. The default wait must stay clearly inside it. */
export const HOST_CALL_LIMIT_MS = 300_000;
export const DEFAULT_WAIT_TIMEOUT_MS = DEFAULT_WAIT_MS;

/** Tracks whether the client is still listening to a call that is in progress. */
interface CallState {
	cancelled: boolean;
}

export interface McpServerOptions {
	bridge: Bridge;
	/** How long a waiting tool call blocks before giving up. */
	waitTimeoutMs?: number;
	/**
	 * Which surface launched this server, from `COPILOT_TEAMS_BRIDGE_HARNESS`.
	 *
	 * Recorded as the identity of every session this process opens so the reply-invitation
	 * footer and delivery routing can tell a VS Code-hosted agent apart from a standalone
	 * Copilot CLI — the two were indistinguishable at the wire before, so no wording could
	 * be right for both. `undefined` falls through to `unknown`, matching the pre-existing
	 * behaviour of not stamping anything.
	 */
	harness?: HarnessKind;
	/**
	 * When set, this server process is bound to exactly one session key.
	 *
	 * Listing returns only that session, and reply-check scoping arguments naming a
	 * different session are ignored. One MCP server is shared by every agent session on
	 * the machine, so an unbound process is legitimately shared, but a bound one is a
	 * proof-of-concept for per-agent isolation: no session can see or consume another's
	 * state. The launcher does not yet plumb a per-session key in, but the mechanism is
	 * available and tested for the day it does.
	 */
	boundSessionKey?: string;
	/**
	 * When true, this server is a delegated-agent session that must not reach Teams.
	 *
	 * A delegated agent is a short-lived process spawned by a parent agent: it has no
	 * long-lived thread to watch, so any Teams conversation opened from it would be a
	 * dead letterbox — a reply posted there is collected only while the process is still
	 * running, and never once it exits. Delegated mode therefore hides the three Teams
	 * tools from `tools/list` (hiding is more reliable than asking a model to refrain)
	 * and refuses a stale-list call with a tool error that tells the agent what to do
	 * instead: report the result to the agent that spawned it, which owns the thread.
	 * No session is created, no thread is opened, and the store is left untouched.
	 */
	delegated?: boolean;
	/** Where to write a response line. */
	write(line: string): void;
	log?(message: string): void;
}

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
	{
		name: 'teams_notify',
		description:
			'Post a status update to the user on Microsoft Teams. ' +
			'Call this when you finish a task, when you are blocked, or when you need a decision. ' +
			'Each sessionKey maps to one Teams conversation, so reuse it for follow-ups about the same task. ' +
			'Teams is an ADDITIONAL audience, not a replacement for this chat: always give the full update in your reply here too. ' +
			'LEAVE waitForReply UNSET by default and end your turn normally — the user can answer in either place, ' +
			'and blocking stops them answering in the chat they are sitting in front of. ' +
			'Only block when the user has said they are stepping away.',
		inputSchema: {
			type: 'object',
			required: ['title', 'summary', 'status'],
			properties: {
				title: { type: 'string', description: 'Short one-line title for the update.' },
				summary: { type: 'string', description: 'Markdown summary of what happened. Keep under ~1500 characters.' },
				status: {
					type: 'string',
					enum: ['completed', 'needs-input', 'failed', 'progress'],
					description: "Outcome so far. Use 'needs-input' with a question when blocked."
				},
				question: { type: 'string', description: 'The specific question to answer. Required when status is needs-input.' },
				files: { type: 'array', items: { type: 'string' }, description: 'Paths created or modified, for context.' },
				sessionKey: { type: 'string', description: 'Stable key identifying the task. Reuse for follow-ups.' },
				sessionId: {
					type: 'string',
					description: 'Exact id returned by a previous call. Takes precedence over sessionKey, so quote it back on every follow-up.'
				},
				waitForReply: {
					type: 'boolean',
					description:
						'Block the turn until the user replies in Teams. Leave unset unless the user is away: ' +
						'blocking prevents them answering in this chat.'
				}
			}
		}
	},
	{
		name: 'teams_check_replies',
		description:
			'Check Teams for replies, without posting anything. ' +
			'You MUST pass sessionId or sessionKey unless this server was bound to a session at launch — an ' +
			'unscoped call is rejected because one MCP server is shared with every other agent session on the ' +
			'machine, and consuming another task\'s reply here means the agent it belongs to never sees it. ' +
			'Set waitSeconds to block until one arrives, which is how you keep listening after teams_notify returned no reply.',
		inputSchema: {
			type: 'object',
			properties: {
				waitSeconds: {
					type: 'number',
					description: 'Block up to this many seconds waiting for a reply. Omit to return immediately.'
				},
				sessionId: {
					type: 'string',
					description: 'Exact id returned by teams_notify. Restricts the check to your own task.'
				},
				sessionKey: {
					type: 'string',
					description: 'Stable key of your task, used when you do not have the sessionId.'
				}
			}
		}
	},
	{
		name: 'teams_list_sessions',
		description:
			'List the Teams-connected Copilot sessions this server can see. Use it to re-find your own ' +
			'thread when you have lost the sessionId. ' +
			'Sessions started by a different harness or in a different workspace are not disclosed here — ' +
			'each agent gets the smallest view that still lets it identify its own work.',
		inputSchema: { type: 'object', properties: {} }
	}
];

export class McpServer {
	private readonly protocol: LineProtocol;
	private initialised = false;
	/** Calls the client is still listening to, so an abandoned one can be detected. */
	private readonly inFlight = new Map<string | number, { cancelled: boolean }>();

	constructor(private readonly options: McpServerOptions) {
		this.protocol = new LineProtocol(
			(message) => void this.dispatch(message),
			(error) => this.respond(failure(null, JSON_RPC_ERRORS.parseError, `Parse error: ${error.message}`))
		);
	}

	/** Feeds raw stdin data into the protocol parser. */
	push(chunk: string): void {
		this.protocol.push(chunk);
	}

	private respond(response: JsonRpcResponse): void {
		this.options.write(serialise(response));
	}

	/** The harness the launcher told us it is, defaulting to unknown when unset. */
	private get harness(): HarnessKind {
		return this.options.harness ?? 'unknown';
	}

	/** True when this server process was bound to exactly one session at launch. */
	private get bound(): boolean {
		return Boolean(this.options.boundSessionKey);
	}

	private async dispatch(message: JsonRpcRequest): Promise<void> {
		const id = message.id ?? null;

		// Notifications carry no id and must not be answered.
		const isNotification = message.id === undefined || message.id === null;

		try {
			switch (message.method) {
				case 'initialize': {
					this.initialised = true;
					this.respond(
						success(id, {
							protocolVersion: PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: 'copilot-teams-bridge', version: '0.1.0' }
						})
					);
					return;
				}

				case 'notifications/initialized':
					return;

				case 'notifications/cancelled': {
					// The client has stopped listening. Anything the abandoned call has already
					// taken from the bridge must be handed back, or the user's reply dies with it.
					const requestId = (message.params as { requestId?: string | number } | undefined)?.requestId;
					const entry = requestId === undefined ? undefined : this.inFlight.get(requestId);
					if (entry) {
						entry.cancelled = true;
					}
					return;
				}

				case 'ping':
					this.respond(success(id, {}));
					return;

				case 'tools/list':
					this.respond(success(id, { tools: this.options.delegated ? [] : TOOLS }));
					return;

				case 'tools/call': {
					const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
					const entry = { cancelled: false };
					if (id !== null) {
						this.inFlight.set(id, entry);
					}
					try {
						const result = await this.callTool(params.name ?? '', params.arguments ?? {}, entry);
						if (entry.cancelled) {
							// Responding to a cancelled request is meaningless and the client
							// treats it as protocol noise.
							return;
						}
						this.respond(success(id, result));
					} catch (error) {
						if (error instanceof RpcError) {
							// A tool contract violation the caller must fix: reported at the
							// JSON-RPC layer with an appropriate code, not as a tool result,
							// so the model cannot silently mistake the refusal for a normal
							// empty answer.
							if (!entry.cancelled) {
								this.respond(failure(id, error.code, error.message));
							}
						} else {
							throw error;
						}
					} finally {
						if (id !== null) {
							this.inFlight.delete(id);
						}
					}
					return;
				}

				default:
					if (!isNotification) {
						this.respond(failure(id, JSON_RPC_ERRORS.methodNotFound, `Unknown method: ${message.method}`));
					}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.options.log?.(`Request ${message.method} failed: ${detail}`);
			if (!isNotification) {
				this.respond(failure(id, JSON_RPC_ERRORS.internalError, detail));
			}
		}
	}

	get isInitialised(): boolean {
		return this.initialised;
	}

	private async callTool(name: string, args: Record<string, unknown>, call: CallState): Promise<unknown> {
		if (this.options.delegated && (name === 'teams_notify' || name === 'teams_check_replies' || name === 'teams_list_sessions')) {
			// Hiding the tools from tools/list is the primary defence, but a client with a
			// stale list — or a hard-coded call — could still invoke one. Refuse before
			// touching the bridge so no session is created and no thread is opened, and
			// tell the agent what to do instead: report the result up to the parent that
			// spawned it, which owns the real Teams thread.
			return toolError(
				`This MCP server is running in delegated mode and cannot reach Teams. Report your ${name === 'teams_notify' ? 'update' : 'result'} ` +
					'to the agent that spawned you — it owns the Teams thread and will decide what is posted. ' +
					'Any reply from Teams reaches you by flowing back down through that parent.'
			);
		}
		switch (name) {
			case 'teams_notify':
				return this.notify(args, call);
			case 'teams_check_replies':
				return this.checkReplies(args, call);
			case 'teams_list_sessions':
				return this.listSessions();
			default:
				return toolError(`Unknown tool: ${name}`);
		}
	}

	private async notify(args: Record<string, unknown>, call: CallState): Promise<unknown> {
		const title = typeof args.title === 'string' ? args.title.trim() : '';
		const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
		if (!title || !summary) {
			return toolError('Both title and summary are required.');
		}

		const providedKey = typeof args.sessionKey === 'string' && args.sessionKey.trim() ? args.sessionKey : title;
		// A bound server ignores any sessionKey/sessionId argument that names a different
		// session: binding is the whole point, and the boundary must be enforced here.
		const sessionKey = (this.options.boundSessionKey ?? providedKey).slice(0, 80);
		const rawStatus = typeof args.status === 'string' ? args.status : 'completed';
		// `paused` is a bridge-internal status: the schema keeps it out of the enum, but a
		// non-conforming client could still send it. Coerce silently rather than posting a
		// "Paused" heading for what is a normal update.
		const status = (rawStatus === 'paused' ? 'progress' : rawStatus) as NotificationStatus;

		let posted;
		try {
			posted = await this.options.bridge.notify({
				sessionId: this.bound ? undefined : (typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : undefined),
				sessionKey,
				title,
				summary,
				status,
				question: typeof args.question === 'string' ? args.question : undefined,
				files: Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : undefined,
				awaitingReply: args.waitForReply === true,
				identity: this.identityForNewSession()
			});
		} catch (error) {
			return toolError(`Failed to post to Teams: ${error instanceof Error ? error.message : String(error)}`);
		}

		const lines = [
			`Posted to the Teams conversation for "${posted.session.title}" (sessionKey: "${sessionKey}", sessionId: "${posted.session.id}").`,
			CHAT_DIRECTIVE,
			`Pass sessionId "${posted.session.id}" on every follow-up about this task.`
		];
		if (posted.threadUrl) {
			lines.push(`Thread: ${posted.threadUrl}`);
		}

		if (!posted.repliesSupported) {
			lines.push('This transport cannot receive replies.');
			return toolText(lines.join('\n'));
		}
		if (args.waitForReply !== true) {
			lines.push('Replies will be delivered when they arrive.');
			return toolText(lines.join('\n'));
		}

		const timeoutMs = this.options.waitTimeoutMs ?? DEFAULT_WAIT_MS;
		const routed = await this.options.bridge.waitForReply(posted.session.id, timeoutMs);
		if (call.cancelled) {
			this.returnIfTaken(routed);
			return toolText(CANCELLED_TEXT);
		}
		if (!routed) {
			const failures = this.options.bridge.lastPollFailures;
			if (failures.length > 0) {
				// Silence caused by a broken read must never be reported as "the user said nothing".
				lines.push('', `Teams could not be read (${failures[0].reason}), so a reply may exist but be invisible here.`);
			} else {
				lines.push(
					'',
					`No reply yet after ${Math.round(timeoutMs / 1000)}s. This is a listening window, not the user's answer.`,
					'Prefer ending your turn: the user can answer in this chat or in Teams, and either reaches you. ' +
						'Only if they said they are away, keep listening with teams_check_replies and waitSeconds rather than posting again.'
				);
			}
			return toolText(lines.join('\n'));
		}
		await this.options.bridge.acknowledgeReply(routed);
		const directive = describeCommand(routed.command);
		if (isClosingCommand(routed.command)) {
			lines.push(directive as string);
			return toolText(lines.join('\n'));
		}

		if (routed.text) {
			lines.push('', `The user replied (${routed.reply.from}):`, '---', routed.text, '---');
		} else {
			// A bare command has no text; saying nothing would look like an empty reply.
			lines.push('', `The user sent /${routed.command} (${routed.reply.from}).`);
		}
		if (directive) {
			lines.push('', directive);
		}
		lines.push('', ECHO_DIRECTIVE, `Then continue using it as the next instruction, and report back with sessionKey "${sessionKey}".`);
		return toolText(lines.join('\n'));
	}

	private async checkReplies(args: Record<string, unknown>, call: CallState): Promise<unknown> {
		const waitSeconds = typeof args.waitSeconds === 'number' && args.waitSeconds > 0 ? args.waitSeconds : 0;
		const owned = this.resolveOwnSession(args);
		if (!owned && !this.bound) {
			// An unscoped check on a shared server used to silently drain another session's
			// queue. Rejected at the JSON-RPC layer so the caller cannot mistake the refusal
			// for a normal empty answer.
			throw new RpcError(
				JSON_RPC_ERRORS.invalidParams,
				'teams_check_replies requires sessionId or sessionKey. One MCP server is shared with every ' +
					'other agent session on this machine, and an unscoped check would consume another task\'s reply.'
			);
		}
		if (waitSeconds > 0) {
			const capped = Math.min(waitSeconds * 1000, this.options.waitTimeoutMs ?? DEFAULT_WAIT_MS);
			const routed = owned
				? await this.options.bridge.waitForReply(owned, capped)
				: await this.options.bridge.waitForAnyReply(capped);
			if (call.cancelled) {
				this.returnIfTaken(routed);
				return toolText(CANCELLED_TEXT);
			}
			if (routed) {
				await this.options.bridge.acknowledgeReply(routed);
				return toolText(`1 new reply:\n${renderReplyLine(routed)}\n\n${ECHO_DIRECTIVE}`);
			}
		} else {
			await this.options.bridge.poll();
		}

		// With no handler registered in this host, poll() parks everything it routed in the
		// bridge's undelivered buffer, together with anything an earlier background tick
		// collected while no tool call was waiting.
		const routed = this.options.bridge.takeUndelivered(owned);
		const failures = this.options.bridge.lastPollFailures;

		if (routed.length === 0) {
			if (failures.length > 0) {
				return toolError(
					[
						'Could not read Teams, so it is unknown whether the user has replied:',
						...failures.map((f) => `- ${f.title}: ${f.reason}`),
						'Tell the user their replies are not being picked up rather than assuming there are none.'
					].join('\n')
				);
			}
			return toolText(
				waitSeconds > 0
					? `No reply in ${waitSeconds}s. Call again with waitSeconds to keep listening, or stop and let the user come back to you.`
					: 'No new Teams replies.'
			);
		}

		for (const reply of routed) {
			await this.options.bridge.acknowledgeReply(reply);
		}
		const lines = routed.map(renderReplyLine);
		const text = [`${routed.length} new repl${routed.length === 1 ? 'y' : 'ies'}:`, ...lines];
		if (failures.length > 0) {
			text.push('', `Some threads could not be read: ${failures.map((f) => f.title).join(', ')}.`);
		}
		text.push('', ECHO_DIRECTIVE);
		return toolText(text.join('\n'));
	}

/**
	 * Works out which session the caller owns.
	 *
	 * One MCP server is shared by every agent session in the window, so an unscoped check
	 * hands back whatever arrived first — including another task's reply, which it also
	 * consumes, leaving the agent it belongs to waiting for something already taken.
	 * A bound server always resolves to its bound key regardless of what the caller sent.
	 */
	private resolveOwnSession(args: Record<string, unknown>): string | undefined {
		if (this.options.boundSessionKey) {
			const normalised = this.options.boundSessionKey;
			const match = this.options.bridge
				.listSessions()
				.filter((session) => session.key === normalised && !session.closed)
				.pop();
			return match?.id;
		}
		const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
		if (sessionId && this.options.bridge.getSession(sessionId)) {
			return sessionId;
		}
		const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey.trim() : '';
		if (!sessionKey) {
			return undefined;
		}
		const match = this.options.bridge
			.listSessions()
			.filter((session) => session.key === sessionKey && !session.closed)
			.pop();
		return match?.id;
	}

	/** Hands a reply back to the bridge when the call that took it was abandoned. */
	private returnIfTaken(routed: RoutedReply | undefined): void {
		if (routed) {
			this.options.bridge.returnUndelivered(routed);
			this.options.log?.(`Client cancelled; returned a reply from "${routed.session.title}" to the queue.`);
		}
	}

	private listSessions(): unknown {
		const all = this.options.bridge.listSessions().filter((s) => !s.closed);
		let visible = all;
		if (this.options.boundSessionKey) {
			// A bound server exposes only its own session; other agents on this machine
			// have no business seeing anything else through this process.
			visible = visible.filter((s) => s.key === this.options.boundSessionKey);
		} else {
			// An unbound server still hides sessions that were plainly started by someone
			// else — a different harness or a different workspace — so an agent that lost
			// its sessionId can find its own thread without also learning about others'.
			visible = visible.filter((s) => this.belongsToThisAgent(s));
		}
		if (visible.length === 0) {
			return toolText('No active sessions.');
		}
		// Minimal shape: enough to recognise your own thread, nothing more. lastActivity
		// was dropped because it lets one agent watch another's cadence.
		const lines = visible.map((s) => `- "${s.title}" key=${s.key} status=${s.status}`);
		return toolText(lines.join('\n'));
	}

	/**
	 * Whether a session was started by this server's own harness in this server's workspace.
	 *
	 * Applied only to the unbound listing: we still want an agent that has lost its
	 * sessionId to re-find its own thread, but not by browsing everyone else's. Sessions
	 * with no identity yet (upgrade path) are treated as `unknown`, so a legacy record is
	 * visible to a legacy-shaped (unknown-harness) server and hidden from a stamped one.
	 */
	private belongsToThisAgent(session: import('../../domain/types').Session): boolean {
		const harness = identityOf(session).harness;
		if (harness !== this.harness) {
			return false;
		}
		const bridgeWorkspace = this.workspaceOfBridge();
		if (bridgeWorkspace !== undefined && session.workspace !== undefined && session.workspace !== bridgeWorkspace) {
			return false;
		}
		return true;
	}

	/** The workspace name this server's Bridge was configured with, if any. */
	private workspaceOfBridge(): string | undefined {
		// Bridge does not expose its workspace directly; the sessions it opens carry it.
		// Sampling from any owned session is enough — they all share the same value.
		return this.options.bridge.listSessions().find((s) => s.workspace)?.workspace;
	}

	/**
	 * Identity to stamp on a session this process is about to create.
	 *
	 * The harness comes from the launcher env var; confidence is `exact` because the host
	 * told us what it is, and `mcp-ingest` records where it was captured. Only harness is
	 * known here — no chat is invented — so a later, better identity (one that names a
	 * chat) is not downgraded by preferIdentity. Returns undefined when the harness is
	 * `unknown`, so legacy behaviour is preserved: sessions from an old build that did not
	 * emit the env var still lazily resolve through the relay.
	 */
	private identityForNewSession(): SessionIdentity | undefined {
		if (this.harness === 'unknown') {
			return undefined;
		}
		return {
			harness: this.harness,
			confidence: 'exact',
			capturedBy: 'mcp-ingest',
			capturedAt: new Date().toISOString()
		};
	}
}

/**
 * Replies come back as a tool result, which chat UIs collapse or hide. The user therefore
 * cannot see the instruction they just sent from Teams — only the agent acting on something
 * invisible, which reads as the reply having been ignored. Quoting it back puts the hand-off
 * on the screen the user is actually looking at.
 */
/**
 * Posting to Teams is an extra audience, not a replacement for the one already watching.
 *
 * Without this the tool result reads as "the update has been delivered", so the agent
 * answers the chat with a bare "posted to Teams" and the user sitting in VS Code sees a
 * notification that their work went somewhere else. They have to open Teams to read an
 * update about the editor they are already looking at.
 */
const CHAT_DIRECTIVE =
	'Teams is an additional audience, not a replacement for this chat: still give the full update in your reply here.';

/**
 * A cancelled wait is not a dead end: the host cancels the call when the turn resumes,
 * which usually means the user typed their answer into the chat instead of Teams.
 * Reporting a bare "Cancelled." hid that, so the agent waited again on the channel the
 * user had just chosen not to use.
 */
const CANCELLED_TEXT =
	'The wait ended because this turn resumed, which normally means the user answered in the chat rather than '
	+ 'in Teams. Read their latest message here and treat that as the reply; any Teams reply is kept for later.';

const ECHO_DIRECTIVE =
	'Quote this reply back to the user in your next message so they can see the instruction that arrived from Teams.';

/**
 * Turns a slash command into an instruction the agent can act on.
 *
 * A bare command carries no text, so without this it reached the agent as an empty
 * message: /stop, /status and /ping all arrived as a blank line and were silently
 * ignored, while the engine had already closed the session behind the scenes.
 */
function describeCommand(command: string | undefined): string | undefined {
	if (isClosingCommand(command)) {
		return 'The user asked you to STOP this task. Acknowledge and do nothing further.';
	}
	if (command === 'status') {
		return 'The user asked for a STATUS UPDATE. Post where you have got to with teams_notify, then carry on.';
	}
	if (command === 'ping') {
		return 'The user is checking the bridge is alive. Post a short teams_notify update to confirm.';
	}
	return undefined;
}

/** One line per reply, keeping the meaning a bare command would otherwise lose. */
function renderReplyLine(routed: RoutedReply): string {
	const directive = describeCommand(routed.command);
	const body = routed.text || `/${routed.command}`;
	const head = `[${routed.session.title}] ${routed.reply.from}: ${body}`;
	return directive ? `${head}\n  ${directive}` : head;
}

function toolText(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: false };
}

function toolError(text: string): unknown {
	return { content: [{ type: 'text', text }], isError: true };
}

/**
 * A tool contract violation surfaced as a JSON-RPC error, not a tool result.
 *
 * The MCP tool-error convention (isError on the result) is fine for "I tried and something
 * went wrong", but wrong for "you must fix your call": the model too easily glosses over a
 * tool result and treats it as a normal empty answer. A JSON-RPC error with `invalidParams`
 * is unambiguous — it is not delivered as content, and the client cannot mistake it for a
 * silent success.
 */
class RpcError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
		this.name = 'RpcError';
	}
}
