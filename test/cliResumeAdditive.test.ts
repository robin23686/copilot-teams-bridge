import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	canResumeCliSession,
	deliverableHarnesses,
	replyReachability,
	repliesReachChat,
	worthRetrying
} from '../src/application/services/harness';
import { cliSessionIdFromEnv } from '../src/hosts/mcp/harnessEnv';
import type { HarnessKind, SessionIdentity } from '../src/domain/types';

const HARNESSES: readonly HarnessKind[] = [
	'vscode-sidebar',
	'vscode-agent-mcp',
	'cli-runtime',
	'external',
	'unknown'
];

const CONFIDENCES: readonly SessionIdentity['confidence'][] = ['exact', 'derived', 'unknown'];

const CLI_ID = 'a9e68183-1fcb-49ab-a252-edbadc5403f4';

function identity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
	return {
		harness: 'cli-runtime',
		confidence: 'exact',
		capturedBy: 'mcp-ingest',
		capturedAt: '2026-08-29T10:00:00.000Z',
		...overrides
	};
}

/**
 * The behaviour these tests pin is "nothing changed unless you opted in".
 *
 * CLI resume was added by threading an optional argument through the routing predicates.
 * An optional argument is only additive if every existing caller -- none of which pass it --
 * gets exactly the answer it got before. That is not self-evident from reading the code, so
 * it is asserted here across the whole input space rather than spot-checked.
 */
describe('CLI resume is additive', () => {
	it('reports no CLI session as resumable when the caller says nothing', () => {
		for (const harness of HARNESSES) {
			for (const confidence of CONFIDENCES) {
				assert.equal(
					canResumeCliSession(identity({ harness, confidence, cliSessionId: CLI_ID })),
					false,
					`${harness}/${confidence} must not be resumable by default`
				);
			}
		}
	});

	it('needs the opt-in and a recorded id together, never one alone', () => {
		const both = identity({ cliSessionId: CLI_ID });
		assert.equal(canResumeCliSession(both, { cliResumeEnabled: true }), true);

		assert.equal(
			canResumeCliSession(identity({ cliSessionId: undefined }), { cliResumeEnabled: true }),
			false,
			'an opt-in without a recorded id would resume nothing'
		);
		assert.equal(
			canResumeCliSession(both, { cliResumeEnabled: false }),
			false,
			'a recorded id without the opt-in must stay inert'
		);
		assert.equal(
			canResumeCliSession(both, {}),
			false,
			'an options object that omits the flag is not an opt-in'
		);
	});

	it('never treats a non-CLI harness as resumable, even with an id somehow recorded', () => {
		for (const harness of HARNESSES.filter((kind) => kind !== 'cli-runtime')) {
			assert.equal(
				canResumeCliSession(identity({ harness, cliSessionId: CLI_ID }), { cliResumeEnabled: true }),
				false,
				`${harness} is not resumed by the CLI`
			);
		}
	});

	it('answers reachability identically with the flag off and with no options at all', () => {
		for (const harness of HARNESSES) {
			for (const confidence of CONFIDENCES) {
				for (const cliSessionId of [undefined, CLI_ID]) {
					const subject = identity({ harness, confidence, cliSessionId });
					const legacy = replyReachability(subject);
					assert.equal(
						replyReachability(subject, { cliResumeEnabled: false }),
						legacy,
						`${harness}/${confidence}/id=${Boolean(cliSessionId)} changed when the flag was passed as false`
					);
					assert.equal(
						replyReachability(subject, {}),
						legacy,
						`${harness}/${confidence}/id=${Boolean(cliSessionId)} changed when empty options were passed`
					);
				}
			}
		}
	});

	it('keeps every pre-existing reachability answer exactly as it was', () => {
		// Written out rather than computed, so a change to the rules has to be a change to
		// this table too -- which is the point at which someone has to justify it.
		assert.equal(replyReachability(identity({ harness: 'vscode-sidebar' })), 'yes');
		assert.equal(replyReachability(identity({ harness: 'vscode-agent-mcp' })), 'yes');
		assert.equal(replyReachability(identity({ harness: 'vscode-sidebar', confidence: 'unknown' })), 'no');
		assert.equal(replyReachability(identity({ harness: 'cli-runtime' })), 'no');
		assert.equal(replyReachability(identity({ harness: 'external' })), 'no');
		assert.equal(replyReachability(identity({ harness: 'unknown', confidence: 'unknown' })), 'unknown');
	});

	it('changes a CLI session from unreachable to reachable only once opted in', () => {
		const subject = identity({ cliSessionId: CLI_ID });
		assert.equal(replyReachability(subject), 'no');
		assert.equal(repliesReachChat(subject), false);

		assert.equal(replyReachability(subject, { cliResumeEnabled: true }), 'yes');
		assert.equal(repliesReachChat(subject, { cliResumeEnabled: true }), true);
	});

	it('leaves a CLI session with no recorded id unreachable even when opted in', () => {
		// The footer must not invite a reply that has no route: an opted-in user with an
		// older session record is exactly the case that would otherwise be promised
		// delivery and silently held.
		const subject = identity({ cliSessionId: undefined });
		assert.equal(replyReachability(subject, { cliResumeEnabled: true }), 'no');
	});

	it('does not start retaining replies for CLI sessions until they can be resumed', () => {
		const subject = identity({ cliSessionId: CLI_ID });
		assert.equal(worthRetrying('unroutable', subject), false, 'unchanged by default');
		assert.equal(worthRetrying('unroutable', subject, { cliResumeEnabled: true }), true);
		assert.equal(
			worthRetrying('unroutable', identity({ cliSessionId: undefined }), { cliResumeEnabled: true }),
			false,
			'nothing to resume, so retaining it forever would be a lie'
		);
	});
});

/**
 * The set that decides the footer on every message.
 *
 * Adding `cli-runtime` here was the obvious way to implement resume, and it is the trap:
 * the set is harness-wide, so it would have promised a route for every CLI session --
 * including those with no id and users who never opted in. That is the same fault as the
 * agent-MCP regression. This test exists to make that mistake fail loudly.
 */
describe('the deliverable-harness set stays a statement about harnesses', () => {
	it('does not claim cli-runtime, whose reachability is per session', () => {
		assert.equal(
			deliverableHarnesses.has('cli-runtime'),
			false,
			'cli-runtime reachability depends on a recorded id and an opt-in, so it cannot be declared here'
		);
	});

	it('still claims exactly the two chat-backed harnesses', () => {
		assert.deepEqual([...deliverableHarnesses].sort(), ['vscode-agent-mcp', 'vscode-sidebar']);
	});
});

describe('reading the CLI session id from the environment', () => {
	it('accepts the id shape the CLI actually exports', () => {
		assert.equal(cliSessionIdFromEnv(CLI_ID), CLI_ID);
		assert.equal(cliSessionIdFromEnv(`  ${CLI_ID}  `), CLI_ID, 'surrounding whitespace is not part of the id');
		assert.equal(cliSessionIdFromEnv(CLI_ID.toUpperCase()), CLI_ID.toUpperCase());
	});

	it('refuses anything that is not an id', () => {
		for (const value of [undefined, '', '   ', 'not-a-uuid', CLI_ID.slice(0, -1), `${CLI_ID}x`]) {
			assert.equal(cliSessionIdFromEnv(value), undefined, `must refuse ${JSON.stringify(value)}`);
		}
	});

	it('refuses a value carrying shell metacharacters', () => {
		// The id is handed to a spawn. Accepting only the CLI's own shape is what keeps a
		// hostile environment from turning an id into an argument.
		for (const value of [`${CLI_ID} --allow-all-tools`, `${CLI_ID};whoami`, `--help`, `$(whoami)`]) {
			assert.equal(cliSessionIdFromEnv(value), undefined, `must refuse ${JSON.stringify(value)}`);
		}
	});
});
