import * as assert from 'assert';
import { describe, it } from 'node:test';
import { harnessFromEnv } from '../src/hosts/mcp/harnessEnv';

/**
 * Two callers spawn the stdio server. Until this env var arrived they were
 * indistinguishable at the wire, so the reply-invitation footer could not be right for
 * both — either a false negative for one, or a false positive for the other. The mapping
 * has to be forgiving in the same way {@link mentionPolicyFromEnv} is: an unset value on
 * first launch, and anything unrecognised, has to fall back rather than crash the server.
 */
describe('harnessFromEnv', () => {
	it('maps each recognised value to the matching harness', () => {
		assert.strictEqual(harnessFromEnv('vscode-agent-mcp'), 'vscode-agent-mcp');
		assert.strictEqual(harnessFromEnv('cli-runtime'), 'cli-runtime');
		assert.strictEqual(harnessFromEnv('vscode-sidebar'), 'vscode-sidebar');
		assert.strictEqual(harnessFromEnv('external'), 'external');
	});

	it('falls back to unknown for an unset value', () => {
		assert.strictEqual(harnessFromEnv(undefined), 'unknown');
	});

	// Falling back to a deliverable harness would be worse than pre-existing behaviour: it
	// would invite a reply that has nowhere to go. "unknown" is the safe direction — the
	// relay resolves it lazily just as it did before this env var existed.
	it('falls back to unknown for an unrecognised value rather than guessing', () => {
		assert.strictEqual(harnessFromEnv(''), 'unknown');
		assert.strictEqual(harnessFromEnv('CLI-RUNTIME'), 'unknown');
		assert.strictEqual(harnessFromEnv('agent'), 'unknown');
		assert.strictEqual(harnessFromEnv('garbage'), 'unknown');
	});
});
