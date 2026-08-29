import type { HarnessKind } from '../../domain/types';

/**
 * Reads the harness kind from an env-var value, falling back to "unknown".
 *
 * Two callers spawn the stdio server, and until this env var arrived they were
 * indistinguishable at the wire: a session started by a VS Code-hosted agent and one
 * started by a standalone Copilot CLI both landed with no identity, which meant the reply
 * footer could not be right for both — either denying a resolvable session or inviting a
 * reply that could never reach a chat.
 *
 * The launcher knows which one it is, so the mapping is emitted at spawn. Lives in its
 * own file, mirroring {@link mentionPolicyFromEnv}, so a test can exercise the mapping
 * without spawning the server (stdio's `main()` runs on import). Unset and unrecognised
 * both map to `unknown` — the safe direction to be wrong in, matching the pre-existing
 * behaviour when nothing was stamped at all.
 */
export function harnessFromEnv(value: string | undefined): HarnessKind {
	if (value === 'vscode-agent-mcp' || value === 'cli-runtime' || value === 'external' || value === 'vscode-sidebar') {
		return value;
	}
	return 'unknown';
}

/**
 * Reads the `copilot` CLI's own session id from an env-var value.
 *
 * The CLI sets `COPILOT_AGENT_SESSION_ID` in its process environment, and any MCP server it
 * spawns inherits it. That makes the id a fact handed to us at spawn, in the same spirit as
 * {@link harnessFromEnv} -- not something correlated afterwards from a working directory and
 * a timestamp, which is the kind of guess that puts one task's instruction into another
 * task's conversation.
 *
 * Only a well-formed UUID is accepted. The value is later passed to `copilot --session-id`,
 * so anything else is refused here rather than handed to a spawn: an id is either the shape
 * the CLI issues or it is not trusted at all.
 */
export function cliSessionIdFromEnv(value: string | undefined): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ? trimmed : undefined;
}
