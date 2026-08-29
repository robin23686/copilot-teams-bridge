/**
 * Detects a hand-written `mcp.json` entry that launches this same server.
 *
 * Once the extension registers the server itself, an old manual entry becomes actively
 * harmful rather than merely redundant: two processes poll the same Teams channel and
 * share one `sessions.json`, so they race the "already seen" watermark. A reply read by
 * the copy the agent is not talking to is marked as seen and never delivered — the
 * message is lost, not duplicated.
 */

/** Strips // and /* comments so VS Code's JSONC config can be parsed. */
export function stripJsonComments(text: string): string {
	let result = '';
	let inString = false;
	let inLine = false;
	let inBlock = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		const next = text[i + 1];

		if (inLine) {
			if (char === '\n') {
				inLine = false;
				result += char;
			}
			continue;
		}
		if (inBlock) {
			if (char === '*' && next === '/') {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			result += char;
			if (char === '\\') {
				result += next ?? '';
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}
		if (char === '/' && next === '/') {
			inLine = true;
			i++;
			continue;
		}
		if (char === '/' && next === '*') {
			inBlock = true;
			i++;
			continue;
		}
		result += char;
	}
	return result;
}

/**
 * Returns the names of `mcp.json` servers that launch this bridge's stdio entry point.
 *
 * Matching on the entry file rather than the server's name catches the entry whatever the
 * user called it, and whichever folder they pointed it at.
 */
export function findBridgeServerNames(mcpJsonText: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(mcpJsonText));
	} catch {
		// A malformed or empty file is the user's own business; never guess at its contents.
		return [];
	}

	const servers = (parsed as { servers?: Record<string, unknown> } | null)?.servers;
	if (!servers || typeof servers !== 'object') {
		return [];
	}

	return Object.entries(servers)
		.filter(([, value]) => launchesBridge(value))
		.map(([name]) => name);
}

function launchesBridge(server: unknown): boolean {
	const entry = server as { command?: unknown; args?: unknown } | null;
	if (!entry) {
		return false;
	}
	const parts = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
	return parts.some((part) => typeof part === 'string' && /mcp[\\/]stdio\.js$/i.test(part));
}
