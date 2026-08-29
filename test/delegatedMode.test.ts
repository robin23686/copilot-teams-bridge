import * as assert from 'assert';
import { describe, it } from 'node:test';
import { delegatedFromEnv, startBridgeUnlessDelegated } from '../src/hosts/mcp/delegatedMode';

/**
 * A delegated agent MCP session is a short-lived process spawned by a parent agent — it
 * has no long-lived thread to watch, so it must not open one. The env var is how the
 * launcher tells the server which mode to run in, and the mapping has to be forgiving in
 * the same way {@link mentionPolicyFromEnv} and {@link harnessFromEnv} are: unset is
 * normal on every existing install, and an unrecognised value has to fall back rather
 * than crash the server or silently change behaviour.
 */
describe('delegatedFromEnv', () => {
	it('treats 1, true and yes as on, case-insensitively and after trimming', () => {
		assert.strictEqual(delegatedFromEnv('1'), true);
		assert.strictEqual(delegatedFromEnv('true'), true);
		assert.strictEqual(delegatedFromEnv('yes'), true);
		assert.strictEqual(delegatedFromEnv('TRUE'), true);
		assert.strictEqual(delegatedFromEnv('Yes'), true);
		assert.strictEqual(delegatedFromEnv('  1  '), true);
		assert.strictEqual(delegatedFromEnv('\ttrue\n'), true);
	});

	// Falling back to on would silently muzzle every existing install. "off" is the safe
	// direction, matching the pre-existing behaviour where no delegated flag was ever
	// emitted at all.
	it('falls back to off for unset, empty, and unrecognised values', () => {
		assert.strictEqual(delegatedFromEnv(undefined), false);
		assert.strictEqual(delegatedFromEnv(''), false);
		assert.strictEqual(delegatedFromEnv('0'), false);
		assert.strictEqual(delegatedFromEnv('false'), false);
		assert.strictEqual(delegatedFromEnv('no'), false);
		assert.strictEqual(delegatedFromEnv('garbage'), false);
		assert.strictEqual(delegatedFromEnv('2'), false);
	});
});

/**
 * The polling loop is what reads Teams for replies. A delegated server has no thread of
 * its own to watch, so starting it would issue reads against a channel this process has
 * no business reading — and once the short-lived agent exits, whatever it collected is
 * lost anyway. The wire-up in stdio.ts is one branch; regressing it would silently
 * reintroduce Teams I/O for delegated agents.
 */
describe('startBridgeUnlessDelegated', () => {
	it('starts the bridge when not delegated', () => {
		let started = 0;
		startBridgeUnlessDelegated({ start: () => { started++; } }, false);
		assert.strictEqual(started, 1);
	});

	it('does not start the bridge when delegated', () => {
		let started = 0;
		startBridgeUnlessDelegated({ start: () => { started++; } }, true);
		assert.strictEqual(started, 0);
	});
});
