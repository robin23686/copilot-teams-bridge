import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Redirects the shared registry files onto a scratch directory for the duration of a test
 * run, so unit and host tests neither read from nor write to the developer's real
 * `~/.copilot-teams-bridge`.
 *
 * The shared registries — {@link JsonDeliveredRepliesRegistry},
 * {@link JsonPostedMessagesRegistry} and {@link JsonThreadRegistry} — resolve their path
 * from `COPILOT_TEAMS_BRIDGE_HOME` at construction time. `src/hosts/vscode/extension.ts`
 * constructs a `JsonDeliveredRepliesRegistry` at *module* scope, so the fallback to
 * `os.homedir()` is captured the first time the module is required. A test that only sets
 * the env var inside a `before()` block is therefore too late: by then the extension has
 * already written to (or read a claim from) the real shared state.
 *
 * That is why {@link useTempHome} must be called at the top of a test file, before any
 * import or require that could pull in a registry-owning module. Calling it from a top
 * level statement in the test module means the env var is set as the file is loaded, and
 * every later require inside the file sees the temp directory rather than the real home.
 *
 * The helper never falls back to the real home: it always creates a fresh temp directory
 * and points the env var at it. A best-effort process-exit hook removes any directory that
 * a test file forgot to clean up, so the repo cannot leak folders on the developer's disk.
 */

const createdDirs: string[] = [];
let exitHookInstalled = false;

/**
 * Points `COPILOT_TEAMS_BRIDGE_HOME` at a fresh temp directory for this test file.
 *
 * MUST be called at the top of a test module, before any import or require that might
 * touch the shared registries — including any transitive import of
 * `src/hosts/vscode/extension.ts`, which constructs the delivered-replies registry at
 * module load and never re-reads the environment variable.
 *
 * Returns the directory path and a cleanup function that removes it. The cleanup is
 * idempotent.
 */
export function useTempHome(prefix: string = 'ctb-test-home-'): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	// Explicit assignment — never a conditional — so a stale value from a prior test file
	// in the same node process cannot leak the real home back in.
	process.env.COPILOT_TEAMS_BRIDGE_HOME = dir;
	// Same reason for the Copilot CLI's home: `cliMcpConfig` writes to
	// `~/.copilot/mcp-config.json`, which activation triggers whether or not any test
	// mentions it. Point it at the same scratch directory so a test file loading the
	// extension cannot silently rewrite the developer's real MCP config.
	process.env.COPILOT_CLI_HOME = path.join(dir, '.copilot');
	createdDirs.push(dir);
	installExitHook();

	let cleaned = false;
	return {
		dir,
		cleanup: () => {
			if (cleaned) {
				return;
			}
			cleaned = true;
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort — a leaked temp directory is a small cost, an assertion
				// failure caused by rmdir racing a file handle is a large one.
			}
		}
	};
}

function installExitHook(): void {
	if (exitHookInstalled) {
		return;
	}
	exitHookInstalled = true;
	process.on('exit', () => {
		for (const dir of createdDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort on the way out.
			}
		}
	});
}
