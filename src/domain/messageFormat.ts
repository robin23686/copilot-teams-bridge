import type { NotificationStatus, OutboundNotification } from './types';

const STATUS_META: Record<NotificationStatus, { emoji: string; label: string; colour: string }> = {
	completed: { emoji: '✅', label: 'Completed', colour: 'Good' },
	'needs-input': { emoji: '❓', label: 'Needs your input', colour: 'Warning' },
	failed: { emoji: '❌', label: 'Failed', colour: 'Attention' },
	progress: { emoji: '⏳', label: 'In progress', colour: 'Accent' },
	// Neutral, deliberately not alarming: expiry is a normal lifecycle event, not a failure.
	paused: { emoji: '⏸️', label: 'Paused', colour: 'Accent' }
};

export function statusMeta(status: NotificationStatus): { emoji: string; label: string; colour: string } {
	return STATUS_META[status] ?? STATUS_META.progress;
}

/**
 * When the bridge tags the user with an @mention on a Teams message.
 *
 * Every mention raises an activity-feed ping, and posting one on each progress reply floods
 * that feed — so `keyMoments` (the default) narrows tagging to the moments a user actually
 * wants surfaced: a new thread starting, or an update that needs their reply. `everyMessage`
 * preserves the previous behaviour for anyone who wants it; `never` silences mentions even
 * on the root message.
 */
export type MentionPolicy = 'keyMoments' | 'everyMessage' | 'never';

/**
 * True when the current message should carry an @mention under the given policy.
 *
 * `isRoot` marks the very first message of a session thread. Both `status === 'needs-input'`
 * and `awaitingReply === true` count as "input needed from the user" — the second is how
 * Copilot signals it is blocking on a Teams reply even when the status stays at 'progress'.
 */
export function shouldMentionUser(
	notification: OutboundNotification,
	isRoot: boolean,
	policy: MentionPolicy
): boolean {
	if (policy === 'never') {
		return false;
	}
	if (policy === 'everyMessage') {
		return true;
	}
	return isRoot || notification.status === 'needs-input' || notification.awaitingReply === true;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		// The Agency MCP compiles `content` as a .NET regex, so a Windows path such as
		// `%APPDATA%\Code` is rejected with "Unrecognized escape sequence" (\C is not a
		// valid escape, while \b happens to be, which made the failure look intermittent).
		// The entity renders as a normal backslash, so this is invisible to the reader.
		// Must stay last: it emits an `&` that the earlier rule would otherwise re-escape.
		.replace(/\\/g, '&#92;');
}

/**
 * Renders a notification as the simple HTML subset Teams accepts for channel messages.
 * Teams strips unknown tags, so this deliberately sticks to p/b/i/ul/li/code/blockquote.
 */
export function renderNotificationHtml(
	notification: OutboundNotification,
	options: { isRoot: boolean; highlight?: boolean; mentionName?: string } = { isRoot: true }
): string {
	const meta = statusMeta(notification.status);
	const parts: string[] = [];

	if (options.isRoot) {
		// The server rewrites a bare @DisplayName into real mention markup, which is what
		// makes the message reach the user's activity feed.
		const mention = options.mentionName ? `@${escapeHtml(options.mentionName)} ` : '';
		parts.push(`<p>${mention}<b>${meta.emoji} ${escapeHtml(notification.title)}</b></p>`);
	} else {
		const mention = options.mentionName ? `@${escapeHtml(options.mentionName)} ` : '';
		parts.push(`<p>${mention}<b>${meta.emoji} ${escapeHtml(meta.label)}</b> — ${escapeHtml(notification.title)}</p>`);
	}

	parts.push(`<p>${markdownishToHtml(notification.summary)}</p>`);

	if (notification.files?.length) {
		const items = notification.files.slice(0, 20).map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join('');
		const more = notification.files.length > 20 ? `<li><i>…and ${notification.files.length - 20} more</i></li>` : '';
		parts.push(`<p><b>Files</b></p><ul>${items}${more}</ul>`);
	}

	if (notification.question) {
		parts.push(`<blockquote><b>Question:</b> ${escapeHtml(notification.question)}</blockquote>`);
	}

	const footer: string[] = [];
	if (notification.workspace) {
		footer.push(`<i>${escapeHtml(notification.workspace)}</i>`);
	}
	if (notification.repliesReachChat === false) {
		// Every other branch invites a reply. Saying that to a session whose chat cannot be
		// reached would be a promise the bridge knows it cannot keep, and the user only
		// finds out after typing — having already assumed the work was continuing.
		if (notification.unreachableHarness === 'cli-runtime') {
			// A CLI-hosted agent has no VS Code chat to open, and the reply is not lost —
			// it is queued for the agent that started this session and picked up next time
			// that agent checks. Saying "open this chat in VS Code" would be a lie (there
			// is no chat) and inviting a prompt reply would misdescribe the pickup cadence.
			footer.push(
				'<b>Your reply is queued for the Copilot CLI session that started this task.</b> ' +
					'It reaches that agent the next time it checks for replies; if that agent has ' +
					'already finished, continue the work in VS Code.'
			);
		} else {
			footer.push(
				'<b>Replies here will not reach Copilot.</b> Open this chat in VS Code to give it ' +
					'the next instruction.'
			);
		}
	} else if (notification.awaitingReply) {
		footer.push('<b>Copilot is waiting for your reply in this thread.</b>');
	} else if (notification.status === 'needs-input') {
		footer.push('<b>Reply in this thread to answer.</b>');
	} else {
		footer.push('Reply in this thread to send Copilot a new instruction.');
	}
	parts.push(`<p>${footer.join(' · ')}</p>`);

	return parts.join('');
}

/** Subject line used for the root message of a session thread. */
export function renderThreadSubject(notification: OutboundNotification): string {
	const meta = statusMeta(notification.status);
	const title = notification.title.trim() || 'Copilot session';
	return `${meta.emoji} Copilot · ${truncate(title, 120)}`;
}

/**
 * Turns the Teams HTML body of a reply into the plain instruction text Copilot should receive.
 * Drops at-mentions, quoted originals, images and formatting while preserving line structure.
 */
export function cleanReplyText(rawBody: string, contentType: 'html' | 'text' = 'html'): string {
	if (contentType === 'text') {
		return normaliseWhitespace(stripLeadingMentions(rawBody));
	}

	let text = rawBody;
	// Quoted originals are noise: Teams includes them when a user uses "reply with quote".
	text = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ');
	text = text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, ' ');
	text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
	text = text.replace(/<img\b[^>]*>/gi, ' ');
	text = text.replace(/<br\s*\/?>/gi, '\n');
	text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
	text = text.replace(/<li\b[^>]*>/gi, '- ');
	text = text.replace(/<[^>]+>/g, '');
	text = decodeHtmlEntities(text);
	return normaliseWhitespace(stripLeadingMentions(text));
}

export interface ParsedReply {
	/** Instruction text to hand back to Copilot; empty when the reply was only a command. */
	text: string;
	/** Slash command found at the start of the reply, lower-cased and without the slash. */
	command?: string;
}

const KNOWN_COMMANDS = new Set(['stop', 'close', 'done', 'cancel', 'status', 'ping']);

/**
 * Commands that end the session.
 *
 * Defined once because the engine and the hosts disagreed: the engine closed a session on
 * all four while the MCP server recognised only two, so /done and /close shut the thread
 * down without ever telling the agent to stop.
 */
export const CLOSING_COMMANDS: ReadonlySet<string> = new Set(['stop', 'close', 'done', 'cancel']);

/** True when a parsed command ends the session. */
export function isClosingCommand(command: string | undefined): boolean {
	return command !== undefined && CLOSING_COMMANDS.has(command);
}

/** Splits a cleaned reply into an optional leading slash-command and the remaining instruction. */
export function parseReply(cleanedText: string): ParsedReply {
	const match = /^\/([a-z]+)\b\s*([\s\S]*)$/i.exec(cleanedText.trim());
	if (!match) {
		return { text: cleanedText.trim() };
	}
	const command = match[1].toLowerCase();
	if (!KNOWN_COMMANDS.has(command)) {
		return { text: cleanedText.trim() };
	}
	return { command, text: match[2].trim() };
}

/** True when a reply carries no actionable content (empty body, reaction-only, sticker). */
export function isEmptyReply(cleanedText: string): boolean {
	return cleanedText.replace(/[\s\u200b]/g, '').length === 0;
}

function stripLeadingMentions(text: string): string {
	// "@Copilot do the thing" -> "do the thing"; only strips mentions at the very start.
	return text.replace(/^(\s*@[\w .'-]{1,40}[:,]?\s*)+/g, '');
}

function normaliseWhitespace(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/[ \t\u00a0]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function decodeHtmlEntities(text: string): string {
	// Teams HTML uses a wider entity set than the XML five, especially for punctuation
	// produced by autocorrect (em dashes, curly quotes, ellipses).
	const named: Record<string, string> = {
		amp: '&',
		lt: '<',
		gt: '>',
		quot: '"',
		apos: "'",
		nbsp: ' ',
		mdash: '—',
		ndash: '–',
		hellip: '…',
		lsquo: '\u2018',
		rsquo: '\u2019',
		ldquo: '\u201c',
		rdquo: '\u201d',
		bull: '•',
		middot: '·',
		laquo: '«',
		raquo: '»',
		deg: '°',
		trade: '™',
		copy: '©',
		reg: '®',
		euro: '€',
		pound: '£',
		times: '×',
		divide: '÷',
		'#39': "'"
	};
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
		const key = entity.toLowerCase();
		if (named[key] !== undefined) {
			return named[key];
		}
		if (key.startsWith('#x')) {
			const code = Number.parseInt(key.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		if (key.startsWith('#')) {
			const code = Number.parseInt(key.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return whole;
	});
}

function markdownishToHtml(summary: string): string {
	const escaped = escapeHtml(summary.trim());
	return escaped
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
		.replace(/\n{2,}/g, '</p><p>')
		.replace(/\n/g, '<br/>');
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}


/**
 * The line that identifies a reply delivered from Teams, in a chat transcript or a CLI
 * session.
 *
 * Doubles as the proof of delivery: it names the session and the sender, so finding it in a
 * given conversation's transcript is what confirms the request reached *that* conversation
 * rather than merely being written somewhere.
 *
 * Defined here, in the domain, because more than one delivery route now emits it -- a chat
 * write and a resumed CLI session. Two copies of this string would drift, and the copy that
 * drifted would be the one delivery is confirmed against, so confirmation would start
 * failing for replies that had in fact landed.
 */
export function deliveryMarker(sessionTitle: string, from: string): string {
	return `[Teams reply \u00b7 session "${sessionTitle}" \u00b7 from ${from}]`;
}