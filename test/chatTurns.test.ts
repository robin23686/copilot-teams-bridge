import * as assert from 'assert';
import { describe, it } from 'node:test';
import { parseTurns, summariseTurn } from '../src/domain/chatTurns';

/**
 * Reading finished turns out of a chat transcript.
 *
 * Shapes here are taken from real transcripts written by VS Code 1.135, including the two
 * that broke the first implementation: `responseTimestamp` is not always written, and prose
 * parts carry no `kind` at all while every other part does.
 */

/** A request as the editor records it, with only the fields this code reads. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		requestId: 'request_1',
		message: { text: 'do the thing' },
		response: [{ value: 'Here is what I did.' }],
		result: { timings: {} },
		...overrides
	};
}

function line(kind: number, value: unknown, key?: string[]): string {
	return JSON.stringify(key ? { kind, k: key, v: value } : { kind, v: value });
}

describe('parseTurns', () => {
	// The everyday case: the editor appends finished requests as a keyed array write.
	it('reads a finished turn from an appended request', () => {
		const turns = parseTurns(line(2, [request()], ['requests']));

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].prompt, 'do the thing');
		assert.strictEqual(turns[0].response, 'Here is what I did.');
		assert.strictEqual(turns[0].complete, true);
	});

	// The whole session arrives in one snapshot line rather than as deltas.
	it('reads turns from a whole-session snapshot', () => {
		const turns = parseTurns(line(0, { sessionId: 's1', requests: [request()] }));

		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].complete, true);
	});

	// The bug that made the first version post nothing at all: real transcripts often omit
	// responseTimestamp, so requiring it marked every finished turn as still streaming.
	it('treats a turn with a result but no responseTimestamp as finished', () => {
		const turns = parseTurns(line(2, [request({ responseTimestamp: undefined })], ['requests']));

		assert.strictEqual(turns[0].complete, true, 'result alone settles a turn');
	});

	// An answer still streaming has no result yet, and must not be summarised: it would be
	// posted half-written and there is no second chance to correct it.
	it('does not report a turn that is still streaming', () => {
		const turns = parseTurns(line(2, [request({ result: undefined })], ['requests']));

		assert.strictEqual(turns[0].complete, false);
	});

	// Written repeatedly as the answer streams; the same turn must not become several.
	it('collapses repeated writes of one turn', () => {
		const text = [
			line(2, [request({ response: [{ value: 'Partial' }], result: undefined })], ['requests']),
			line(2, [request({ response: [{ value: 'Partial and then complete' }] })], ['requests'])
		].join('\n');

		const turns = parseTurns(text);

		assert.strictEqual(turns.length, 1, 'one request id is one turn');
		assert.strictEqual(turns[0].response, 'Partial and then complete');
		assert.strictEqual(turns[0].complete, true);
	});

	// A later delta touching some other field carries no prose. Overwriting on it would
	// silently drop an answer that had already been read.
	it('keeps an answer when a later write does not repeat it', () => {
		const text = [
			line(2, [request()], ['requests']),
			line(1, [request({ response: [] })], ['requests'])
		].join('\n');

		assert.strictEqual(parseTurns(text)[0].response, 'Here is what I did.');
	});

	// The model's private reasoning. It is not the answer, the user never published it, and
	// relaying it to Teams would leak working-out — so this is a guarantee, not a filter.
	it('never includes the model\u2019s thinking in the response', () => {
		const turns = parseTurns(
			line(
				2,
				[
					request({
						response: [
							{ kind: 'thinking', value: 'The user probably means X, but I am unsure and guessing.' },
							{ value: 'Here is the answer.' }
						]
					})
				],
				['requests']
			)
		);

		assert.strictEqual(turns[0].response, 'Here is the answer.');
		assert.doesNotMatch(turns[0].response, /guessing/, 'private reasoning must never be relayed');
	});

	// Tool machinery says nothing about what was decided.
	it('leaves tool invocations out of the response', () => {
		const turns = parseTurns(
			line(
				2,
				[
					request({
						response: [
							{ kind: 'toolInvocationSerialized', invocationMessage: 'Running a command' },
							{ kind: 'mcpServersStarting' },
							{ value: 'Done.' }
						]
					})
				],
				['requests']
			)
		);

		assert.strictEqual(turns[0].response, 'Done.');
	});

	// A transcript is read while being written, so half a line is normal.
	it('skips a partially written line without throwing', () => {
		const text = [line(2, [request()], ['requests']), '{"kind":2,"v":[{"requestId"'].join('\n');

		assert.strictEqual(parseTurns(text).length, 1);
	});

	it('returns nothing for an empty transcript', () => {
		assert.deepStrictEqual(parseTurns(''), []);
	});

	// A keyed delta that names no prompt is an update, not a new turn.
	it('ignores a request with no prompt', () => {
		const turns = parseTurns(line(2, [{ requestId: 'r1', result: {} }], ['requests']));

		assert.deepStrictEqual(turns, []);
	});

	// The turn's start time places it on a timeline, which is what lets a notify call made
	// during the turn suppress the automatic summary for it.
	it('records when the turn began', () => {
		const turns = parseTurns(line(2, [request({ timestamp: 1_700_000_000_000 })], ['requests']));

		assert.strictEqual(turns[0].startedAt, 1_700_000_000_000);
	});

	it('tolerates a turn with no recorded start time', () => {
		const turns = parseTurns(line(2, [request({ timestamp: undefined })], ['requests']));

		assert.strictEqual(turns[0].startedAt, 0);
	});
});

describe('summariseTurn', () => {
	const base = { requestId: 'r1', prompt: 'p', complete: true, startedAt: 0 };

	it('keeps a short answer whole', () => {
		assert.strictEqual(summariseTurn({ ...base, response: 'All done.' }), 'All done.');
	});

	// A summary is read on a phone; a wall of code helps nobody there.
	it('drops fenced code, which would eat the whole budget', () => {
		const summary = summariseTurn({
			...base,
			response: 'Fixed it.\n```ts\nconst x = 1;\n```\nTests pass.'
		});

		assert.doesNotMatch(summary, /const x/);
		assert.match(summary, /Fixed it/);
		assert.match(summary, /Tests pass/);
	});

	it('drops tables, which read as noise without their columns', () => {
		const summary = summariseTurn({ ...base, response: 'Results:\n| a | b |\n| - | - |\nDone.' });

		assert.doesNotMatch(summary, /\|/);
	});

	it('cuts a long answer at a sentence end rather than mid-word', () => {
		const response = `${'This is a complete sentence. '.repeat(40)}`;

		const summary = summariseTurn({ ...base, response }, 200);

		assert.ok(summary.length <= 201, 'must respect the budget');
		assert.ok(summary.endsWith('\u2026'), 'and say that it was cut');
		assert.ok(!/\bsenten\u2026/.test(summary), 'but not stop mid-word');
	});

	// Tool-only turns are real, and saying nothing about them would look like a failure.
	it('says so when an answer carried no prose', () => {
		const summary = summariseTurn({ ...base, response: '' });

		assert.match(summary, /without prose/i);
		assert.match(summary, /VS Code/, 'and points at where the answer actually is');
	});
});
