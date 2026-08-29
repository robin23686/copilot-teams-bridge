import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { runTests } from '@vscode/test-electron';

/**
 * Runs the integration suite inside a real VS Code.
 *
 * Everything else in this repo tests against hand-written fakes, and that is precisely how
 * two days were lost: a fake asserts the assumption it was written from, so a routing bug
 * reasoned out incorrectly passed every test and shipped twice. Only the real editor can
 * say whether `workbench.action.chat.openSessionInEditorGroup` brings a chat to the front.
 *
 * Pinned to the version the user runs, because command behaviour is version-specific and a
 * pass on some other build would prove nothing about theirs.
 */
async function main(): Promise<void> {
	// The shared registries (delivered.json, posted.json, threads.json) fall back to
	// ~/.copilot-teams-bridge when this env var is unset, and the electron subprocess
	// inherits our environment. Without redirecting it here, the real extension host would
	// tombstone the seeded reply ids in the developer's own shared state — the same
	// second-run failure this file's unit-test counterparts guard against.
	const bridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-host-home-'));
	process.env.COPILOT_TEAMS_BRIDGE_HOME = bridgeHome;

	// The same hazard, one directory over, and a worse one. Activation writes the Copilot
	// CLI's MCP registration into ~/.copilot/mcp-config.json, and this host launches a real
	// extension host against a throwaway user-data dir where no team or channel is
	// configured. Left unredirected, every run overwrote the developer's own registration
	// with an entry that has no team and channel — which does not fail, it silently
	// downgrades every CLI session to the local file transport, so agents post into a file
	// and believe they reached Teams. Found exactly that way.
	const cliHome = path.join(bridgeHome, '.copilot');
	process.env.COPILOT_CLI_HOME = cliHome;

	try {
		const workspace = path.resolve(__dirname, '../..', '.vscode-test-workspace');
		const userData = path.resolve(__dirname, '../..', '.vscode-test-user-data');

		// A chat session has to exist before the interesting question can be asked, and a
		// headless host cannot make one: opening a chat without a model persists nothing, so
		// there is no transcript and nothing to aim at. Seeding one is legitimate rather
		// than a shortcut — VS Code loads persisted sessions from this folder at startup,
		// which is exactly the state the user's editor is in when a reply arrives.
		seedChatSession(workspace, userData);

		await runTests({
			version: process.env.CTB_VSCODE_VERSION ?? '1.135.0',
			extensionDevelopmentPath: path.resolve(__dirname, '../..'),
			extensionTestsPath: path.resolve(__dirname, 'suite', 'index'),
			launchArgs: [
				// A throwaway workspace, so the suite never reads or writes the user's chats.
				path.resolve(__dirname, '../..', '.vscode-test-workspace'),
				// Pinned so the suite can find the transcripts this instance writes; the
				// default location is generated and not knowable from inside the test.
				'--user-data-dir',
				path.resolve(__dirname, '../..', '.vscode-test-user-data'),
				'--disable-extensions',
				'--disable-gpu',
				'--disable-workspace-trust',
				'--skip-welcome',
				'--skip-release-notes'
			],
			// Belt-and-braces: pass the redirect explicitly even though the child inherits
			// parent env, so a future @vscode/test-electron that filters env cannot silently
			// re-expose the real home.
			extensionTestsEnv: { COPILOT_TEAMS_BRIDGE_HOME: bridgeHome, COPILOT_CLI_HOME: cliHome }
		});
	} catch (error) {
		console.error('Integration tests failed:', error);
		process.exitCode = 1;
	} finally {
		try {
			fs.rmSync(bridgeHome, { recursive: true, force: true });
		} catch {
			// Best-effort — a leaked temp directory is a small cost against masking the
			// failure that put us in the catch above.
		}
	}
}

/** The session the suite aims at, and the id it is told to expect. */
export const SEEDED_SESSION_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Writes a persisted chat session into the workspace storage the test instance will use.
 *
 * The shape matches what VS Code 1.135 writes: a `kind:0` snapshot carrying the session id,
 * then keyed deltas. Only the fields the editor needs in order to list and load the session
 * are included — enough for it to exist, not a replica of a full conversation.
 */
function seedChatSession(workspace: string, userData: string): void {
	// The storage folder is a hash of the workspace path, so it is stable across runs for a
	// fixed workspace — which is what makes seeding possible at all.
	const hash = createHash('md5').update(pathToFileURL(workspace).toString()).digest('hex');
	const folder = path.join(userData, 'User', 'workspaceStorage', hash, 'chatSessions');
	fs.mkdirSync(folder, { recursive: true });

	const now = Date.now();
	const lines = [
		JSON.stringify({
			kind: 0,
			v: {
				version: 3,
				creationDate: now,
				initialLocation: 'panel',
				responderUsername: 'GitHub Copilot',
				sessionId: SEEDED_SESSION_ID,
				hasPendingEdits: false,
				requests: [],
				pendingRequests: []
			}
		}),
		JSON.stringify({ kind: 1, k: ['customTitle'], v: 'Seeded host check session' })
	];
	fs.writeFileSync(path.join(folder, `${SEEDED_SESSION_ID}.jsonl`), lines.join('\n') + '\n', 'utf8');
	console.log(`Seeded chat session ${SEEDED_SESSION_ID} into ${folder}`);
}

void main();
