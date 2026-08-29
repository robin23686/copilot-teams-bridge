import * as assert from 'assert';
import * as path from 'path';
import { describe, it, before } from 'node:test';

/**
 * Adaptive delivery confirmation with an asymmetric quiet window.
 *
 * The original failure: `confirmLandedIn` ran a fixed eight-second poll for the delivery
 * marker, and VS Code sometimes did not flush the request into the target chat's
 * `.jsonl` until roughly a second after that. Moving to a settle window fixed the
 * short-delay case but introduced a second failure mode, proven from live data: a cold
 * chat whose agent was still spinning up produced a ~50s flush gap in which VS Code
 * wrote NOTHING to the .jsonl between our write and the marker arriving. Because the
 * file never changed, the settle window expired before the flush, the bridge declared
 * the delivery unroutable, and a spurious VS Code consent popup opened while the reply
 * itself was in fact about to land in the correct chat.
 *
 * The rule now distinguishes two situations:
 *   (a) the transcript has NOT changed at all since we started watching — no evidence
 *       of failure, so we keep polling until the ceiling;
 *   (b) the transcript HAS changed but the marker is still absent and the file has been
 *       quiet for the settle window — real evidence the request went elsewhere, so we
 *       fail at the quiet window.
 *
 * The ceiling is the hard bound for both cases so nothing waits forever, and a missing
 * transcript file is treated as case (a): it may simply not have been written yet.
 */

interface FakeStat {
	size: number;
	mtimeMs: number;
}

interface ConfirmLandedOptions {
	ceilingMs?: number;
	pollMs?: number;
	now?(): number;
	sleep?(ms: number): Promise<void>;
	readFile?(file: string): string;
	stat?(file: string): FakeStat | undefined;
}

type ConfirmLandedIn = (
	chatSessionsUri: { fsPath: string },
	resource: string,
	marker: string,
	quietMs?: number,
	options?: ConfirmLandedOptions
) => Promise<boolean>;

let confirmLandedIn: ConfirmLandedIn | undefined;

// The session id in the resource decides the transcript file name. Using a real base64
// round-trip here (rather than a fake) means the test exercises the same decoder the
// runtime does, so a change to the encoding format cannot silently make this test lie.
const SESSION_ID = '00000000-0000-4000-8000-000000000000';
const RESOURCE = 'vscode-chat-session://local/' + Buffer.from(SESSION_ID, 'utf8').toString('base64');
const MARKER = '[Teams reply · session "T" · from Rob (Teams)]';
const CHAT_DIR = { fsPath: '/fake/chats' };
const TRANSCRIPT = path.join(CHAT_DIR.fsPath, SESSION_ID + '.jsonl');

before(() => {
	/* eslint-disable @typescript-eslint/no-require-imports */
	const Module = require('module') as { _load(request: string, parent: unknown, isMain: boolean): unknown };
	const originalLoad = Module._load.bind(Module);
	// Only the `Uri` shape matters here — `confirmLandedIn` reads `.fsPath` off it and
	// never calls anything else on the vscode namespace along its path.
	Module._load = (request: string, parent: unknown, isMain: boolean): unknown =>
		request === 'vscode' ? { Uri: { parse: (v: string) => v } } : originalLoad(request, parent, isMain);
	const module = require('../src/hosts/vscode/chatReveal') as { confirmLandedIn: ConfirmLandedIn };
	/* eslint-enable @typescript-eslint/no-require-imports */
	Module._load = originalLoad;
	confirmLandedIn = module.confirmLandedIn;
});

/**
 * A scripted clock and file system. The clock only advances when `sleep` is called or a
 * step function pushes it forward; the transcript is whatever `text` and `stat` are set
 * to at read time. This lets one test rehearse an entire minute of behaviour in a few
 * milliseconds of real time and observe exactly what the confirmation loop saw.
 */
function makeWorld(initial: { text?: string; stat?: FakeStat } = {}): {
	options: ConfirmLandedOptions;
	advance(ms: number): void;
	setText(text: string | undefined): void;
	setStat(stat: FakeStat | undefined): void;
	nowMs(): number;
	sleeps: number[];
} {
	let now = 1_000_000; // Some non-zero epoch, so tests never depend on Date.now() == 0.
	let text = initial.text;
	let stat = initial.stat;
	const sleeps: number[] = [];
	const options: ConfirmLandedOptions = {
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
		readFile: () => {
			if (text === undefined) {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			}
			return text;
		},
		stat: () => stat
	};
	return {
		options,
		advance: (ms) => {
			now += ms;
		},
		setText: (t) => {
			text = t;
		},
		setStat: (s) => {
			stat = s;
		},
		nowMs: () => now,
		sleeps
	};
}

describe('confirmLandedIn is adaptive rather than a fixed deadline', () => {
	it('confirms when the marker appears after the quiet window while the transcript keeps changing (regression)', async () => {
		// The exact bug: on a cold chat whose agent was still spinning up, VS Code flushed
		// the request into the .jsonl ~8.3s after the write, and the old fixed 8s deadline
		// declared it unproven by roughly one second. Under the adaptive rule the loop keeps
		// waiting while the file itself keeps growing.
		const world = makeWorld({ text: 'preamble 0', stat: { size: 0, mtimeMs: 500_000 } });

		let tick = 0;
		world.options.readFile = (): string => {
			tick++;
			// The file mutates on every poll — size and mtime both advance — so the quiet
			// window keeps being reset. The marker only lands after 40 polls (~10s at
			// 250ms), well past the 5s quiet window but before the ceiling.
			world.setStat({ size: tick * 10, mtimeMs: 500_000 + tick * 250 });
			return tick >= 40 ? 'preamble\n' + MARKER + '\ntrailer' : 'preamble ' + tick;
		};

		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 5_000, {
			...world.options,
			pollMs: 250,
			ceilingMs: 60_000
		});
		assert.strictEqual(ok, true, 'a marker that appears while the transcript is still changing must confirm');
	});

	it('fails at the absolute ceiling when the transcript never changes and never contains the marker', async () => {
		// UPDATED FROM OLD "fails at the quiet window" ASSERTION. Under the new rule, a
		// transcript that has not moved at all is treated as case (a): we have no
		// evidence of failure, so we keep polling until the ceiling. The old behaviour
		// (fail at the quiet window) was exactly the bug proven from live data: a cold
		// chat's ~50s flush gap with no intermediate writes let the settle window expire
		// before the marker arrived, and a delivery that was in fact about to land was
		// declared unroutable. Failing at the ceiling here bounds the wait without
		// producing that false negative.
		const world = makeWorld({ text: 'noise but no marker', stat: { size: 42, mtimeMs: 500_000 } });
		const start = world.nowMs();

		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 5_000, {
			...world.options,
			pollMs: 250,
			ceilingMs: 20_000
		});
		assert.strictEqual(ok, false, 'a quiet transcript without the marker must eventually fail');
		const elapsed = world.nowMs() - start;
		assert.ok(
			elapsed >= 20_000 && elapsed < 25_000,
			`must fail near the ceiling (20s), not the quiet window; elapsed=${elapsed}ms`
		);
	});

	it('confirms when the marker appears after the quiet window even though the transcript never changes (cold-start regression)', async () => {
		// The exact scenario proven from the 03:33 trace: the reply was written into
		// chat 2ed9a15a, the chat editor was in front, but VS Code did not flush
		// anything to the .jsonl for ~50s while the cold chat's agent started up.
		// The marker eventually appears — well past the 30s quiet window but before the
		// ceiling. Under the old rule the confirmation gave up at 30s; under the new
		// rule the untouched file is case (a), so we keep waiting.
		const world = makeWorld({ text: 'preamble', stat: { size: 10, mtimeMs: 500_000 } });
		world.options.readFile = (): string => {
			return world.nowMs() - 1_000_000 >= 50_000 ? 'preamble\n' + MARKER + '\n' : 'preamble';
		};
		// The stat is frozen: the file's size and mtime never change, exactly as the
		// live evidence showed. Only readFile flips once the clock passes 50s.

		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 30_000, {
			...world.options,
			pollMs: 250,
			ceilingMs: 120_000
		});
		assert.strictEqual(
			ok,
			true,
			'a marker that appears at 50s in a file that never changed size/mtime must still confirm'
		);
	});

	it('fails at the quiet window after the transcript has changed at least once', async () => {
		// Case (b): the transcript changed at 5s, then went quiet with the marker still
		// absent. The chat is demonstrably alive and recorded something else, so
		// concluding our request went elsewhere is safe. Must fail near 5s + 5s = 10s,
		// not near the ceiling.
		const world = makeWorld({ text: 'idle', stat: { size: 10, mtimeMs: 500_000 } });
		const start = world.nowMs();
		world.options.readFile = (): string => {
			const elapsed = world.nowMs() - start;
			if (elapsed >= 5_000 && elapsed < 5_500) {
				world.setStat({ size: 20, mtimeMs: 500_500 });
				return 'idle then something else';
			}
			return elapsed >= 5_000 ? 'idle then something else' : 'idle';
		};

		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 5_000, {
			...world.options,
			pollMs: 250,
			ceilingMs: 60_000
		});
		assert.strictEqual(ok, false, 'a changed-then-quiet transcript without the marker must fail');
		const elapsed = world.nowMs() - start;
		assert.ok(
			elapsed >= 10_000 && elapsed < 15_000,
			`must fail near the quiet window after the change (~10s), not the ceiling; elapsed=${elapsed}ms`
		);
	});

	it('confirms when a change is followed by the marker before the quiet window elapses', async () => {
		// Case (b) with a happy ending: the transcript changed, then the marker arrived
		// well within the quiet window. The fast path in the loop returns true on the
		// very read where the marker is visible.
		const world = makeWorld({ text: 'starting', stat: { size: 10, mtimeMs: 500_000 } });
		const start = world.nowMs();
		world.options.readFile = (): string => {
			const elapsed = world.nowMs() - start;
			if (elapsed >= 2_000) {
				world.setStat({ size: 30, mtimeMs: 500_500 });
				return 'starting\n' + MARKER + '\n';
			}
			if (elapsed >= 1_000) {
				world.setStat({ size: 20, mtimeMs: 500_250 });
				return 'starting more';
			}
			return 'starting';
		};

		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 5_000, {
			...world.options,
			pollMs: 250,
			ceilingMs: 60_000
		});
		assert.strictEqual(ok, true, 'a marker arriving after a change but before the quiet window must confirm');
	});

	it('fails at the absolute ceiling when the transcript keeps changing but never contains the marker', async () => {
		// A chat that writes forever without producing the marker. The settle window never
		// closes because activity keeps resetting it, so only the ceiling can end this.
		const world = makeWorld({ text: '', stat: { size: 0, mtimeMs: 500_000 } });
		let n = 0;
		world.options.readFile = (): string => {
			n++;
			world.setStat({ size: n, mtimeMs: 500_000 + n });
			return 'churn ' + n;
		};

		const start = world.nowMs();
		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 5_000, {
			...world.options,
			pollMs: 250,
			ceilingMs: 20_000
		});
		assert.strictEqual(ok, false, 'a churning transcript that never yields the marker must fail eventually');
		const elapsed = world.nowMs() - start;
		assert.ok(
			elapsed >= 20_000 && elapsed < 25_000,
			`must fail near the ceiling (20s), not before; elapsed=${elapsed}ms`
		);
	});

	it('returns immediately when the marker is already present on the first read', async () => {
		// The fast path used every time on a warm chat, so any extra sleep here would be a
		// regression against the common case as well as making tests slow.
		const world = makeWorld({ text: 'header\n' + MARKER + '\n', stat: { size: 100, mtimeMs: 500_000 } });
		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 5_000, world.options);
		assert.strictEqual(ok, true);
		assert.deepStrictEqual(world.sleeps, [], 'the fast path must not sleep at all');
	});

	it('finds the marker in its JSON-escaped form (transcript entries are JSON lines)', async () => {
		// The transcript is JSON per line, so double quotes inside the marker are escaped
		// when it lands. Without matching the escaped form, every real delivery would fail.
		const escaped = JSON.stringify(MARKER).slice(1, -1);
		const world = makeWorld({ text: '{"message":{"text":"' + escaped + '"}}\n' });
		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 5_000, world.options);
		assert.strictEqual(ok, true);
	});

	it('fails at the ceiling when the transcript file never appears', async () => {
		// UPDATED FROM OLD "fails at the quiet window" ASSERTION. A file that never
		// appears is indistinguishable from case (a): the chat may simply not have
		// flushed anything yet. Failing at the quiet window here would produce the same
		// false-negative pattern the live trace exposed. The ceiling is the correct
		// bound — an unwritten transcript is not evidence the request went elsewhere,
		// only evidence that nothing has happened yet.
		const world = makeWorld({ text: undefined, stat: undefined });
		const start = world.nowMs();
		const ok = await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 3_000, {
			...world.options,
			pollMs: 250,
			ceilingMs: 20_000
		});
		assert.strictEqual(ok, false, 'a never-appearing transcript must eventually fail without throwing');
		const elapsed = world.nowMs() - start;
		assert.ok(
			elapsed >= 20_000 && elapsed < 25_000,
			`missing file must fail at the ceiling, not the quiet window; elapsed=${elapsed}ms`
		);
	});

	it('reads the transcript from the path derived from the resource', async () => {
		// A regression in this decode used to silently point the loop at the wrong file,
		// so it always came back unproven. This asserts that the resource → filename step
		// still resolves to `<session-id>.jsonl` under the sessions directory.
		let seen: string | undefined;
		const world = makeWorld({ text: MARKER, stat: { size: 1, mtimeMs: 1 } });
		world.options.readFile = (file): string => {
			seen = file;
			return MARKER;
		};
		await confirmLandedIn!(CHAT_DIR, RESOURCE, MARKER, 5_000, world.options);
		assert.strictEqual(seen, TRANSCRIPT, 'must read the transcript for the resolved session id');
	});
});
