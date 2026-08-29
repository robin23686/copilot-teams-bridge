/**
 * Linking a Teams session back to the chat that started it.
 *
 * A notification sent through the extension records the chat it came from, because the
 * tool invocation carries it. One sent through the MCP server cannot: that server is a
 * separate process with no VS Code API, so its sessions have no chat recorded and a reply
 * had to fall back to whichever chat happened to be focused — which is how replies landed
 * in the wrong conversation.
 *
 * The transcript closes the gap. When an agent calls the tool, VS Code records the call
 * and its arguments in that chat's transcript, so the session key written by the server
 * appears in the transcript of the chat that sent it. Finding it names the right chat.
 *
 * Pure logic, so it can be tested against real transcripts without an editor.
 */

/** VS Code addresses a chat session by the base64 of its id under this scheme. */
const CHAT_SESSION_SCHEME = 'vscode-chat-session://local/';

/** The recorded form of a tool call's arguments. */
const RAW_INPUT_MARKER = '"rawInput":';

/** Builds the resource that identifies a chat session to VS Code's own commands. */
export function chatSessionResourceFor(chatSessionId: string): string {
	return CHAT_SESSION_SCHEME + Buffer.from(chatSessionId, 'utf8').toString('base64');
}

/**
 * Scheme VS Code gives a "Copilot mode" chat, backed by the Copilot CLI agent host.
 *
 * Lives here rather than with the code that reads VS Code's index because whether a
 * reference names that surface is a fact about the reference itself, and the domain decides
 * how a session is described from it.
 */
export const AGENT_HOST_SCHEME = 'agent-host-copilotcli:';

/** True when a stored chat reference addresses a Copilot-mode session. */
export function isAgentHostResource(resource: string | undefined): boolean {
	return typeof resource === 'string' && resource.startsWith(AGENT_HOST_SCHEME);
}

/**
 * Accepts either form of a chat reference and returns the resource.
 *
 * Two producers recorded the same conversation two different ways — the notify tool stored
 * the full resource, the transcript watcher stored the bare id — and everything downstream
 * parses a resource. The mismatch made every reveal fail and every "is this chat in front?"
 * comparison miss, because the two forms never compare equal.
 *
 * Normalising at the point of use fixes the sessions already persisted in the broken form,
 * which a fix at the producer alone would leave stranded.
 */
export function asChatSessionResource(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	// Already a resource, of any scheme: left alone, so a CLI chat is not rewritten as a
	// local one. Matched on the scheme rather than on "://" because not every chat resource
	// has an authority -- a Copilot-mode session is `agent-host-copilotcli:/<uuid>`, with a
	// single slash, and encoding that as though it were a bare id would produce a resource
	// addressing nothing. A bare chat id is a UUID and never contains a colon, so this
	// cannot capture one.
	return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : chatSessionResourceFor(value);
}

/**
 * A session key of the form `chat-<uuid>` names the chat that created the session.
 *
 * The transcript watcher mints keys as `chat-${chatSessionId}` when it announces a chat
 * that started the work, so the key itself is an authoritative record of the chat id — no
 * search, no guessing. When the identity on such a session is empty (typical for records
 * that reached this bridge before the identity was written) the key can be read back to
 * recover the resource and route the reply to the chat that actually asked for it.
 *
 * Returns undefined for any key that does not name a chat — including MCP-server keys the
 * user picked, so the mapping cannot misidentify unrelated tasks.
 */
const CHAT_KEY_PREFIX = 'chat-';
const CHAT_KEY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function chatSessionResourceFromKey(key: string | undefined): string | undefined {
	if (!key || !key.startsWith(CHAT_KEY_PREFIX)) {
		return undefined;
	}
	const candidate = key.slice(CHAT_KEY_PREFIX.length);
	if (!CHAT_KEY_UUID.test(candidate)) {
		// Only chat session ids VS Code writes as transcript filenames — the whole reason
		// this recovery is safe — are valid. Anything else is a user-picked key that
		// happens to start with `chat-`, and reading it as a resource would misroute.
		return undefined;
	}
	// Round-tripped through `asChatSessionResource` so the encoder used everywhere else in
	// the codebase produces the exact form the reveal commands and the identity comparison
	// already expect. No hand-rolled base64 here.
	return asChatSessionResource(candidate);
}

/**
 * Reads the chat session id back out of such a resource, for logging.
 *
 * Delivery used to be logged as "the focused chat" without saying which chat that was, so
 * a misrouted reply could only be diagnosed by asking the user where it landed. Naming the
 * chat makes the routing readable from the log alone.
 */
export function chatSessionIdFrom(resource: string): string | undefined {
	if (!resource.startsWith(CHAT_SESSION_SCHEME)) {
		return undefined;
	}
	const encoded = resource.slice(CHAT_SESSION_SCHEME.length);
	if (!encoded) {
		return undefined;
	}
	const decoded = Buffer.from(encoded, 'base64').toString('utf8');
	// Base64 decoding never fails, it just produces rubbish, so the round trip is the check.
	return Buffer.from(decoded, 'utf8').toString('base64') === encoded ? decoded : undefined;
}

/**
 * Collects the session keys and ids this transcript actually called the tool with.
 *
 * Deliberately reads only recorded tool calls rather than searching the text. A reply
 * delivered to the wrong chat quotes its own session key in the request, so that chat's
 * transcript then contains the key too; a plain text search would match it and keep
 * choosing the wrong chat forever. Only the caller writes a tool invocation.
 */
export function sessionKeysCalledIn(transcript: string): Set<string> {
	const found = new Set<string>();
	let at = transcript.indexOf(RAW_INPUT_MARKER);

	while (at !== -1) {
		const object = objectAt(transcript, at + RAW_INPUT_MARKER.length);
		if (object) {
			for (const value of [object.sessionKey, object.sessionId]) {
				if (typeof value === 'string' && value) {
					found.add(value);
				}
			}
		}
		at = transcript.indexOf(RAW_INPUT_MARKER, at + RAW_INPUT_MARKER.length);
	}

	return found;
}

/**
 * Names the chat that started a session, given its transcripts newest first.
 *
 * A session resumed in a second chat legitimately matches more than once, so the newest
 * match wins: that is where the user is working now. Returns nothing when no transcript
 * claims it, which the caller must treat as "unknown" rather than "anywhere".
 */
export function findChatSessionFor(
	needles: readonly string[],
	transcripts: readonly { id: string; text: string }[]
): string | undefined {
	const wanted = needles.filter((needle) => Boolean(needle));
	if (wanted.length === 0) {
		return undefined;
	}

	for (const transcript of transcripts) {
		// Cheap reject first: parsing every tool call in every transcript is wasteful when
		// the key does not appear in the file at all.
		if (!wanted.some((needle) => transcript.text.includes(needle))) {
			continue;
		}
		const called = sessionKeysCalledIn(transcript.text);
		if (wanted.some((needle) => called.has(needle))) {
			return transcript.id;
		}
	}

	return undefined;
}

/**
 * Reads the JSON object starting at or after `from`.
 *
 * Brace counting has to ignore braces inside strings, because a title or summary written
 * by the model may well contain one.
 */
function objectAt(text: string, from: number): Record<string, unknown> | undefined {
	const start = text.indexOf('{', from);
	if (start === -1) {
		return undefined;
	}

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = start; index < text.length; index++) {
		const char = text[index];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === '\\') {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) {
			continue;
		}

		if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, index + 1)) as Record<string, unknown>;
				} catch {
					return undefined; // A partial write; a later pass will see it complete.
				}
			}
		}
	}

	return undefined;
}
