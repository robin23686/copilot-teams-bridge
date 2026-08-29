/**
 * Reads the sessions VS Code shows for the Copilot CLI agent host ("Copilot mode").
 *
 * These are chat tabs like `agent-host-copilotcli:/<uuid>`, and they are invisible to every
 * other route the bridge has:
 *
 * - they write **no** `chatSessions/*.jsonl` transcript, so the transcript resolver cannot
 *   find them and delivery cannot be confirmed the usual way;
 * - the CLI's own `session-store.db` holds only a stub row with zero turns, so resuming it
 *   with `copilot --session-id` would neither restore the conversation nor show anything in
 *   the tab the user is watching;
 * - VS Code proxies MCP tool calls to the agent host over a named pipe, and the `env` block
 *   from `~/.copilot/mcp-config.json` does not survive that hop -- which is why a session
 *   opened this way arrives with no harness stamped and no chat recorded.
 *
 * What does exist is VS Code's own index of chat sessions, in the workspace `state.vscdb`
 * under `agentSessions.model.cache`. It names the resource, the label, the working
 * directory and the request timings, which is enough both to identify the conversation and
 * to prove afterwards that a turn ran in it.
 *
 * Read-only, and defensively: this is another component's private storage, so every failure
 * degrades to "no sessions" rather than throwing. Losing this signal means a reply is held,
 * which is the outcome that already applies today.
 */

export interface AgentHostSession {
	/** The chat session resource, e.g. `agent-host-copilotcli:/<uuid>`. */
	resource: string;
	/** The title shown on the tab. */
	label: string;
	/** Absolute path of the folder the session is working in, when recorded. */
	workingDirectoryPath?: string;
	/** Epoch ms the session was created. */
	created?: number;
	/** Epoch ms the most recent request began. Advances when a turn runs. */
	lastRequestStarted?: number;
	/** Epoch ms the most recent request finished. */
	lastRequestEnded?: number;
	archived?: boolean;
}

/** Provider id VS Code uses for Copilot-mode sessions. */
export const AGENT_HOST_PROVIDER = 'agent-host-copilotcli';

import { AGENT_HOST_SCHEME, isAgentHostResource } from '../../domain/chatSessionLink';

export { AGENT_HOST_SCHEME, isAgentHostResource };

interface RawEntry {
	providerType?: unknown;
	resource?: unknown;
	label?: unknown;
	archived?: unknown;
	timing?: { created?: unknown; lastRequestStarted?: unknown; lastRequestEnded?: unknown };
	metadata?: { workingDirectoryPath?: unknown };
}

/**
 * Parses the `agentSessions.model.cache` payload into agent-host sessions.
 *
 * Separated from the database read so the shape can be tested against a captured fixture
 * without a live VS Code profile. The cache is another component's data structure and may
 * change between releases, so anything unrecognised is skipped rather than trusted.
 */
export function parseAgentHostSessions(raw: string): AgentHostSession[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	const entries = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as { entries?: unknown })?.entries)
			? ((parsed as { entries: unknown[] }).entries)
			: [];

	const sessions: AgentHostSession[] = [];
	for (const entry of entries as RawEntry[]) {
		if (!entry || entry.providerType !== AGENT_HOST_PROVIDER) {
			continue;
		}
		const resource = typeof entry.resource === 'string' ? entry.resource : undefined;
		if (!resource || !resource.startsWith(AGENT_HOST_SCHEME)) {
			// Without a resource there is nothing to steer to, and a resource of another
			// shape is not ours to interpret.
			continue;
		}
		sessions.push({
			resource,
			label: typeof entry.label === 'string' ? entry.label : resource,
			workingDirectoryPath:
				typeof entry.metadata?.workingDirectoryPath === 'string' ? entry.metadata.workingDirectoryPath : undefined,
			created: numberOr(entry.timing?.created),
			lastRequestStarted: numberOr(entry.timing?.lastRequestStarted),
			lastRequestEnded: numberOr(entry.timing?.lastRequestEnded),
			archived: entry.archived === true
		});
	}
	return sessions;
}

function numberOr(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
