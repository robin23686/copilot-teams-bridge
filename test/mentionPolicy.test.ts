import * as assert from 'assert';
import { describe, it } from 'node:test';
import { mentionPolicyFromEnv } from '../src/hosts/mcp/mentionPolicy';

/**
 * The MCP server is a separate process that receives its mention policy through an env var
 * emitted by the extension's launch spec. The mapping has to be forgiving: an unset value
 * is normal on first launch, and an unrecognised value has to fall back rather than crash
 * the server or silently downgrade the user's setting.
 */
describe('mentionPolicyFromEnv', () => {
	it('maps each recognised value to the matching policy', () => {
		assert.strictEqual(mentionPolicyFromEnv('keyMoments'), 'keyMoments');
		assert.strictEqual(mentionPolicyFromEnv('everyMessage'), 'everyMessage');
		assert.strictEqual(mentionPolicyFromEnv('never'), 'never');
	});

	it('falls back to keyMoments for an unset value', () => {
		assert.strictEqual(mentionPolicyFromEnv(undefined), 'keyMoments');
	});

	it('falls back to keyMoments for an unrecognised value rather than crashing', () => {
		assert.strictEqual(mentionPolicyFromEnv(''), 'keyMoments');
		assert.strictEqual(mentionPolicyFromEnv('KEYMOMENTS'), 'keyMoments');
		assert.strictEqual(mentionPolicyFromEnv('always'), 'keyMoments');
		assert.strictEqual(mentionPolicyFromEnv('garbage'), 'keyMoments');
	});
});
