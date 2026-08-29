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
