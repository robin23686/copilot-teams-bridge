import * as vscode from 'vscode';
import type { BridgeConfig } from './config';
import { buildMcpLaunchSpec } from './mcpServerDefinition';

/**
 * Publishes the bundled MCP server to VS Code.
 *
 * Registering it here rather than asking the user to hand-write `mcp.json` removes the
 * one dependency the bridge could not survive: a path to wherever the repository happened
 * to be checked out. Moving, cleaning or deleting that folder silently killed the server
 * for every agent session, with no error beyond tools quietly disappearing. The extension
 * always knows where its own copy lives.
 */
export const MCP_PROVIDER_ID = 'copilotTeamsBridge.servers';

export class BridgeMcpProvider implements vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeMcpServerDefinitions = this.changed.event;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly version: string,
		private readonly readConfig: () => BridgeConfig
	) {}

	/** Tells VS Code to restart the server after settings that change its behaviour. */
	refresh(): void {
		this.changed.fire();
	}

	provideMcpServerDefinitions(): vscode.McpStdioServerDefinition[] {
		const config = this.readConfig();
		const spec = buildMcpLaunchSpec(this.extensionUri, config, 'vscode-agent-mcp');

		const definition = new vscode.McpStdioServerDefinition(
			'Copilot Teams Bridge',
			spec.command,
			spec.args,
			spec.env,
			// Changing this makes VS Code offer to refresh the tools.
			`${this.version}-${config.teamId}-${config.channelId}`
		);
		return [definition];
	}

	dispose(): void {
		this.changed.dispose();
	}
}
