import * as path from 'path';
import * as vscode from 'vscode';
import type { BridgeConfig } from './config';
import type { HarnessKind } from '../../domain/types';

/**
 * The one place the bundled MCP server's launch command is described.
 *
 * Two callers spawn this server: {@link BridgeMcpProvider} publishes it into VS Code,
 * and the CLI config writer registers it with the Copilot CLI. Anything different between
 * the two would mean one host ran a different build of the server than the other — a
 * class of bug that never surfaces until a version bump ships fixes to only half the
 * hosts. Building the command/args/env from one function keeps that impossible.
 */
export interface McpLaunchSpec {
	command: string;
	args: string[];
	env: Record<string, string>;
}

/**
 * Which caller is spawning the server. Emitted as `COPILOT_TEAMS_BRIDGE_HARNESS` so the
 * server records it at session creation, rather than the two callers being indistinguishable
 * at the wire — which is what made the reply-invitation footer wrong for one of them.
 */
export type McpLauncher = Extract<HarnessKind, 'vscode-agent-mcp' | 'cli-runtime'>;

/**
 * Builds the exact command, args and environment used to launch the bundled MCP server.
 *
 * The editor binary is reused as the Node runtime (with ELECTRON_RUN_AS_NODE=1) so the
 * bridge does not depend on the user having a separate Node install. Team, channel and
 * poll cadence come from settings the user has already configured.
 *
 * `harness` names the launching surface. It travels as an env var rather than a launch
 * argument because Copilot CLI's config schema does not preserve arbitrary flags but
 * always propagates the `env` map verbatim, so this is the one channel both spawn paths
 * can carry it through unchanged.
 */
export function buildMcpLaunchSpec(extensionUri: vscode.Uri, config: BridgeConfig, harness: McpLauncher): McpLaunchSpec {
	const entry = path.join(extensionUri.fsPath, 'out', 'src', 'hosts', 'mcp', 'stdio.js');
	return {
		command: process.execPath,
		args: [entry],
		env: {
			ELECTRON_RUN_AS_NODE: '1',
			COPILOT_TEAMS_BRIDGE_TEAM: config.teamId,
			COPILOT_TEAMS_BRIDGE_CHANNEL: config.channelId,
			COPILOT_TEAMS_BRIDGE_AGENCY: config.agencyCommand,
			COPILOT_TEAMS_BRIDGE_POLL_SECONDS: String(Math.round(config.pollIntervalMs / 1000)),
			// The MCP server is a separate process that builds its own transport, so the
			// mention policy has to travel through the environment or agent/CLI sessions
			// would keep tagging on every message even after the user changed the setting.
			COPILOT_TEAMS_BRIDGE_MENTION: config.mentionPolicy,
			COPILOT_TEAMS_BRIDGE_HARNESS: harness
		}
	};
}
