import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { AgencyTeamsTransport } from '../../infrastructure/transports/agencyTeamsTransport';
import { CONFIG_SECTION } from './config';

/**
 * Guided setup so a new user never has to hand-copy Teams ids.
 *
 * Verifies the Agency CLI is present, lists the user's teams and channels through the
 * Agency Teams MCP, writes the chosen ids to settings, and posts a test message to prove
 * the whole path works.
 */

export interface SetupDeps {
	agencyCommand(): string;
	log: vscode.LogOutputChannel;
	/** Extension root, used to read the bundled instructions file. */
	extensionUri: vscode.Uri;
	/** Where VS Code looks for user-level *.instructions.md files. */
	userInstructionsUri: vscode.Uri;
	/** Where agent/CLI sessions look for instructions (~/.copilot/instructions). */
	agentInstructionsUri?: vscode.Uri;
	/** Suppresses the prompt, for the check that runs unattended on startup. */
	silent?: boolean;
}

export async function runSetup(deps: SetupDeps): Promise<void> {
	const command = deps.agencyCommand();

	const installed = await isAgencyInstalled(command);
	if (!installed) {
		const install = 'How to install';
		const choice = await vscode.window.showErrorMessage(
			`Teams Bridge needs the Agency CLI, but "${command}" was not found on your PATH.`,
			install
		);
		if (choice === install) {
			await vscode.env.openExternal(vscode.Uri.parse('https://aka.ms/agency'));
		}
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Teams Bridge setup', cancellable: false },
		async (progress) => {
			progress.report({ message: 'Loading your teams…' });

			// Any team works for discovery; the ids are only needed once a channel is picked.
			const probe = new AgencyTeamsTransport({ teamId: 'discovery', channelId: 'discovery', command, logger: deps.log });
			try {
				const teams = await probe.listTeams();
				if (teams.length === 0) {
					void vscode.window.showWarningMessage('Teams Bridge: no teams found for your account.');
					return;
				}

				const pickedTeam = await vscode.window.showQuickPick(
					teams
						.slice()
						.sort((a, b) => a.displayName.localeCompare(b.displayName))
						.map((team) => ({ label: team.displayName, description: team.id, team })),
					{ placeHolder: 'Which team owns the channel Copilot should post to?', matchOnDescription: true }
				);
				if (!pickedTeam) {
					return;
				}

				progress.report({ message: 'Loading channels…' });
				const channels = await probe.listChannels(pickedTeam.team.id);
				if (channels.length === 0) {
					void vscode.window.showWarningMessage(`Teams Bridge: no channels found in "${pickedTeam.team.displayName}".`);
					return;
				}

				const pickedChannel = await vscode.window.showQuickPick(
					channels.map((channel) => ({ label: channel.displayName, description: channel.id, channel })),
					{ placeHolder: 'Which channel should Copilot post sessions to?', matchOnDescription: true }
				);
				if (!pickedChannel) {
					return;
				}

				const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
				await config.update('teamId', pickedTeam.team.id, vscode.ConfigurationTarget.Global);
				await config.update('channelId', pickedChannel.channel.id, vscode.ConfigurationTarget.Global);
				await config.update('transport', 'agency', vscode.ConfigurationTarget.Global);

				progress.report({ message: 'Posting a test message…' });
				const verifier = new AgencyTeamsTransport({
					teamId: pickedTeam.team.id,
					channelId: pickedChannel.channel.id,
					command,
					logger: deps.log
				});
				try {
					await verifier.createThread({
						sessionId: `setup-${Date.now()}`,
						title: 'Teams Bridge is connected',
						summary: `Setup finished for **${pickedTeam.team.displayName} › ${pickedChannel.channel.displayName}**.\n\nReply in this thread to send Copilot an instruction.`,
						status: 'completed'
					});
				} finally {
					verifier.dispose();
				}

				void vscode.window.showInformationMessage(
					`Teams Bridge is set up: ${pickedTeam.team.displayName} › ${pickedChannel.channel.displayName}. Check Teams for a test message.`
				);

				await installInstructions(deps);
			} finally {
				probe.dispose();
			}
		}
	);
}

/**
 * Installs the instructions that tell Copilot to call the notify tool.
 *
 * Without these the extension registers a tool nobody asks it to use, so a session would
 * be announced only if the user typed #teams.
 *
 * Two different hosts read two different folders, and a file in one is invisible to the
 * other. The chat sidebar reads VS Code's `User/prompts`, while agent/CLI sessions read
 * `~/.copilot/instructions`. Installing to only the first is why agent sessions stayed
 * silent, so write to both.
 *
 * An out-of-date copy is refreshed rather than left alone. The guidance changes as the
 * bridge does — how long to wait, when not to block, scoping a reply check to your own
 * session — and a user who installed once would otherwise keep the original behaviour
 * for good, with nothing to indicate why their agent behaves unlike the documentation.
 * Only a byte-for-byte match is skipped, so a file the user has edited is still replaced
 * rather than silently diverging; the notification says what changed and offers a look.
 */
export async function installInstructions(deps: SetupDeps): Promise<void> {
	const source = vscode.Uri.joinPath(deps.extensionUri, 'assets', 'teams-bridge.instructions.md');
	const targets = [deps.userInstructionsUri, deps.agentInstructionsUri].filter(Boolean) as vscode.Uri[];

	try {
		const content = await vscode.workspace.fs.readFile(source);
		const written: vscode.Uri[] = [];
		let refreshed = false;

		for (const folder of targets) {
			const target = vscode.Uri.joinPath(folder, 'teams-bridge.instructions.md');
			const current = await read(target);
			if (current && Buffer.from(current).equals(Buffer.from(content))) {
				continue;
			}
			await vscode.workspace.fs.createDirectory(folder);
			await vscode.workspace.fs.writeFile(target, content);
			deps.log.info(`${current ? 'Updated' : 'Installed'} Copilot instructions at ${target.fsPath}`);
			refreshed = refreshed || Boolean(current);
			written.push(target);
		}

		if (written.length === 0) {
			return;
		}

		if (deps.silent) {
			return;
		}

		const view = 'View';
		const choice = await vscode.window.showInformationMessage(
			refreshed
				? 'Updated the Copilot Teams Bridge instructions to match this version. Reload VS Code to apply.'
				: 'Added instructions so Copilot posts to Teams automatically. Reload VS Code to apply.',
			view,
			'Reload'
		);
		if (choice === view) {
			await vscode.window.showTextDocument(written[0]);
		} else if (choice === 'Reload') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (error) {
		deps.log.warn(`Could not install the Copilot instructions: ${error instanceof Error ? error.message : String(error)}`);
		void vscode.window.showWarningMessage(
			'Teams Bridge is connected, but the Copilot instructions could not be installed automatically. See the README for the snippet to add manually.'
		);
	}
}

/** Returns the file's bytes, or undefined when it does not exist yet. */
async function read(uri: vscode.Uri): Promise<Uint8Array | undefined> {
	try {
		return await vscode.workspace.fs.readFile(uri);
	} catch {
		return undefined;
	}
}

function isAgencyInstalled(command: string): Promise<boolean> {
	return new Promise((resolve) => {
		// The launcher is a .cmd shim on Windows, which Node will not exec directly.
		const [executable, args] =
			process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', command, '--version']] : [command, ['--version']];

		execFile(executable, args, { windowsHide: true, timeout: 30_000 }, (error) => resolve(!error));
	});
}

