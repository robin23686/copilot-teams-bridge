import * as assert from 'assert';
import { describe, it } from 'node:test';
import {
	AREA_LABELS,
	MAX_URL_BODY_CHARS,
	NEEDS_INFO_LABEL,
	REPORT_LABEL,
	REPORT_MARKER,
	TRIAGE_LABEL,
	buildProblemReport,
	classifyReport,
	issueTitleFor,
	issueUrlFor,
	labelsFor,
	parseIssueBody,
	redactText,
	renderIssueBody,
	repositorySlugFrom,
	selectLogLines,
	truncateBody,
	type ParsedReport,
	type ProblemReportInput
} from '../src/domain/problemReport';import { triage } from '../src/hosts/actions/triageIssue';

/**
 * The issue body is a contract between the command that writes it and the automation that
 * reads it, so both directions are tested here together. Asserting only the rendering would
 * let the parser drift until triage silently stopped recognising its own output.
 */

const input: ProblemReportInput = {
	title: 'Reply landed in the wrong chat',
	description: 'I replied in Teams and the instruction appeared in a different conversation.',
	reproSteps: ['Open two chats', 'Ask a question from the first', 'Reply in Teams'],
	area: 'reply-routing',
	includeSessionTitles: false,
	environment: {
		extensionVersion: '1.1.0',
		vscodeVersion: '1.106.2',
		platform: 'win32 x64',
		transport: 'agency',
		teamsConfigured: true,
		sessionCount: 2,
		listening: true
	},
	hosts: [
		{ name: 'copilotTeamsBridge_notify', available: true, detail: 'VS Code extension host' },
		{ name: 'teams_notify', available: false, detail: 'bundled MCP server' }
	],
	routing: 'My task\n    harness  vscode-sidebar',
	logTail: ['[route] outcome=delivered session="My task" reply=1788027804030'],
	stateFiles: [{ name: 'sessions.json', exists: true, bytes: 4096 }]
};

describe('redactText', () => {
	it('replaces the home directory, including its JSON-escaped spelling', () => {
		const redacted = redactText(
			'read C:\\Users\\robgup\\.copilot and "C:\\\\Users\\\\robgup\\\\logs"',
			{ homeDir: 'C:\\Users\\robgup' }
		);
		assert.ok(!redacted.includes('robgup'), `username survived: ${redacted}`);
		assert.ok(redacted.includes('~'), 'the path should be shortened rather than dropped');
	});

	it('removes the username even when it appears outside a path', () => {
		assert.strictEqual(redactText('user=robgup', { userName: 'robgup' }), 'user=<user>');
	});

	// A channel id looks enough like an email address that a naive ordering hides which
	// kind of identifier was there -- which is exactly the fact a reader needs.
	it('names a Teams channel id as a channel id, not an email address', () => {
		const redacted = redactText('thread 19:abc123def@thread.tacv2 posted');
		assert.ok(redacted.includes('<channelId>'), redacted);
		assert.ok(!redacted.includes('<email>'), 'the email rule must not claim it first');
	});

	it('removes email addresses', () => {
		assert.ok(redactText('from rob.gupta@contoso.com').includes('<email>'));
	});

	it('shortens chat identities instead of deleting them, so two chats stay distinguishable', () => {
		const redacted = redactText(
			'a=vscode-chat-session://local/MmVkOWEyNTgtZmZmZi00 b=vscode-chat-session://local/OTk5OTk5OTktMDAwMC0w'
		);
		assert.ok(redacted.includes('MmVkOWEy…'), redacted);
		assert.ok(redacted.includes('OTk5OTk5…'), redacted);
		assert.notStrictEqual(
			redacted.split('local/')[1],
			redacted.split('local/')[2],
			'two different chats must not redact to the same string'
		);
	});

	it('shortens bare GUIDs, which are how team ids reach the log', () => {
		assert.strictEqual(
			redactText('team 3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
			'team 3f2504e0…'
		);
	});

	it('removes configured ids given to it literally', () => {
		assert.ok(!redactText('channel=SOMESECRETID', { secrets: ['SOMESECRETID'] }).includes('SOMESECRETID'));
	});

	// Guards against a short or empty setting turning every occurrence of a common
	// substring into a placeholder, which would shred the log it was meant to protect.
	it('ignores secrets and names too short to be identifying', () => {
		assert.strictEqual(redactText('a and b', { secrets: ['a'], userName: 'b' }), 'a and b');
	});
});

describe('buildProblemReport', () => {
	it('redacts every field once, at construction', () => {
		const report = buildProblemReport(
			{ ...input, title: 'crash in C:\\Users\\robgup', logTail: ['user rob@x.com'], reproSteps: ['open C:\\Users\\robgup'] },
			{ homeDir: 'C:\\Users\\robgup' }
		);
		assert.ok(!report.title.includes('robgup'));
		assert.ok(!report.reproSteps[0].includes('robgup'));
		assert.ok(report.logTail[0].includes('<email>'));
	});

	it('drops blank reproduction steps rather than numbering them', () => {
		const report = buildProblemReport({ ...input, reproSteps: ['one', '   ', 'two'] });
		assert.deepStrictEqual(report.reproSteps, ['one', 'two']);
	});
});

describe('selectLogLines', () => {
	it('returns everything when it already fits', () => {
		assert.deepStrictEqual(selectLogLines(['a', 'b'], 10), ['a', 'b']);
	});

	// Taking the newest N loses the [route] line, because a delivery is followed by a burst
	// of routine polling that pushes it straight out of the window.
	it('keeps an older route line that the tail would have dropped', () => {
		const lines = ['[route] outcome=unroutable', ...Array.from({ length: 200 }, (_, i) => `poll ${i}`)];
		const kept = selectLogLines(lines, 20);
		assert.ok(kept.some((line) => line.includes('[route]')), kept.slice(0, 3).join('\n'));
		assert.ok(kept.some((line) => line.includes('earlier lines omitted')));
		assert.ok(kept[kept.length - 1].includes('poll 199'), 'the newest line must still be last');
	});

	it('stays within the budget', () => {
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		assert.ok(selectLogLines(lines, 40).length <= 40);
	});
});

describe('renderIssueBody', () => {
	const body = renderIssueBody(buildProblemReport(input));

	it('marks the body as machine-written', () => {
		assert.ok(body.startsWith(REPORT_MARKER));
	});

	it('carries what the user wrote and what was collected', () => {
		assert.ok(body.includes('I replied in Teams'));
		assert.ok(body.includes('1. Open two chats'));
		assert.ok(body.includes('1.106.2'));
		assert.ok(body.includes('outcome=delivered'));
		assert.ok(body.includes('NOT callable'), 'an uncallable notify host is the headline fact');
	});

	it('says so when there was no log, rather than leaving an empty section', () => {
		assert.ok(renderIssueBody(buildProblemReport({ ...input, logTail: [] })).includes('No log was found'));
	});
});

describe('labels', () => {
	it('always identifies itself and asks for triage', () => {
		const labels = labelsFor(buildProblemReport(input));
		assert.ok(labels.includes(REPORT_LABEL));
		assert.ok(labels.includes(TRIAGE_LABEL));
		assert.ok(labels.includes(AREA_LABELS['reply-routing']));
	});

	it('shortens an over-long title instead of letting the API reject it', () => {
		const title = issueTitleFor(buildProblemReport({ ...input, title: 'x'.repeat(300) }));
		assert.ok(title.length <= 120);
		assert.ok(title.endsWith('…'));
	});
});

describe('parseIssueBody', () => {
	it('reads back what it wrote', () => {
		const parsed = parseIssueBody(renderIssueBody(buildProblemReport(input)));
		assert.ok(parsed, 'its own output must be recognised');
		assert.strictEqual(parsed.area, 'reply-routing');
		assert.strictEqual(parsed.meta.extensionVersion, '1.1.0');
		assert.strictEqual(parsed.reproSteps, 3);
		assert.strictEqual(parsed.hostsUnavailable, 1);
		assert.deepStrictEqual(parsed.routeOutcomes, ['delivered']);
		assert.ok(parsed.description.includes('I replied in Teams'));
	});

	// Without the marker check the classifier would relabel hand-written issues using rules
	// it was only ever shown machine-written input for.
	it('refuses a body it did not write', () => {
		assert.strictEqual(parseIssueBody('The bridge is broken, please help.'), undefined);
	});

	it('falls back to an unsorted area when the metadata is damaged', () => {
		const parsed = parseIssueBody(`${REPORT_MARKER}\n\n## What happened\n\nx\n\n\`\`\`report-meta\narea: nonsense\n\`\`\``);
		assert.strictEqual(parsed?.area, 'other');
	});
});

describe('classifyReport', () => {
	const parse = (report: ProblemReportInput): ParsedReport => {
		const parsed = parseIssueBody(renderIssueBody(buildProblemReport(report)));
		assert.ok(parsed);
		return parsed;
	};

	it('reads the delivery outcome and points at the identity that was recorded', () => {
		const verdict = classifyReport(parse({ ...input, logTail: ['[route] outcome=unroutable session="x"'] }));
		assert.ok(verdict.labels.includes(AREA_LABELS['reply-routing']));
		assert.ok(verdict.notes.some((note) => note.includes('unroutable')));
	});

	// The "tool is disabled" confusion is answerable in one line, and this is that line.
	it('sends an uncallable notification host to setup rather than to the bridge', () => {
		const verdict = classifyReport(parse(input));
		assert.ok(verdict.labels.includes(AREA_LABELS.setup));
		assert.ok(verdict.notes.some((note) => note.includes('allowlist')));
	});

	it('asks for more when there is no log to read', () => {
		const verdict = classifyReport(parse({ ...input, logTail: [] }));
		assert.ok(verdict.labels.includes(NEEDS_INFO_LABEL));
		assert.ok(verdict.summary.includes('missing evidence'));
	});

	it('does not ask for more when the report is complete', () => {
		const verdict = classifyReport(parse({ ...input, hosts: [{ name: 'copilotTeamsBridge_notify', available: true }] }));
		assert.ok(!verdict.labels.includes(NEEDS_INFO_LABEL), verdict.notes.join('; '));
	});
});

describe('truncateBody', () => {
	it('leaves a body that fits alone', () => {
		assert.strictEqual(truncateBody('short', 100), 'short');
	});

	it('cuts at a line boundary and points at the saved copy', () => {
		const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
		const cut = truncateBody(body, 400, 'C:\\reports\\report.md');
		assert.ok(cut.length <= 400, `budget exceeded: ${cut.length}`);
		assert.ok(cut.includes('report.md'), 'the rest has to be findable');
		assert.ok(!/line \d+_Truncated/.test(cut), 'it must not cut mid-line');
	});
});

describe('issueUrlFor', () => {
	it('builds a prefilled url within the fallback budget', () => {
		const report = buildProblemReport({ ...input, savedTo: 'C:\\reports\\r.md' });
		const url = issueUrlFor('robin23686/copilot-teams-bridge', report, renderIssueBody(report).repeat(20));
		assert.ok(url.startsWith('https://github.com/robin23686/copilot-teams-bridge/issues/new?'));
		const body = new URL(url).searchParams.get('body') ?? '';
		assert.ok(body.length <= MAX_URL_BODY_CHARS, `body was ${body.length}`);
		assert.strictEqual(new URL(url).searchParams.get('labels'), labelsFor(report).join(','));
	});
});

describe('repositorySlugFrom', () => {
	it('reads the slug out of the forms package.json uses', () => {
		for (const url of [
			'https://github.com/robin23686/copilot-teams-bridge.git',
			'https://github.com/robin23686/copilot-teams-bridge',
			'git@github.com:robin23686/copilot-teams-bridge.git'
		]) {
			assert.strictEqual(repositorySlugFrom(url), 'robin23686/copilot-teams-bridge', url);
		}
	});

	it('returns nothing rather than a guess when it cannot tell', () => {
		assert.strictEqual(repositorySlugFrom('https://example.com/x'), undefined);
		assert.strictEqual(repositorySlugFrom(undefined), undefined);
	});
});

describe('triage entry point', () => {
	const body = renderIssueBody(buildProblemReport(input));

	it('labels and comments on a report it recognises', () => {
		const output = triage({ issue: { number: 7, body } });
		assert.strictEqual(output.recognised, true);
		assert.strictEqual(output.number, 7);
		assert.ok(output.labels.includes(REPORT_LABEL));
		assert.ok(output.comment?.includes('Automated triage'));
		assert.ok(output.comment?.includes('nothing has been closed'), 'the comment must say what it did not do');
	});

	it('leaves a hand-written issue completely alone', () => {
		const output = triage({ issue: { number: 8, body: 'it broke' } });
		assert.strictEqual(output.recognised, false);
		assert.deepStrictEqual(output.labels, []);
		assert.strictEqual(output.comment, undefined);
	});

	// Re-running triage on a reopened issue must not stack duplicate labels.
	it('does not re-apply labels the issue already carries', () => {
		const output = triage({ issue: { number: 9, body, labels: [{ name: REPORT_LABEL }, 'area:reply-routing'] } });
		assert.ok(!output.labels.includes(REPORT_LABEL));
		assert.ok(!output.labels.includes('area:reply-routing'));
	});

	it('ignores an event with no issue in it', () => {
		assert.deepStrictEqual(triage({}), { recognised: false, labels: [] });
	});
});
