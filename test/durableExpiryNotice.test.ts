import * as assert from 'assert';
import { describe, it, before, beforeEach } from 'node:test';
import { useTempHome } from './support/tempHome';
import type { Session } from '../src/domain/types';

useTempHome('ctb-expiry-home-');

interface Relay {
	drain(): Promise<void>;
	reactivate(key: string): Promise<Session | undefined>;
	dispose(): void;
}

let makeRelay: (deps: { onExpired: (s: Session) => Promise<void>; idleMs: number }) => Relay;
let storeContents = '[]';

function readStore(): Session[] {
	return JSON.parse(storeContents) as Session[];
}

function seed(sessions: Session[]): void {
	storeContents = JSON.stringify(sessions);
}

function quietSession(extra: Partial<Session> = {}): Session {
	return {
		id: 's-quiet',
		key: 'quiet-task',
		title: 'A quiet task',
		createdAt: '2026-08-29T00:00:00.000Z',
		// Long past any sane idle window.
		lastActivityAt: '2026-08-29T00:00:00.000Z',
		seenReplyIds: [],
		status: 'progress',
		thread: { id: 't-1' },
		...extra
	};
}

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);
	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode'
			? {
					Uri: { file: (p: string) => ({ fsPath: p }) },
					workspace: {
						createFileSystemWatcher: () => ({
							onDidChange: () => ({ dispose: () => undefined }),
							dispose: () => undefined
						}),
						fs: {
							readFile: async () => Buffer.from(storeContents),
							writeFile: async (_uri: unknown, content: Uint8Array) => {
								storeContents = Buffer.from(content).toString();
							}
						}
					}
				}
			: originalLoad(request, parent, isMain);

	const { AgentReplyRelay } = require('../src/hosts/vscode/agentReplyRelay') as {
		AgentReplyRelay: new (deps: Record<string, unknown>) => Relay;
	};
	Module._load = originalLoad;
	/* eslint-enable @typescript-eslint/no-require-imports */

	makeRelay = (deps): Relay =>
		new AgentReplyRelay({
			storeUri: { fsPath: 'sessions.json' },
			deliver: async () => 'delivered',
			log: { info: () => undefined, warn: () => undefined, debug: () => undefined },
			intervalMs: () => 10_000,
			enabled: () => true,
			resolveChatSession: () => undefined,
			// No replies to collect; this suite is only about the lifecycle notice.
			fetchReplies: async () => [],
			idleMs: () => deps.idleMs,
			onExpired: deps.onExpired
		});
});

beforeEach(() => {
	storeContents = '[]';
});

/**
 * A session that goes quiet must always end up *saying* so in its thread.
 *
 * Expiring is a local write and effectively cannot fail; announcing it is a network call.
 * The two used to happen in one pass, so when the transport was down at that moment the
 * notice was lost for good -- `expiredAt` was already persisted, so the session never
 * re-entered the expiring set. That is exactly what happened on 2026-08-29: the machine
 * woke, expiry was detected on the first poll while the Teams connection was still dead,
 * and two of three sessions were retired in silence while their threads still invited a
 * reply. These tests pin the retry that makes the notice durable.
 */
describe('the pause notice survives a transport that is down', () => {
	it('retries on the next pass when the notice cannot be posted', async () => {
		seed([quietSession()]);
		let attempts = 0;
		const relay = makeRelay({
			idleMs: 1,
			onExpired: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error('Timed out waiting for initialize');
				}
			}
		});

		await relay.drain();
		assert.strictEqual(attempts, 1, 'first attempt is made when the session expires');
		assert.ok(readStore()[0].expiredAt, 'the session is expired regardless of the notice');
		assert.strictEqual(
			readStore()[0].expiryNoticeAt,
			undefined,
			'a failed post must not be recorded as delivered'
		);

		await relay.drain();
		assert.strictEqual(attempts, 2, 'the notice is tried again once Teams is reachable');
		assert.ok(readStore()[0].expiryNoticeAt, 'and recorded once it lands');
		relay.dispose();
	});

	it('stops retrying once the notice has landed', async () => {
		seed([quietSession()]);
		let attempts = 0;
		const relay = makeRelay({
			idleMs: 1,
			onExpired: async () => {
				attempts += 1;
			}
		});

		await relay.drain();
		await relay.drain();
		await relay.drain();

		assert.strictEqual(attempts, 1, 'one notice per expiry, however many polls follow');
		relay.dispose();
	});

	it('keeps retrying for as long as the transport stays down', async () => {
		seed([quietSession()]);
		let attempts = 0;
		const relay = makeRelay({
			idleMs: 1,
			onExpired: async () => {
				attempts += 1;
				throw new Error('still unreachable');
			}
		});

		await relay.drain();
		await relay.drain();
		await relay.drain();

		assert.strictEqual(attempts, 3, 'a notice that never lands is never abandoned');
		assert.strictEqual(readStore()[0].expiryNoticeAt, undefined);
		relay.dispose();
	});

	it('owes a fresh notice after the session is revived and goes quiet again', async () => {
		seed([quietSession()]);
		let attempts = 0;
		const relay = makeRelay({
			idleMs: 1,
			onExpired: async () => {
				attempts += 1;
			}
		});

		await relay.drain();
		assert.strictEqual(attempts, 1);

		await relay.reactivate('quiet-task');
		const revived = readStore()[0];
		assert.strictEqual(revived.expiredAt, undefined, 'revival clears the expiry');
		assert.strictEqual(
			revived.expiryNoticeAt,
			undefined,
			'and the spent notice, or the next pause would be silent'
		);

		// Wind activity back so the next poll sees it as quiet again.
		const again = readStore();
		again[0].lastActivityAt = '2026-08-29T00:00:00.000Z';
		seed(again);

		await relay.drain();
		assert.strictEqual(attempts, 2, 'a second pause must be announced as well as the first');
		relay.dispose();
	});

	it('does not announce a session that was already told before this change', async () => {
		// Upgrade path: a record written by an older build has expiredAt but no
		// expiryNoticeAt, and its user may already have been told. Re-announcing every such
		// session on upgrade would post a burst of stale notices.
		seed([quietSession({ expiredAt: '2026-08-29T01:00:00.000Z', closed: true })]);
		let attempts = 0;
		const relay = makeRelay({
			idleMs: 1,
			onExpired: async () => {
				attempts += 1;
			}
		});

		await relay.drain();
		assert.strictEqual(attempts, 0, 'a closed session is finished with, notice or not');
		relay.dispose();
	});
});
