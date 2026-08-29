import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import type * as vscode from 'vscode';
import {
	CLI_SERVER_NAME,
	cliMcpConfigPath,
	resolveCliHome,
	syncCliMcpConfig
} from '../src/hosts/vscode/cliMcpConfig';
import type { BridgeConfig } from '../src/hosts/vscode/config';

/**
 * Copilot CLI sessions cannot see the VS Code MCP provider, so the extension writes the
 * bundled server into `~/.copilot/mcp-config.json`. These tests never touch the real file:
 * a temp directory stands in for `~/.copilot` and the module honours the override.
 */
describe('registering the bundled server for the Copilot CLI', () => {
	let home: string;
	let cfgPath: string;
	const logs: { info: string[]; warn: string[] } = { info: [], warn: [] };
	const log = {
		info: (message: string) => logs.info.push(message),
		warn: (message: string) => logs.warn.push(message)
	};

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-cli-home-'));
		cfgPath = cliMcpConfigPath(home);
		logs.info = [];
		logs.warn = [];
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it('creates the file with the bridge entry when none exists', () => {
		const changed = syncCliMcpConfig({ enabled: true, ...common(home) });

		assert.strictEqual(changed, true);
		const written = readJson(cfgPath);
		assert.ok(written.mcpServers, 'the file has an mcpServers object');
		const entry = written.mcpServers[CLI_SERVER_NAME];
		assert.ok(entry, 'the bridge entry is present');
		assert.ok(entry.env, 'the entry has env');
		assert.ok(entry.args, 'the entry has args');
		assert.strictEqual(entry.command, process.execPath, 'runs under the editor node');
		assert.strictEqual(entry.env.ELECTRON_RUN_AS_NODE, '1');
		assert.strictEqual(entry.env.COPILOT_TEAMS_BRIDGE_TEAM, 'team-x');
		assert.strictEqual(entry.env.COPILOT_TEAMS_BRIDGE_CHANNEL, 'channel-y');
		// The exact shape `copilot mcp add` writes. The CLI drops an entry that fails its
		// validation without a word, so a wrong `tools` form or transport name leaves the
		// bridge invisible to every CLI session while the file looks perfectly correct.
		assert.deepStrictEqual(entry.tools, ['*'], 'tools is an array, not the string "*"');
		assert.strictEqual(entry.type, 'local', 'the CLI names this transport "local", not "stdio"');
		assert.match(entry.args[0], /out[\\/]src[\\/]hosts[\\/]mcp[\\/]stdio\.js$/);
	});

	it('preserves other servers and unknown top-level keys', () => {
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(
			cfgPath,
			JSON.stringify({
				schemaVersion: 42,
				mcpServers: {
					'someone-else': { command: 'x', args: ['y'] }
				}
			}),
			'utf8'
		);

		const changed = syncCliMcpConfig({ enabled: true, ...common(home) });

		assert.strictEqual(changed, true);
		const written = readJson(cfgPath);
		assert.strictEqual(written.schemaVersion, 42, 'unknown top-level keys survive');
		assert.deepStrictEqual(
			written.mcpServers['someone-else'],
			{ command: 'x', args: ['y'] },
			'unrelated servers survive untouched'
		);
		assert.ok(written.mcpServers[CLI_SERVER_NAME], 'and the bridge entry is added');
	});

	it('replaces a corrupt file rather than aborting', () => {
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(cfgPath, '{ this is not valid json', 'utf8');

		const changed = syncCliMcpConfig({ enabled: true, ...common(home) });

		assert.strictEqual(changed, true);
		const written = readJson(cfgPath);
		assert.ok(written.mcpServers[CLI_SERVER_NAME], 'the bridge entry is written');
		assert.strictEqual(logs.warn.length, 0, 'a corrupt file is handled quietly, not warned');
	});

	it('does not rewrite when the entry is already correct', () => {
		syncCliMcpConfig({ enabled: true, ...common(home) });
		const firstMtime = fs.statSync(cfgPath).mtimeMs;

		// A second call with the same inputs must be a no-op — activation runs on every
		// window open, so a change every start would churn the file endlessly.
		const changed = syncCliMcpConfig({ enabled: true, ...common(home) });

		assert.strictEqual(changed, false, 'reports no change');
		assert.strictEqual(fs.statSync(cfgPath).mtimeMs, firstMtime, 'the file is not touched');
	});

	it('removes only the bridge entry when disabled', () => {
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(
			cfgPath,
			JSON.stringify({
				mcpServers: {
					'someone-else': { command: 'x' },
					[CLI_SERVER_NAME]: { command: 'old' }
				},
				extra: true
			}),
			'utf8'
		);

		const changed = syncCliMcpConfig({ enabled: false, ...common(home) });

		assert.strictEqual(changed, true);
		const written = readJson(cfgPath);
		assert.strictEqual(
			written.mcpServers[CLI_SERVER_NAME],
			undefined,
			'the bridge entry is gone'
		);
		assert.deepStrictEqual(
			written.mcpServers['someone-else'],
			{ command: 'x' },
			'the unrelated server survives'
		);
		assert.strictEqual(written.extra, true, 'unknown keys survive');
	});

	it('honours the explicit home override so tests never touch the real ~/.copilot', () => {
		const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-cli-alt-'));
		try {
			syncCliMcpConfig({ enabled: true, ...common(home), homeOverride: explicit });
			assert.ok(fs.existsSync(cliMcpConfigPath(explicit)), 'wrote to the override');
			assert.ok(!fs.existsSync(cfgPath), 'did not write to the default home');
		} finally {
			fs.rmSync(explicit, { recursive: true, force: true });
		}
	});

	it('resolves the CLI home from env vars in preference order', () => {
		const before = { cli: process.env.COPILOT_CLI_HOME, generic: process.env.COPILOT_HOME };
		try {
			process.env.COPILOT_CLI_HOME = '/tmp/cli-wins';
			process.env.COPILOT_HOME = '/tmp/generic';
			assert.strictEqual(resolveCliHome(), '/tmp/cli-wins');

			delete process.env.COPILOT_CLI_HOME;
			assert.strictEqual(resolveCliHome(), '/tmp/generic');

			delete process.env.COPILOT_HOME;
			assert.strictEqual(resolveCliHome(), path.join(os.homedir(), '.copilot'));
		} finally {
			restoreEnv('COPILOT_CLI_HOME', before.cli);
			restoreEnv('COPILOT_HOME', before.generic);
		}
	});

	// A window with no team or channel configured — a fresh profile, a remote host, or the
	// isolated VS Code the host tests launch — must never overwrite a working registration.
	// An entry without them does not fail loudly: the server falls back to the local file
	// transport, so every CLI agent posts into a file and reports success. That is exactly
	// how this was found, and it silently broke real CLI sessions.
	it('leaves a working entry alone when this window has no team or channel', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-cli-guard-'));
		try {
			// A registration written by a properly configured window.
			syncCliMcpConfig({ ...common(home), enabled: true });
			const working = readJson(cliMcpConfigPath(home));
			assert.strictEqual(working.mcpServers[CLI_SERVER_NAME].env?.COPILOT_TEAMS_BRIDGE_TEAM, 'team-x');

			// The same extension activating somewhere nothing is configured.
			const blind = { ...common(home), enabled: true };
			blind.config = { ...fakeConfig(), teamId: '', channelId: '' };
			const changed = syncCliMcpConfig(blind);

			assert.strictEqual(changed, false, 'nothing may be written when there is nothing useful to write');
			assert.deepStrictEqual(
				readJson(cliMcpConfigPath(home)),
				working,
				'the working registration must survive untouched'
			);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	// Whitespace is not configuration. Trimming matters because a stray space would
	// otherwise pass the guard and write an entry that cannot reach Teams.
	it('treats whitespace-only team or channel as unconfigured', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-cli-guard-blank-'));
		try {
			const blank = { ...common(home), enabled: true };
			blank.config = { ...fakeConfig(), teamId: '   ', channelId: '\t' };

			assert.strictEqual(syncCliMcpConfig(blank), false);
			assert.strictEqual(fs.existsSync(cliMcpConfigPath(home)), false, 'no file is created either');
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	// Removal is a deliberate user action, not an accident of an unconfigured window, so
	// the guard must not block it — otherwise turning the setting off would do nothing.
	it('still removes the entry when disabled, even with no team or channel', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-cli-guard-remove-'));
		try {
			syncCliMcpConfig({ ...common(home), enabled: true });
			const off = { ...common(home), enabled: false };
			off.config = { ...fakeConfig(), teamId: '', channelId: '' };

			assert.strictEqual(syncCliMcpConfig(off), true);
			assert.strictEqual(readJson(cliMcpConfigPath(home)).mcpServers[CLI_SERVER_NAME], undefined);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	function common(homeDir: string): { extensionUri: vscode.Uri; config: BridgeConfig; log: typeof log; homeOverride: string } {
		return {
			extensionUri: { fsPath: '/ext' } as unknown as vscode.Uri,
			config: fakeConfig(),
			log,
			homeOverride: homeDir
		};
	}
});

interface McpConfigShape {
	mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; tools?: string[]; type?: string }>;
	[key: string]: unknown;
}

function readJson(file: string): McpConfigShape {
	const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<McpConfigShape>;
	return { ...parsed, mcpServers: parsed.mcpServers ?? {} } as McpConfigShape;
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

function fakeConfig(): BridgeConfig {
	return {
		transport: 'agency',
		agencyCommand: 'agency',
		teamId: 'team-x',
		channelId: 'channel-y',
		fileDirectory: '',
		pollIntervalMs: 10_000,
		waitForReplyTimeoutMs: 7_200_000,
		autoSubmitReplies: true,
		replyDelivery: 'guarded',
		unroutableReplies: 'hold',
		replyTargeting: 'editorGroup',
		deliveryConfirmMs: 30_000,
		announceSessions: true,
		announceMinPromptLength: 30,
		turnUpdates: 'everyTurn',
		turnSummaryChars: 600,
		acknowledgeReplies: true,
		relayAgentReplies: true,
		expiredGraceMs: 0,
		autoStart: true,
		sessionIdleMs: 7_200_000,
		mentionPolicy: 'keyMoments',
	resumeCliSessions: false,
	cliResumeTimeoutMs: 900_000
	};
}
