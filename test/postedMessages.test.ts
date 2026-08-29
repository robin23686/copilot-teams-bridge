import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { describe, it, before, after, beforeEach } from 'node:test';
import { useTempHome } from './support/tempHome';

// The registry itself is constructed with an explicit file path per test, but the helper
// is called defensively so a default-path construction added later cannot leak into
// ~/.copilot-teams-bridge/posted.json.
const tempHome = useTempHome('ctb-posted-home-');

import { AgencyTeamsTransport } from '../src/infrastructure/transports/agencyTeamsTransport';
import { JsonPostedMessagesRegistry } from '../src/infrastructure/postedMessages';

/**
 * The self-post feedback loop.
 *
 * With delegated auth the bridge posts as the same user who replies, so a message it
 * posted looks — at the transport layer — identical to one a human posted. Per-process
 * suppression via `seenReplyIds` used to cover this, but the extension store (VS Code
 * globalState) and the MCP store (`~/.copilot-teams-bridge/sessions.json`) live in
 * different files. A message suppressed in one is unknown to the other, so the moment
 * either polls it treats the bridge's own post as a fresh instruction, delivers it to
 * Copilot, which replies with another post, which loops forever.
 *
 * The shared registry closes the gap: every id the bridge posts is recorded to one file
 * on disk, and every fetch drops any message whose id is in it.
 */

/** Stands in for the Agency MCP subprocess. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;

	constructor(private readonly responder: (name: string, args: Record<string, unknown>) => unknown) {
		super();
	}

	readonly stdin = {
		write: (line: string): void => {
			const request = JSON.parse(line) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
			if (request.method === 'initialize') {
				this.reply({ id: request.id, result: { serverInfo: { name: 'fake' } } });
				return;
			}
			if (request.method === 'tools/call') {
				const name = request.params?.name ?? '';
				const args = request.params?.arguments ?? {};
				try {
					const payload = this.responder(name, args);
					this.reply({
						id: request.id,
						result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }
					});
				} catch (error) {
					this.reply({
						id: request.id,
						result: { content: [{ type: 'text', text: (error as Error).message }], isError: true }
					});
				}
			}
		}
	};

	private reply(message: unknown): void {
		setImmediate(() => this.stdout.emit('data', `${JSON.stringify(message)}\n`));
	}

	kill(): void {
		this.killed = true;
	}
}

function withStreams(child: FakeChild): FakeChild {
	(child.stdout as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
	(child.stderr as unknown as { setEncoding(): void }).setEncoding = (): void => undefined;
	return child;
}

let tempDir: string;

describe('self-posted messages are filtered from fetchReplies', () => {
	before(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctb-posted-'));
	});

	after(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempHome.cleanup();
	});

	beforeEach(() => {
		// A fresh file per test, so recorded ids from one case cannot leak into another.
		for (const name of fs.readdirSync(tempDir)) {
			fs.rmSync(path.join(tempDir, name), { force: true });
		}
	});

	// The core loop: post → id recorded → fetch that same id → dropped. Without this the
	// bridge feeds its own acknowledgement back to Copilot as a fresh instruction.
	it('drops a message whose id the same transport just posted', async () => {
		const registry = new JsonPostedMessagesRegistry(path.join(tempDir, 'posted.json'));
		const now = Date.now();
		const child = withStreams(
			new FakeChild((name) => {
				if (name === 'SendMessageToChannel') {
					return { id: 'own-42' };
				}
				if (name === 'ListChannelMessageReplies') {
					return {
						messages: [
							{
								id: 'own-42',
								createdDateTime: new Date(now + 1_000).toISOString(),
								from: { displayName: 'Rob' },
								body: { contentType: 'Text', content: 'This is the bridge acknowledgement.' }
							},
							{
								id: 'human-99',
								createdDateTime: new Date(now + 2_000).toISOString(),
								from: { displayName: 'Rob' },
								body: { contentType: 'Text', content: 'Real instruction from the user.' }
							}
						]
					};
				}
				return {};
			})
		);
		const transport = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			spawnImpl: (() => child) as never,
			mentionSelf: false,
			postedMessages: registry
		});

		await transport.createThread({ sessionId: 's1', title: 'T', summary: 's', status: 'progress' });
		const replies = await transport.fetchReplies({ id: 'own-42' }, new Date(now).toISOString());

		assert.deepStrictEqual(
			replies.map((r) => r.id),
			['human-99'],
			'the self-posted message must be dropped; a human reply must still come through'
		);
		transport.dispose();
	});

	// The cross-process case, which is why the registry has to be on disk. One transport
	// posts, another one (with its own memory) fetches — and the file is what tells the
	// second one that this id was posted by the bridge.
	it('drops a message a sibling transport posted through the shared file', async () => {
		const registryFile = path.join(tempDir, 'shared.json');
		const now = Date.now();

		// Sibling A posts, using its own registry instance backed by the shared file.
		const registryA = new JsonPostedMessagesRegistry(registryFile);
		const childA = withStreams(new FakeChild(() => ({ id: 'own-abc' })));
		const transportA = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			spawnImpl: (() => childA) as never,
			mentionSelf: false,
			postedMessages: registryA
		});
		await transportA.createThread({ sessionId: 's1', title: 'T', summary: 's', status: 'progress' });
		transportA.dispose();

		// Sibling B has never seen this id in-process, but it reads the same file and so
		// still filters it out. This is the scenario the extension and the MCP server run
		// into constantly.
		const registryB = new JsonPostedMessagesRegistry(registryFile);
		const childB = withStreams(
			new FakeChild((name) => {
				if (name === 'ListChannelMessageReplies') {
					return {
						messages: [
							{
								id: 'own-abc',
								createdDateTime: new Date(now + 1_000).toISOString(),
								body: { content: 'bridge post' }
							}
						]
					};
				}
				return {};
			})
		);
		const transportB = new AgencyTeamsTransport({
			teamId: 't',
			channelId: 'c',
			requestTimeoutMs: 2_000,
			spawnImpl: (() => childB) as never,
			mentionSelf: false,
			postedMessages: registryB
		});

		const replies = await transportB.fetchReplies({ id: 'own-abc' }, new Date(now).toISOString());

		assert.deepStrictEqual(
			replies.map((r) => r.id),
			[],
			'a sibling process must not read another process\'s bridge post as a user reply'
		);
		transportB.dispose();
	});

	// A corrupt file must not stop delivery. Better to lose suppression on one id than to
	// refuse to fetch replies at all — the user is waiting on those replies.
	it('degrades to no suppression when the file is corrupt', () => {
		const file = path.join(tempDir, 'broken.json');
		fs.writeFileSync(file, 'not JSON');
		const registry = new JsonPostedMessagesRegistry(file);

		assert.strictEqual(registry.has('anything'), false, 'a broken file must read as empty');
		// And a subsequent record must repair it silently.
		registry.record('now-good');
		assert.strictEqual(registry.has('now-good'), true, 'a repaired file must record ids');
	});

	// Bounded: the registry is read on every poll, so it must not grow without limit as a
	// long-lived install acknowledges thousands of replies.
	it('caps the retained ids so a long install does not grow the file forever', () => {
		const registry = new JsonPostedMessagesRegistry(path.join(tempDir, 'bounded.json'));
		for (let index = 0; index < 1_200; index++) {
			registry.record(`m-${index}`);
		}
		// The oldest ones fall off; the newest stay, because a very old id would already
		// have been walked past by the poller and dropping it cannot mislead anything.
		assert.strictEqual(registry.has('m-1199'), true, 'the newest id must be retained');
		assert.strictEqual(registry.has('m-0'), false, 'the oldest id must have been dropped');
	});
});
