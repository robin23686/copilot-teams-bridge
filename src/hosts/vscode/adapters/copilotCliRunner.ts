import { spawn } from 'child_process';
import type { CliRunner } from './cliRuntimeAdapter';

/**
 * Runs the `copilot` CLI and collects what it printed.
 *
 * Kept apart from {@link CliRuntimeAdapter} so the adapter's decisions -- whether to resume
 * at all, what to do with a non-zero exit -- can be tested without spawning a real agent
 * run. Spawning one in a unit test would execute whatever instruction the fixture carried.
 *
 * Arguments are passed as an array and never through a shell, so nothing in the reply text
 * can become a second command. The session id is validated at the point it enters the
 * process (`cliSessionIdFromEnv`), so both ends of the path refuse a value that is not an
 * id.
 */
export const runCopilotCli: CliRunner = (args, options) =>
	new Promise((resolve, reject) => {
		const child = spawn('copilot', [...args], {
			shell: false,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			// Reported rather than resolved with a code: a run that outlived its budget may
			// still be doing work, and calling it a clean failure would invite a retry that
			// acts on the same instruction twice.
			child.kill();
			reject(new Error(`Copilot CLI did not finish within ${Math.round(options.timeoutMs / 1000)}s`));
		}, options.timeoutMs);

		child.stdout?.on('data', (chunk: Buffer | string) => {
			stdout += String(chunk);
		});
		child.stderr?.on('data', (chunk: Buffer | string) => {
			stderr += String(chunk);
		});

		child.on('error', (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(error);
		});

		child.on('close', (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
