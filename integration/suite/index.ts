import * as fs from 'fs';
import * as path from 'path';
import { runHostChecks } from './hostChecks';
import { runProductionChecks } from './productionChecks';

/**
 * Entry point the real VS Code calls once the extension host is up.
 *
 * Deliberately not Mocha: this suite answers a handful of factual questions about the host,
 * and each answer has to be printed whether it passes or fails. A runner that stops at the
 * first failure would hide the very facts the run exists to collect.
 */
export async function run(): Promise<void> {
	const results = [...(await runHostChecks()), ...(await runProductionChecks())];
	const report = results
		.map((result) => `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`)
		.join('\n');

	console.log('\n===== HOST CHECKS =====\n' + report + '\n=======================\n');

	// Written to disk as well: the launcher's stdout is interleaved with Electron noise, and
	// a file can be read back deterministically.
	fs.writeFileSync(
		path.resolve(__dirname, '..', '..', '..', 'host-check-results.json'),
		JSON.stringify(results, undefined, 2),
		'utf8'
	);

	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0) {
		throw new Error(`${failed.length} host check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
	}
}
