#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bridge } from '../../application/bridge';
import { AgencyTeamsTransport } from '../../infrastructure/transports/agencyTeamsTransport';
import { FileTransport } from '../../infrastructure/transports/fileTransport';
import { JsonThreadRegistry } from '../../infrastructure/threadRegistry';
import { mergeForWrite } from '../../domain/policies/sessionMerge';
import { mentionPolicyFromEnv } from './mentionPolicy';
import { harnessFromEnv } from './harnessEnv';
import { delegatedFromEnv, startBridgeUnlessDelegated } from './delegatedMode';
import type { SessionStore, ThreadedTransport } from '../../application/ports';
import type { Session } from '../../domain/types';
import { McpServer } from './server';

/**
 * stdio entry point for the MCP server.
 *
 * Configuration comes from environment variables so the server can be registered in any
 * MCP client's config file without command line parsing. stdout is reserved for protocol
 * messages, so all logging goes to stderr.
 */

const HOME = process.env.COPILOT_TEAMS_BRIDGE_HOME ?? path.join(os.homedir(), '.copilot-teams-bridge');

class JsonSessionStore implements SessionStore {
	constructor(private readonly file: string) {}

	read(): Session[] {
		try {
			return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Session[];
		} catch {
			return [];
		}
	}

	write(sessions: Session[]): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		// The extension writes this file too, and empties the queue this process fills.
		// Writing an in-memory copy straight back would restore what it just delivered.
		const merged = mergeForWrite(sessions, this.read());
		fs.writeFileSync(this.file, JSON.stringify(merged, null, 2), 'utf8');
	}
}

function log(message: string): void {
	// stdout carries protocol frames only.
	process.stderr.write(`[copilot-teams-bridge] ${message}\n`);
}

/**
 * Reads the mention policy from the environment, falling back to the safe default.
 *
 * The stdio entry point runs `main()` on import, so the actual mapping lives in
 * {@link mentionPolicyFromEnv} where a test can exercise it without spawning the server.
 */
function buildTransport(): ThreadedTransport {
	const teamId = process.env.COPILOT_TEAMS_BRIDGE_TEAM ?? '';
	const channelId = process.env.COPILOT_TEAMS_BRIDGE_CHANNEL ?? '';

	if (!teamId || !channelId) {
		log('COPILOT_TEAMS_BRIDGE_TEAM/CHANNEL are not set; using the local file transport.');
		return new FileTransport({ directory: process.env.COPILOT_TEAMS_BRIDGE_INBOX ?? path.join(HOME, 'inbox') });
	}

	return new AgencyTeamsTransport({
		teamId,
		channelId,
		command: process.env.COPILOT_TEAMS_BRIDGE_AGENCY ?? 'agency',
		mentionPolicy: mentionPolicyFromEnv(process.env.COPILOT_TEAMS_BRIDGE_MENTION),
		logger: { info: log, warn: log, error: log }
	});
}

function main(): void {
	const delegated = delegatedFromEnv(process.env.COPILOT_TEAMS_BRIDGE_DELEGATED);
	const transport = buildTransport();
	const bridge = new Bridge({
		transport,
		store: new JsonSessionStore(path.join(HOME, 'sessions.json')),
		// Shared with the extension, so a key it already opened a thread for is reused
		// rather than given a second thread by this process.
		threadRegistry: new JsonThreadRegistry(path.join(HOME, 'threads.json')),
		pollIntervalMs: Number(process.env.COPILOT_TEAMS_BRIDGE_POLL_SECONDS ?? 10) * 1000,
		workspace: process.env.COPILOT_TEAMS_BRIDGE_WORKSPACE ?? path.basename(process.cwd()),
		logger: { info: log, warn: log, error: log }
	});

	// Poll from boot rather than waiting for a blocking call to start it.
	//
	// Only wait() ever started the loop, so once blocking stopped being the default the
	// server read the channel only while an agent happened to be asking. A reply sent after
	// an agent finished its turn was therefore never read at all: not delayed, never seen.
	// Polling continuously means it is collected and waiting the moment anything checks.
	//
	// A delegated server has no thread of its own to watch — it must not reach Teams at all
	// — so polling is skipped: a short-lived agent process does no Teams I/O whatsoever.
	if (delegated) {
		log('Delegated mode: Teams tools are hidden and no polling will run.');
	}
	startBridgeUnlessDelegated(bridge, delegated);

	const server = new McpServer({
		bridge,
		// Left unset unless configured, so the server's own host-safe default applies.
		waitTimeoutMs: process.env.COPILOT_TEAMS_BRIDGE_WAIT_SECONDS ? Number(process.env.COPILOT_TEAMS_BRIDGE_WAIT_SECONDS) * 1000 : undefined,
		// The launcher tells us which surface it is; unset falls through to "unknown", which
		// preserves the pre-existing behaviour of not stamping anything.
		harness: harnessFromEnv(process.env.COPILOT_TEAMS_BRIDGE_HARNESS),
		// Optional single-session binding. When set, every tool call in this process is
		// scoped to that one session — a shared server cannot leak state between agents.
		// The launcher does not have a per-session key to give at spawn time yet, but the
		// mechanism is in place so binding is available and provable.
		boundSessionKey: process.env.COPILOT_TEAMS_BRIDGE_SESSION_KEY?.trim() || undefined,
		delegated,
		write: (line) => process.stdout.write(line),
		log
	});

	const shutdown = (code: number): void => {
		bridge.dispose();
		transport.dispose?.();
		process.exit(code);
	};

	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk: string) => server.push(chunk));
	process.stdin.on('end', () => shutdown(0));
	process.on('SIGINT', () => shutdown(0));
	process.on('SIGTERM', () => shutdown(0));

	log('MCP server ready on stdio');
}

main();
