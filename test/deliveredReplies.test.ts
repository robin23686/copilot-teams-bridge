import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { useTempHome } from './support/tempHome';

// Even though every test below constructs the registry with an explicit file path, the
// helper is called so a stray default-path construction — added later or slipped in via
// a helper — cannot silently touch ~/.copilot-teams-bridge/delivered.json.
const tempHome = useTempHome('ctb-delivered-home-');

import { JsonDeliveredRepliesRegistry } from '../src/infrastructure/deliveredReplies';

/**
 * The duplicate-injection bug of 2026-08-28.
 *
 * The extension's own globalState store and the MCP server's JSON store had grown into
 * two Session records pointing at the same Teams thread. Per-store `seenReplyIds` could
 * not see across stores, so both records saw the reply, both queued it, and both
 * delivered it — the user's one instruction landed in chat twice.
 *
 * The registry closes the gap by making the transport reply id the atomic unit: one
 * process claims it, the other has to consume it silently. These tests pin the atomicity
 * and the file-shared behaviour so a regression in either loses immediately.
 */
describe('cross-process claim of delivered Teams reply ids', () => {
	let tempDir: string;

	before(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-delivered-'));
	});

	after(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempHome.cleanup();
	});

	beforeEach(() => {
		// A fresh file per case, so claims from an earlier case cannot bleed into the next.
		for (const name of fs.readdirSync(tempDir)) {
			fs.rmSync(path.join(tempDir, name), { force: true });
		}
	});

	it('claims a reply id once and refuses every later claim', () => {
		const registry = new JsonDeliveredRepliesRegistry(path.join(tempDir, 'claim-once.json'));

		assert.strictEqual(registry.claim('reply-1'), true, 'the first claim must win');
		assert.strictEqual(registry.claim('reply-1'), false, 'the second claim must lose');
		assert.strictEqual(registry.claim('reply-1'), false, 'and every one after that');
		assert.strictEqual(registry.has('reply-1'), true, 'and the id must read as claimed');
	});

	// This is the actual bug: two processes racing on the SAME on-disk file. A per-instance
	// in-memory set would pass the case above and still lose the cross-process guarantee,
	// which is the whole point of putting the registry on disk. So it is exercised directly.
	it('lets only one of two instances sharing the file win a race for the same id', () => {
		const file = path.join(tempDir, 'racing.json');
		const a = new JsonDeliveredRepliesRegistry(file);
		const b = new JsonDeliveredRepliesRegistry(file);

		const wonByA = a.claim('reply-race');
		const wonByB = b.claim('reply-race');

		assert.strictEqual(wonByA, true, 'the first process to claim must win');
		assert.strictEqual(wonByB, false, 'the second process must lose — no double injection');
		// And the losing side must still see the claim from the file, so it can consume
		// the reply on its next pass.
		assert.strictEqual(new JsonDeliveredRepliesRegistry(file).has('reply-race'), true);
	});

	it('releases a claim so an unroutable reply can be retried later', () => {
		const registry = new JsonDeliveredRepliesRegistry(path.join(tempDir, 'release.json'));

		assert.strictEqual(registry.claim('reply-2'), true);
		registry.release('reply-2');

		assert.strictEqual(
			registry.claim('reply-2'),
			true,
			'a released id must be claimable again — otherwise transient failures tombstone the reply'
		);
	});

	// A corrupt file cannot be allowed to block delivery: the user is already waiting.
	it('degrades to no cross-process guarantee when the file is corrupt', () => {
		const file = path.join(tempDir, 'broken.json');
		fs.writeFileSync(file, 'not JSON');
		const registry = new JsonDeliveredRepliesRegistry(file);

		assert.strictEqual(registry.has('any'), false, 'a broken file must read as empty');
		assert.strictEqual(
			registry.claim('any'),
			true,
			'a broken file must not block a delivery in progress'
		);
	});

	it('caps the retained ids so a long install cannot grow the file forever', () => {
		const registry = new JsonDeliveredRepliesRegistry(path.join(tempDir, 'bounded.json'));
		for (let index = 0; index < 1_200; index++) {
			registry.claim(`r-${index}`);
		}
		assert.strictEqual(registry.has('r-1199'), true, 'the newest id must be retained');
		assert.strictEqual(registry.has('r-0'), false, 'the oldest id must have been dropped');
	});

	it('claims and releases nothing for an empty id', () => {
		const registry = new JsonDeliveredRepliesRegistry(path.join(tempDir, 'empty.json'));

		assert.strictEqual(registry.claim(undefined), false);
		assert.strictEqual(registry.claim(''), false);
		registry.release(undefined);
		registry.release('');
	});
});
