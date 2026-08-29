import { noopLogger } from '../../application/ports';
import { spawn, type ChildProcess } from 'child_process';
import { cleanReplyText, renderNotificationHtml, renderThreadSubject, shouldMentionUser, type MentionPolicy } from '../../domain/messageFormat';
import { JsonPostedMessagesRegistry, noopPostedMessagesRegistry, type PostedMessagesRegistry } from '../postedMessages';
import type { BridgeLogger, ThreadedTransport } from '../../application/ports';
import type { InboundReply, OutboundNotification, PostResult, ThreadRef } from '../../domain/types';

export interface AgencyTeamsTransportOptions {
	teamId: string;
	channelId: string;
	/** Command that starts the Agency Teams MCP server. */
	command?: string;
	args?: string[];
	logger?: BridgeLogger;
	/** Milliseconds to wait for a tool call before giving up. */
	requestTimeoutMs?: number;
	/**
	 * When to @mention the signed-in user. Defaults to `keyMoments`: the root message of a
	 * thread and any message that needs the user's input. Everything else posts into the
	 * thread without a mention so it does not raise a Teams activity-feed ping.
	 */
	mentionPolicy?: MentionPolicy;
	/**
	 * Legacy alias kept so older callers still compile. When `false`, treated as
	 * `mentionPolicy: 'never'`; when `true` or unset, `mentionPolicy` takes over.
	 * @deprecated Use `mentionPolicy` instead.
	 */
	mentionSelf?: boolean;
	/** UPN to tag, when the channel has more than one member. Defaults to the first member. */
	mentionUpn?: string;
	/** Injected for tests so no real process is spawned. */
	spawnImpl?: typeof spawn;
	/**
	 * Cross-process record of message ids the bridge itself posted, so its own messages are
	 * never read back as inbound replies. Defaults to the on-disk JSON registry; tests pass
	 * a no-op or an in-memory fake.
	 */
	postedMessages?: PostedMessagesRegistry;
}

export interface TeamsIdentity {
	id: string;
	displayName: string;
}

export interface TeamSummary {
	id: string;
	displayName: string;
}

export interface ChannelSummary {
	id: string;
	displayName: string;
}

interface JsonRpcResponse {
	id?: number;
	result?: { content?: { type: string; text?: string }[]; isError?: boolean; serverInfo?: unknown };
	error?: { code?: number; message?: string };
}

/** JSON-RPC code the Agency proxy returns once its upstream session has lapsed. */
const SESSION_NOT_FOUND = -32001;

interface GraphMessage {
	id: string;
	createdDateTime?: string;
	deletedDateTime?: string | null;
	messageType?: string;
	subject?: string | null;
	body?: { contentType?: string; content?: string };
	from?: { displayName?: string; user?: { displayName?: string } } | null;
}

/**
 * Fully two-way transport backed by the Agency Teams MCP server.
 *
 * This is the only path that both posts and reads without admin consent in tenants that
 * require preauthorization for first-party applications: the Agency MCP platform is
 * already approved, so `ListChannelMessages` succeeds where a direct Graph call with a
 * user token returns 403. Because reading works, no Power Automate flow, OneDrive sync or
 * public tunnel is needed.
 */
export class AgencyTeamsTransport implements ThreadedTransport {
	readonly kind = 'graph' as const;
	readonly supportsReplies = true;

	private child: ChildProcess | undefined;
	private starting: Promise<void> | undefined;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: JsonRpcResponse): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	private readonly logger: BridgeLogger;
	private readonly postedMessages: PostedMessagesRegistry;
	private readonly mentionPolicy: MentionPolicy;
	/** undefined = not looked up yet, null = lookup failed or nobody to tag. */
	private self: TeamsIdentity | null | undefined;

	constructor(private readonly options: AgencyTeamsTransportOptions) {
		if (!options.teamId || !options.channelId) {
			throw new Error('Agency Teams transport requires both a teamId and a channelId.');
		}
		this.logger = options.logger ?? noopLogger;
		// The registry defaults to the on-disk shared file, so both the extension and the
		// MCP server see the same set of ids without any wiring: bootstrapping still works
		// when only one process has been upgraded.
		this.postedMessages = options.postedMessages ?? safeDefaultPostedRegistry(this.logger);
		// `mentionSelf === false` is the previous suppress-everything switch; treat it as
		// "never" so callers that still pass it keep the exact same behaviour.
		this.mentionPolicy = options.mentionSelf === false ? 'never' : options.mentionPolicy ?? 'keyMoments';
	}

	async createThread(notification: OutboundNotification): Promise<PostResult> {
		const messageId = await this.sendMessage(notification, true);
		// Recorded before the id is handed back, so a concurrent poll on the other process
		// cannot fetch this message and read it as a fresh instruction.
		this.postedMessages.record(messageId);
		// The root message id is the thread id, so replies can be fetched against it.
		return { thread: { id: messageId }, postedMessageId: messageId };
	}

	async postToThread(thread: ThreadRef, notification: OutboundNotification): Promise<PostResult> {
		const messageId = await this.reply(thread.id, notification);
		this.postedMessages.record(messageId);
		return { thread, postedMessageId: messageId };
	}

	async fetchReplies(thread: ThreadRef, sinceIso: string | undefined): Promise<InboundReply[]> {
		const payload = await this.callTool('ListChannelMessageReplies', {
			teamId: this.options.teamId,
			channelId: this.options.channelId,
			messageId: thread.id,
			maxReplies: 50
		});

		const messages = extractMessages(payload);
		const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
		const replies: InboundReply[] = [];

		for (const message of messages) {
			if (message.deletedDateTime) {
				continue;
			}
			if (message.messageType && message.messageType !== 'message') {
				continue;
			}
			// A message this bridge posted is not a user instruction. With delegated auth the
			// bridge posts as the same user who replies, so nothing in the transport payload
			// tells them apart — only the recorded id does. The extension store and the MCP
			// store are separate files, so an id suppressed in one is unknown to the other;
			// the shared registry closes that gap, and without it every bridge post loops
			// back through the poller as a new inbound reply.
			if (this.postedMessages.has(message.id)) {
				this.logger.debug?.(`Dropping self-posted Teams message ${message.id}`);
				continue;
			}
			const createdMs = message.createdDateTime ? Date.parse(message.createdDateTime) : Number.NaN;
			if (!Number.isNaN(sinceMs) && !Number.isNaN(createdMs) && createdMs <= sinceMs) {
				continue;
			}
			replies.push({
				id: message.id,
				threadId: thread.id,
				text: cleanReplyText(message.body?.content ?? '', message.body?.contentType?.toLowerCase() === 'text' ? 'text' : 'html'),
				from: message.from?.displayName ?? message.from?.user?.displayName ?? 'Teams user',
				createdAt: message.createdDateTime ?? new Date().toISOString()
			});
		}

		return replies.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	}

	/** Lists the teams the signed-in user belongs to, for setup. */
	async listTeams(): Promise<TeamSummary[]> {
		const payload = await this.callTool('ListTeams', {});
		const teams = (payload as { teams?: TeamSummary[]; value?: TeamSummary[] } | null);
		return (teams?.teams ?? teams?.value ?? []).filter((team) => team.id && team.displayName);
	}

	/** Lists the channels in a team, for setup. */
	async listChannels(teamId: string): Promise<ChannelSummary[]> {
		const payload = await this.callTool('ListChannels', { teamId });
		const channels = (payload as { channels?: ChannelSummary[]; value?: ChannelSummary[] } | null);
		return (channels?.channels ?? channels?.value ?? []).filter((channel) => channel.id && channel.displayName);
	}

	/**
	 * Rewrites the root message of a thread so it shows a new title.
	 *
	 * Teams fixes a thread's subject when it is created and the API exposes no way to
	 * change it, so the header keeps its original text. Updating the body is the closest
	 * available equivalent and is what shows in the conversation itself.
	 */
	async renameThread(thread: ThreadRef, notification: OutboundNotification): Promise<void> {
		// A rename rewrites the ROOT message of the thread, so it counts as a start-of-thread
		// event under the mention policy.
		const me = shouldMentionUser(notification, true, this.mentionPolicy) ? await this.resolveSelf() : undefined;
		await this.callTool('UpdateChatMessage', {
			chatId: this.options.channelId,
			messageId: thread.id,
			content: renderNotificationHtml(notification, { isRoot: true, mentionName: me?.displayName }),
			contentType: 'html',
			mentions: me ? JSON.stringify([{ displayName: me.displayName, id: me.id, type: 'user' }]) : undefined
		});
		this.logger.info(`Renamed thread ${thread.id} to "${notification.title}"`);
	}

	dispose(): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error('Transport disposed'));
		}
		this.pending.clear();
		this.child?.kill();
		this.child = undefined;
		this.starting = undefined;
	}

	private async sendMessage(notification: OutboundNotification, isRoot: boolean): Promise<string> {
		const me = shouldMentionUser(notification, isRoot, this.mentionPolicy) ? await this.resolveSelf() : undefined;

		const payload = await this.callTool('SendMessageToChannel', {
			teamId: this.options.teamId,
			channelId: this.options.channelId,
			subject: isRoot ? renderThreadSubject(notification) : undefined,
			content: renderNotificationHtml(notification, { isRoot, mentionName: me?.displayName }),
			contentType: 'html',
			mentions: me ? JSON.stringify([{ displayName: me.displayName, id: me.id, type: 'user' }]) : undefined
		});
		return readMessageId(payload) ?? `sent-${Date.now()}`;
	}

	/**
	 * Resolves the signed-in user so the thread can tag them.
	 *
	 * Cached because it is needed for every new thread and never changes within a run.
	 * A failure must not stop the notification, so callers treat the result as optional.
	 */
	private async resolveSelf(): Promise<TeamsIdentity | undefined> {
		if (this.self !== undefined) {
			return this.self ?? undefined;
		}
		try {
			const payload = await this.callTool('ListChannelMembers', {
				teamId: this.options.teamId,
				channelId: this.options.channelId
			});
			// A mention needs the AAD user id, not the channel membership id.
			const members = (payload as { members?: { userId?: string; displayName?: string; email?: string }[] } | null)?.members ?? [];
			const match = this.options.mentionUpn
				? members.find((m) => m.email?.toLowerCase() === this.options.mentionUpn?.toLowerCase())
				: members[0];

			if (match?.userId && match.displayName) {
				this.self = { id: match.userId, displayName: match.displayName };
				return this.self;
			}
			this.self = null;
			return undefined;
		} catch (error) {
			this.logger.warn(`Could not resolve a user to @mention: ${error instanceof Error ? error.message : String(error)}`);
			this.self = null;
			return undefined;
		}
	}

	private async reply(messageId: string, notification: OutboundNotification): Promise<string> {
		// Thread replies are never the root, so the mention policy decides on the notification
		// itself: under `keyMoments`, only messages that need the user's input tag them —
		// progress and completion updates post silently into the thread instead of raising
		// an activity-feed ping for every turn.
		const me = shouldMentionUser(notification, false, this.mentionPolicy) ? await this.resolveSelf() : undefined;

		const payload = await this.callTool('ReplyToChannelMessage', {
			teamId: this.options.teamId,
			channelId: this.options.channelId,
			messageId,
			content: renderNotificationHtml(notification, { isRoot: false, mentionName: me?.displayName }),
			contentType: 'html',
			mentions: me ? JSON.stringify([{ displayName: me.displayName, id: me.id, type: 'user' }]) : undefined
		});
		return readMessageId(payload) ?? `reply-${Date.now()}`;
	}

	/**
	 * Calls an Agency tool, restarting the subprocess once if its upstream session lapsed.
	 *
	 * The launcher is a long-lived child, but the session it holds against the Agency
	 * proxy expires after a few minutes of inactivity. The child stays up, so nothing
	 * signals the loss: every later call just fails with "Session not found" forever.
	 * Polling then reports "no replies" indefinitely while messages pile up in Teams.
	 * Respawning on that specific error is what makes a bridge left open overnight
	 * still work in the morning.
	 */
	private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		try {
			return await this.invoke(name, args);
		} catch (error) {
			if (!isStaleSessionError(error)) {
				throw error;
			}
			this.logger.warn(`Agency session lapsed during ${name}; restarting the Teams MCP subprocess.`);
			this.restart();
			return this.invoke(name, args);
		}
	}

	private async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
		await this.ensureStarted();
		const response = await this.request('tools/call', { name, arguments: prune(args) });

		if (response.error) {
			throw new AgencyCallError(`${name} failed: ${response.error.message ?? 'unknown error'}`, response.error.code);
		}
		const parts = (response.result?.content ?? []).map((part) => part.text ?? '');
		if (response.result?.isError) {
			throw new AgencyCallError(`${name} failed: ${parts.join(' ').slice(0, 300)}`);
		}

		// The server appends a plain-text "CorrelationId: ..." diagnostic as a second part,
		// so the parts must be parsed individually rather than concatenated.
		for (const part of parts) {
			const trimmed = part.trim();
			if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
				continue;
			}
			try {
				return JSON.parse(trimmed);
			} catch {
				// Not the payload part; keep looking.
			}
		}
		return parts.join('');
	}

	private ensureStarted(): Promise<void> {
		if (this.starting) {
			return this.starting;
		}
		// A failed launch must not be cached, or every later call reuses the rejection and
		// the transport can never recover.
		const attempt = this.start().catch((error: unknown) => {
			if (this.starting === attempt) {
				this.starting = undefined;
			}
			throw error;
		});
		this.starting = attempt;
		return attempt;
	}

	/**
	 * Tears the subprocess down so the next call starts a fresh one.
	 *
	 * In-flight requests are rejected rather than left hanging, because their ids belong
	 * to a stream nobody is reading any more and their timers would otherwise keep the
	 * process alive for the full request timeout.
	 */
	private restart(): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error('Agency Teams MCP restarted'));
		}
		this.pending.clear();
		this.buffer = '';
		const child = this.child;
		this.child = undefined;
		this.starting = undefined;
		child?.removeAllListeners('exit');
		child?.kill();
	}

	private async start(): Promise<void> {
		const command = this.options.command ?? 'agency';
		const args = this.options.args ?? ['mcp', 'teams', '--transport', 'stdio'];
		const spawnFn = this.options.spawnImpl ?? spawn;

		// The agency launcher is a .cmd shim on Windows, which Node will not spawn directly.
		const [executable, execArgs] =
			process.platform === 'win32' && this.options.spawnImpl === undefined
				? ['cmd.exe', ['/d', '/s', '/c', command, ...args]]
				: [command, args];

		this.child = spawnFn(executable, execArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		this.child.stdout?.setEncoding('utf8');
		this.child.stdout?.on('data', (chunk: string) => this.consume(chunk));
		this.child.stderr?.setEncoding('utf8');
		this.child.stderr?.on('data', (chunk: string) => {
			const line = chunk.trim();
			if (line) {
				this.logger.info(`agency: ${line.split('\n')[0].slice(0, 200)}`);
			}
		});
		this.child.on('exit', (code) => {
			this.logger.warn(`Agency Teams MCP exited with code ${code}`);
			this.child = undefined;
			this.starting = undefined;
		});

		await this.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'copilot-teams-bridge', version: '0.1.0' }
		});
		this.logger.info('Agency Teams MCP ready');
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf('\n');
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				try {
					const message = JSON.parse(line) as JsonRpcResponse;
					const entry = message.id === undefined ? undefined : this.pending.get(message.id);
					if (entry) {
						clearTimeout(entry.timer);
						this.pending.delete(message.id as number);
						entry.resolve(message);
					}
				} catch {
					// Non-JSON banner output from the launcher is expected; ignore it.
				}
			}
			newline = this.buffer.indexOf('\n');
		}
	}

	private request(method: string, params: unknown): Promise<JsonRpcResponse> {
		const id = this.nextId++;
		const timeoutMs = this.options.requestTimeoutMs ?? 120_000;

		return new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${method}`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timer });
			this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}
}

/** Removes undefined values so optional arguments are omitted rather than sent as null. */
function prune(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

/** Carries the JSON-RPC code through so a lapsed session can be told from a real failure. */
class AgencyCallError extends Error {
	constructor(
		message: string,
		readonly code?: number
	) {
		super(message);
		this.name = 'AgencyCallError';
	}
}

/**
 * True when the failure means "the subprocess is stale", not "the request was wrong".
 *
 * The code is matched first because it is unambiguous; the text check covers proxy
 * versions that report the same condition without a structured code.
 */
function isStaleSessionError(error: unknown): boolean {
	if (error instanceof AgencyCallError && error.code === SESSION_NOT_FOUND) {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return /session (not found|expired|has expired)/i.test(message);
}

function extractMessages(payload: unknown): GraphMessage[] {
	if (Array.isArray(payload)) {
		return payload as GraphMessage[];
	}
	const record = payload as { messages?: GraphMessage[]; value?: GraphMessage[]; replies?: GraphMessage[] } | null;
	return record?.messages ?? record?.value ?? record?.replies ?? [];
}

function readMessageId(payload: unknown): string | undefined {
	if (typeof payload === 'string') {
		const match = /"?id"?\s*[:=]\s*"?(\d{10,})/.exec(payload);
		return match?.[1];
	}
	const record = payload as { id?: string; messageId?: string; message?: { id?: string } } | null;
	return record?.id ?? record?.messageId ?? record?.message?.id;
}

/**
 * The on-disk posted registry, or a no-op if construction fails.
 *
 * Constructing the registry only computes paths, so this is defensive rather than expected
 * to fire — but if the home directory cannot be resolved, dropping suppression is better
 * than refusing to post at all.
 */
function safeDefaultPostedRegistry(logger: BridgeLogger): PostedMessagesRegistry {
	try {
		return new JsonPostedMessagesRegistry();
	} catch (error) {
		logger.warn(`Could not initialise the posted-messages registry: ${error instanceof Error ? error.message : String(error)}`);
		return noopPostedMessagesRegistry;
	}
}


