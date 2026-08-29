import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { BridgeConfig } from './config';
import { buildMcpLaunchSpec, type McpLaunchSpec } from './mcpServerDefinition';

/**
 * Registers the bundled MCP server with the Copilot CLI.
 *
 * VS Code learns about the server through {@link BridgeMcpProvider}, but a standalone
 * Copilot CLI session (outside VS Code, or the CLI hosted by a separate agent runtime)
 * cannot see that provider — it only reads `~/.copilot/mcp-config.json`. Without an entry
 * there the CLI has been told, by the instructions file we install alongside, to call a
 * tool that does not exist. Writing the same launch spec into that config file gives the
 * CLI the tool the instructions promised, from the same build that VS Code is running.
 *
 * The file is treated as user-owned: unrelated servers and unknown top-level keys are
 * preserved, a missing or corrupt file is tolerated (treated as empty), and a rewrite
 * only happens when the resulting entry actually differs — so activation does not churn
 * the file on every start.
 */

/** Matches the tool prefix observed in the wild (`copilot-teams-bridge-teams_notify`). */
export const CLI_SERVER_NAME = 'copilot-teams-bridge';

export interface CliMcpConfigDeps {
	extensionUri: vscode.Uri;
	config: BridgeConfig;
	/** True when the user wants the CLI entry present; false removes it. */
	enabled: boolean;
	log: { info: (message: string) => void; warn: (message: string) => void };
	/** Test seam. Real callers omit this and get the real `~/.copilot`. */
	homeOverride?: string;
}

/**
 * Resolves the CLI home directory, honouring an override so tests never touch the real
 * `~/.copilot`. `COPILOT_CLI_HOME` wins over `COPILOT_HOME`, which wins over `os.homedir()`.
 */
export function resolveCliHome(explicit?: string): string {
	const override = explicit ?? process.env.COPILOT_CLI_HOME ?? process.env.COPILOT_HOME;
	if (override && override.trim()) {
		return override;
	}
	return path.join(os.homedir(), '.copilot');
}

/** File the Copilot CLI reads its MCP server registrations from. */
export function cliMcpConfigPath(home: string): string {
	return path.join(home, 'mcp-config.json');
}

/**
 * Writes or removes the bridge's entry in `~/.copilot/mcp-config.json`.
 *
 * Returns `true` when the file was modified, `false` when it was already up to date.
 * Any I/O or parse failure is logged and swallowed: a CLI without the bridge tool is a
 * degraded experience, but a failed activation would be a worse one.
 */
export function syncCliMcpConfig(deps: CliMcpConfigDeps): boolean {
	const home = resolveCliHome(deps.homeOverride);
	const file = cliMcpConfigPath(home);

	// An entry without a team and channel cannot reach Teams: the server falls back to the
	// local file transport and an agent then posts into a file nobody reads, believing it
	// succeeded. Writing one over a working entry is therefore strictly destructive, and
	// it happens whenever the extension activates somewhere the settings are not
	// configured — a fresh profile, a remote window, or the isolated VS Code instance the
	// host tests launch. Leaving the existing entry untouched is the only safe answer;
	// there is nothing useful to write and something valuable to lose.
	if (deps.enabled && !isReachable(deps.config)) {
		deps.log.warn(
			`Leaving the Copilot CLI MCP config at ${file} alone: no team and channel are configured ` +
				`in this window, and an entry without them would post into a local file instead of Teams.`
		);
		return false;
	}

	const spec = buildMcpLaunchSpec(deps.extensionUri, deps.config, 'cli-runtime');
	const desired = deps.enabled ? entryFor(spec) : undefined;

	try {
		const existing = readConfig(file);
		const next = mergeConfig(existing.parsed, desired);
		if (deepEqual(existing.parsed, next)) {
			return false;
		}
		writeAtomic(file, next);
		deps.log.info(
			deps.enabled
				? `${existing.wasMissing ? 'Wrote' : 'Updated'} Copilot CLI MCP config at ${file}`
				: `Removed the "${CLI_SERVER_NAME}" entry from ${file}`
		);
		return true;
	} catch (error) {
		deps.log.warn(
			`Could not update Copilot CLI MCP config at ${file}: ${error instanceof Error ? error.message : String(error)}`
		);
		return false;
	}
}

/**
 * Whether this configuration can actually reach Teams.
 *
 * The MCP server treats a missing team or channel as "use the local file transport", which
 * is a reasonable default for a developer trying the bridge out and a silent failure for
 * everyone else: messages go to a file, the agent is told it posted, and the user sees
 * nothing. Registering such an entry is worse than registering none.
 */
function isReachable(config: BridgeConfig): boolean {
	return Boolean(config.teamId.trim() && config.channelId.trim());
}

interface CliServerEntry {
	command: string;
	args: string[];
	env: Record<string, string>;
	tools: string[];
	type: string;
}

/**
 * The entry shape Copilot CLI actually accepts.
 *
 * Taken from what `copilot mcp add` writes for itself, not from the MCP spec: an entry
 * that fails the CLI's validation is dropped in silence, so `copilot mcp list` reported
 * "No MCP servers configured" while a perfectly reasonable-looking entry sat in the file.
 * Two fields differ from the obvious guess — `tools` is an array rather than the string
 * `"*"`, and the transport is named `local` rather than `stdio`.
 */
function entryFor(spec: McpLaunchSpec): CliServerEntry {
	return {
		command: spec.command,
		args: [...spec.args],
		env: { ...spec.env },
		tools: ['*'],
		type: 'local'
	};
}

interface ReadResult {
	parsed: Record<string, unknown>;
	wasMissing: boolean;
}

function readConfig(file: string): ReadResult {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { parsed: {}, wasMissing: true };
		}
		throw error;
	}

	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { parsed: parsed as Record<string, unknown>, wasMissing: false };
		}
	} catch {
		// Fall through: a corrupt file is treated as empty, so the bridge entry can be
		// written without silently discarding servers we cannot re-derive.
	}
	return { parsed: {}, wasMissing: false };
}

/**
 * Merges the bridge entry into an existing config while preserving everything else.
 *
 * `desired === undefined` removes only the bridge entry; other servers stay untouched.
 * Unknown top-level keys are carried through verbatim because the CLI config schema is
 * not the extension's to gatekeep.
 */
function mergeConfig(
	existing: Record<string, unknown>,
	desired: CliServerEntry | undefined
): Record<string, unknown> {
	const rawServers = existing.mcpServers;
	const servers: Record<string, unknown> =
		rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
			? { ...(rawServers as Record<string, unknown>) }
			: {};

	if (desired) {
		servers[CLI_SERVER_NAME] = desired;
	} else {
		delete servers[CLI_SERVER_NAME];
	}

	return { ...existing, mcpServers: servers };
}

function writeAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, file);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false;
		}
		return a.every((value, index) => deepEqual(value, b[index]));
	}
	const aKeys = Object.keys(a as Record<string, unknown>).sort();
	const bKeys = Object.keys(b as Record<string, unknown>).sort();
	if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) {
		return false;
	}
	return aKeys.every((key) =>
		deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
	);
}
