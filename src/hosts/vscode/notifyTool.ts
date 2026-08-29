import * as vscode from 'vscode';
import type { Bridge } from '../../application/bridge';
import type { NotificationStatus, SessionIdentity } from '../../domain/types';

export interface NotifyToolParams {
	title: string;
	summary: string;
	status: NotificationStatus;
	question?: string;
	files?: string[];
	sessionKey?: string;
	sessionId?: string;
	waitForReply?: boolean;
}

export interface NotifyToolDeps {
	bridge(): Bridge;
	waitTimeoutMs(): number;
	log: vscode.LogOutputChannel;
}

/**
 * Language model tool Copilot calls when it finishes work or gets blocked.
 * With waitForReply it blocks the turn until the user answers in Teams, which is what
 * lets a Teams reply resume the very same Copilot turn.
 */
export class NotifyTool implements vscode.LanguageModelTool<NotifyToolParams> {
	constructor(private readonly deps: NotifyToolDeps) {}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<NotifyToolParams>
	): Promise<vscode.PreparedToolInvocation> {
		const wait = options.input.waitForReply ? ' and wait for your reply' : '';
		return {
			invocationMessage: `Posting to Teams${wait}…`
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<NotifyToolParams>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const input = options.input;
		if (!input?.title || !input?.summary) {
			return text('Teams notification not sent: both title and summary are required.');
		}

		const bridge = this.deps.bridge();
		const sessionKey = (input.sessionKey ?? input.title).trim().slice(0, 80) || 'copilot-session';

		let posted;
		const chatSessionResource = chatSessionOf(options, this.deps.log);
		// `paused` is a bridge-internal status used only by the expiry notice, so a caller
		// that supplies it is either mistaken or malicious. Coerce silently to 'progress'
		// rather than letting a red "Paused" heading be posted for a normal update.
		const requested = input.status ?? 'completed';
		const status: NotificationStatus = requested === 'paused' ? 'progress' : requested;
		try {
			posted = await bridge.notify({
				sessionId: input.sessionId,
				sessionKey,
				title: input.title,
				summary: input.summary,
				status,
				question: input.question,
				files: input.files,
				awaitingReply: Boolean(input.waitForReply),
				chatSessionResource,
				identity: identityFrom(chatSessionResource)
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log.error(`Teams notification failed: ${message}`);
			return text(`Failed to post the Teams notification: ${message}. Continue the task without Teams.`);
		}

		const lines = [
			`Posted to the Teams thread for session "${posted.session.title}".`,
			CHAT_DIRECTIVE,
			// Quoting the id back removes any ambiguity about which task a later call means.
			`Pass sessionId: "${posted.session.id}" on every further update about this task.`
		];
		// Report the OWNING session's key. When this chat's session was opened under a
		// different key (typically `chat-<uuid>` written by the transcript watcher), the
		// bridge reused it — telling the model to keep using the key it just supplied
		// would send the next call chasing a session that does not identify this chat.
		const owningKey = posted.session.key;
		if (posted.threadUrl) {
			lines.push(`Thread: ${posted.threadUrl}`);
		}
		if (!posted.repliesSupported) {
			lines.push('This transport is one-way, so no reply can be received.');
			return text(lines.join('\n'));
		}

		if (!input.waitForReply) {
			// The session deliberately stays open after completion: the user may reply with
			// follow-up work, and that must continue this task rather than start a new one.
			lines.push(
				input.status === 'completed'
					? `This session stays open. If the user replies in that thread it will arrive as a new instruction; treat it as a continuation of this task and keep using sessionKey "${owningKey}".`
					: 'Any reply the user posts in that thread will be delivered to Copilot Chat automatically.'
			);
			return text(lines.join('\n'));
		}

		const timeoutMs = this.deps.waitTimeoutMs();
		const waiting = bridge.waitForReply(posted.session.id, timeoutMs);
		const routed = await Promise.race([waiting, cancellation(token)]);

		if (routed === 'cancelled') {
			// The wait is still registered, so a reply arriving now would be consumed by a
			// promise nobody is reading and lost for good. Hand anything it takes back.
			void waiting.then((late) => {
				if (late) {
					bridge.returnUndelivered(late);
				}
			});
			lines.push(
				'',
				'The wait ended because this chat became active again, which normally means the user answered HERE ' +
					'rather than in Teams. Read their latest message in this conversation and treat that as the reply. ' +
					'Do not go back to waiting on Teams.'
			);
			return text(lines.join('\n'));
		}
		if (!routed) {
			lines.push(
				'',
				`No reply yet after ${Math.round(timeoutMs / 1000)}s. That is a listening window closing, not the user's answer.`,
				'End your turn rather than waiting again: the user can answer in this chat or in Teams, and either ' +
					'reaches you. A Teams reply arriving later is delivered here automatically.'
			);
			return text(lines.join('\n'));
		}
		if (routed.command === 'stop' || routed.command === 'cancel') {
			lines.push('The user asked you to STOP work on this task. Acknowledge and do nothing further.');
			return text(lines.join('\n'));
		}

		lines.push('', `The user replied in Teams (${routed.reply.from}):`, '---', routed.text, '---');
		lines.push('', `Treat that reply as the next instruction and continue. Report back with copilotTeamsBridge_notify using sessionKey "${owningKey}".`);
		return text(lines.join('\n'));
	}
}

/**
 * Posting to Teams is an extra audience, not a replacement for the one already watching.
 *
 * Without this the tool result reads as "the update has been delivered", so the agent
 * answers the chat with a bare "posted to Teams" and the user sitting in VS Code sees a
 * notification that their work went somewhere else.
 */
const CHAT_DIRECTIVE =
	'Teams is an additional audience, not a replacement for this chat: still give the full update in your reply here.';

/**
 * Works out which chat session invoked the tool.
 *
 * `ChatParticipantToolToken` is typed `never`, but the extension host really passes
 * `{ sessionResource, workingDirectory }`, and VS Code's own built-in tools use that field
 * to find the calling chat. Reading it defensively is what lets a Teams reply be steered
 * back to the conversation that started the work rather than whichever one has focus.
 * Undefined simply means the older, focus-based delivery is used.
 */
/**
 * Turns the calling chat into a recorded identity.
 *
 * The tool runs inside the extension host, so the host hands it the conversation that
 * made the call -- the strongest evidence available anywhere in the system. Without a
 * resource the caller is out of process (an agent session over MCP), which is a fact
 * worth recording rather than an absence: it tells delivery to hold instead of guess.
 */
function identityFrom(chatSessionResource: string | undefined): SessionIdentity {
	const capturedAt = new Date().toISOString();
	return chatSessionResource
		? {
				harness: 'vscode-sidebar',
				chat: { kind: 'chat-session-resource', value: chatSessionResource },
				confidence: 'exact',
				capturedBy: 'notify-tool',
				capturedAt
			}
		: { harness: 'vscode-agent-mcp', confidence: 'unknown', capturedBy: 'notify-tool', capturedAt };
}

function chatSessionOf(
	options: vscode.LanguageModelToolInvocationOptions<NotifyToolParams>,
	log: vscode.LogOutputChannel
): string | undefined {
	const token = options.toolInvocationToken as unknown as { sessionResource?: unknown } | undefined;
	const resource = token?.sessionResource;
	if (!resource) {
		log.debug('No chat session on the tool invocation token; replies will use the focused chat.');
		return undefined;
	}
	try {
		// A Uri when revived by the extension host, but a plain object over some hosts.
		const uri = resource instanceof vscode.Uri ? resource : vscode.Uri.from(resource as { scheme: string });
		log.debug(`Chat session for this call: ${uri.toString()}`);
		return uri.toString();
	} catch (error) {
		log.debug(`Could not read the chat session from the tool token: ${String(error)}`);
		return undefined;
	}
}

function text(value: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

function cancellation(token: vscode.CancellationToken): Promise<'cancelled'> {
	return new Promise((resolve) => {
		if (token.isCancellationRequested) {
			resolve('cancelled');
			return;
		}
		token.onCancellationRequested(() => resolve('cancelled'));
	});
}

