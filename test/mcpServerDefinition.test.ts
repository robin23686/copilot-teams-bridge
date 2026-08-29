import * as assert from 'assert';
import { describe, it } from 'node:test';
import type * as vscode from 'vscode';
import { buildMcpLaunchSpec } from '../src/hosts/vscode/mcpServerDefinition';
import type { BridgeConfig } from '../src/hosts/vscode/config';

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
		mentionPolicy: 'keyMoments'
	};
}

/**
 * The VS Code MCP provider and the CLI config writer are the only two callers of
 * {@link buildMcpLaunchSpec}. If the two specs drift in anything other than which harness
 * launched them, one host would run a different build of the server than the other — and
 * a version bump would ship fixes to only half the users. Locking them to "identical
 * except harness" catches that at build time.
 */
describe('buildMcpLaunchSpec', () => {
	const extensionUri = { fsPath: '/ext' } as unknown as vscode.Uri;
	const config = fakeConfig();

	it('emits the harness through COPILOT_TEAMS_BRIDGE_HARNESS so the server can record it', () => {
		const vsCode = buildMcpLaunchSpec(extensionUri, config, 'vscode-agent-mcp');
		const cli = buildMcpLaunchSpec(extensionUri, config, 'cli-runtime');

		assert.strictEqual(vsCode.env.COPILOT_TEAMS_BRIDGE_HARNESS, 'vscode-agent-mcp');
		assert.strictEqual(cli.env.COPILOT_TEAMS_BRIDGE_HARNESS, 'cli-runtime');
	});

	it('produces identical launch specs apart from the harness', () => {
		const vsCode = buildMcpLaunchSpec(extensionUri, config, 'vscode-agent-mcp');
		const cli = buildMcpLaunchSpec(extensionUri, config, 'cli-runtime');

		assert.strictEqual(vsCode.command, cli.command, 'runtime binary must match');
		assert.deepStrictEqual(vsCode.args, cli.args, 'args must match');

		const stripHarness = (env: Record<string, string>): Record<string, string> => {
			const { COPILOT_TEAMS_BRIDGE_HARNESS, ...rest } = env;
			void COPILOT_TEAMS_BRIDGE_HARNESS;
			return rest;
		};
		assert.deepStrictEqual(stripHarness(vsCode.env), stripHarness(cli.env), 'env must match apart from harness');
	});
});
