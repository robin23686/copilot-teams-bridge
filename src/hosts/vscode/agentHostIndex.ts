import * as path from 'path';
import type * as vscode from 'vscode';
import {
	parseAgentHostSessions,
	type AgentHostSession
} from './agentHostSessions';

/** Reads a value from VS Code's workspace key-value store. Injected so it can be faked. */
export type StateReader = (key: string) => string | undefined;

/**
 * Reads VS Code's own chat-session index out of the workspace `state.vscdb`.
 *
 * `node:sqlite` ships with the Node that VS Code runs (24.x), so this needs no dependency
 * and no native build. The database is opened **read-only**: it belongs to VS Code, which
 * has it open at the same time, and the bridge has no business writing to it.
 *
 * Returns undefined rather than throwing on any failure -- a missing module on an older
 * runtime, a locked file, a schema that has moved. The caller then holds the reply, which
 * is exactly what happens today without this signal.
 */
export function readWorkspaceState(stateDbPath: string, key: string): string | undefined {
	try {
		/* eslint-disable @typescript-eslint/no-require-imports */
		const { DatabaseSync } = require('node:sqlite') as {
			DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
				prepare(sql: string): { get(...args: unknown[]): { value?: unknown } | undefined };
				close(): void;
			};
		};
		/* eslint-enable @typescript-eslint/no-require-imports */
		const db = new DatabaseSync(stateDbPath, { readOnly: true });
		try {
			const row = db.prepare('select value from ItemTable where key = ?').get(key);
			const value = row?.value;
			if (value === undefined || value === null) {
				return undefined;
			}
			return typeof value === 'string' ? value : Buffer.from(value as Uint8Array).toString('utf8');
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

/** Where VS Code keeps the index, relative to the workspace storage folder. */
export function workspaceStateDbPath(chatSessionsUri: vscode.Uri): string {
	// chatSessions lives beside state.vscdb inside the workspace storage folder.
	return path.join(path.dirname(chatSessionsUri.fsPath), 'state.vscdb');
}

export const AGENT_SESSIONS_CACHE_KEY = 'agentSessions.model.cache';

export interface AgentHostIndexDeps {
	stateDbPath: string;
	log: vscode.LogOutputChannel;
	/** Overridable for tests; defaults to the sqlite read above. */
	read?: StateReader;
}

/** Lists the Copilot-mode sessions VS Code currently knows about. */
export function listAgentHostSessions(deps: AgentHostIndexDeps): AgentHostSession[] {
	const read = deps.read ?? ((key: string) => readWorkspaceState(deps.stateDbPath, key));
	const raw = read(AGENT_SESSIONS_CACHE_KEY);
	if (!raw) {
		return [];
	}
	return parseAgentHostSessions(raw);
}

/** A bridge session reduced to the facts used for matching. */
export interface SessionFingerprint {
	/** ISO timestamp of the notify that opened or last touched the thread. */
	notifiedAt?: string;
	/** ISO timestamp the bridge session was created. */
	createdAt?: string;
	/** Folder the session reported working in, when known. */
	workspacePath?: string;
}

/**
 * How far either side of a notify an agent-host request may start and still be considered
 * the same turn.
 *
 * A tool call happens *during* a request, so the request that made it began before the
 * notify and ends after it. The window is generous on the "before" side because a long turn
 * may have been running for a while, and tight afterwards because a request that starts
 * well after the notify is a different turn.
 */
const MATCH_BEFORE_MS = 30 * 60 * 1000;
const MATCH_AFTER_MS = 2 * 60 * 1000;

/**
 * Finds the Copilot-mode session that made a bridge notification, or nothing.
 *
 * Identity for this surface cannot be stamped at source: VS Code proxies MCP calls to the
 * agent host and the launch environment does not survive the hop, so the server genuinely
 * cannot know which conversation it is serving. It therefore has to be inferred here --
 * which makes *refusing to guess* the whole point of this function.
 *
 * A candidate must be in the same working directory and have been mid-request around the
 * notify. If two candidates fit, that is not a near-miss to be broken by picking the
 * closest: it is exactly the case where a wrong choice puts one task's instruction into
 * another task's conversation, so nothing is returned and the reply stays held. Holding is
 * visible and recoverable; a misdelivery is neither.
 */
export function matchAgentHostSession(
	sessions: readonly AgentHostSession[],
	fingerprint: SessionFingerprint
): AgentHostSession | undefined {
	const anchor = timestamp(fingerprint.notifiedAt) ?? timestamp(fingerprint.createdAt);
	if (anchor === undefined) {
		return undefined;
	}

	const candidates = sessions.filter((session) => {
		if (session.archived) {
			return false;
		}
		if (!sameFolder(session.workingDirectoryPath, fingerprint.workspacePath)) {
			return false;
		}
		const started = session.lastRequestStarted;
		if (started === undefined) {
			return false;
		}
		// The request that called the tool must have been under way at the notify: started
		// no later than just after it, and not so long before that it is plainly a different
		// turn. `lastRequestEnded` is not required to be after the notify because the turn
		// may well have finished by the time this runs.
		return started <= anchor + MATCH_AFTER_MS && started >= anchor - MATCH_BEFORE_MS;
	});

	return candidates.length === 1 ? candidates[0] : undefined;
}

function timestamp(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Compares two folder paths for the purpose of matching.
 *
 * A session that records no folder is not excluded: the field is optional in VS Code's
 * index, and requiring it would refuse a match that the time window alone already makes
 * unambiguous. Comparison is case-insensitive with separators normalised, because the two
 * sides come from different components and Windows disagrees with itself about both.
 */
function sameFolder(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) {
		return true;
	}
	const normalise = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	return normalise(a) === normalise(b);
}

export interface ConfirmAgentHostOptions {
	/** Reads the current index. Called repeatedly, so it must be cheap and non-throwing. */
	sessions(): AgentHostSession[];
	/** The resource a request was just written to. */
	resource: string;
	/** Epoch ms recorded immediately before the write. */
	writtenAt: number;
	/** Upper bound before the confirmation gives up. */
	ceilingMs: number;
	pollMs?: number;
	now?(): number;
	sleep?(ms: number): Promise<void>;
}

/**
 * Confirms a request reached a Copilot-mode chat by watching that session start a turn.
 *
 * A Copilot-mode chat writes no transcript, so the marker-in-the-file proof used everywhere
 * else is simply unavailable here. What VS Code does record is `timing.lastRequestStarted`
 * for each session, and that advances only when *that* session begins a request. Seeing it
 * move past the instant of the write is therefore evidence about the intended conversation
 * specifically, not about the editor in general -- which is the distinction that matters,
 * because "a chat is in front" has already proved worthless as a delivery proof.
 *
 * Weaker than the transcript check in one respect, and worth being explicit about it: it
 * shows a turn started, not that the turn carries our text. A user typing into the same
 * chat at the same moment would also satisfy it. That is accepted because the alternative
 * is no confirmation at all for this surface, and because the write is already targeted at
 * a resolved resource rather than at whatever is focused.
 *
 * Polls at a second rather than the transcript's 250 ms: each read opens the state database,
 * which is far more expensive than reading one file, and a turn beginning is not a
 * sub-second event.
 */
export async function confirmAgentHostTurn(options: ConfirmAgentHostOptions): Promise<boolean> {
	const now = options.now ?? ((): number => Date.now());
	const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
	const pollMs = options.pollMs ?? 1_000;
	const deadline = now() + options.ceilingMs;

	for (;;) {
		const session = options.sessions().find((entry) => entry.resource === options.resource);
		const started = session?.lastRequestStarted;
		if (started !== undefined && started >= options.writtenAt) {
			return true;
		}
		if (now() >= deadline) {
			return false;
		}
		await sleep(pollMs);
	}
}
