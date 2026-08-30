import * as fs from 'fs';
import { classifyReport, parseIssueBody, REPORT_LABEL } from '../../domain/problemReport';

/**
 * The triage workflow's entry point.
 *
 * Reads the issue GitHub Actions was triggered by, decides what it is about, and writes the
 * verdict to a file the workflow then applies with `gh`. Splitting it this way keeps the
 * decision in TypeScript — where {@link classifyReport} is unit-tested — and leaves the
 * workflow doing nothing but plumbing. Rules embedded in YAML are rules that are only ever
 * exercised by filing a real issue, and that fail silently in a log nobody opens.
 *
 * It deliberately cannot label an issue it does not recognise: a body without the report
 * marker produces `recognised: false` and the workflow stops there, so hand-written issues
 * are never relabelled by a classifier that has only ever seen machine-written input.
 */

interface IssueEvent {
	issue?: { number?: number; body?: string; labels?: ({ name?: string } | string)[] };
}

export interface TriageOutput {
	recognised: boolean;
	number?: number;
	labels: string[];
	comment?: string;
}

export function triage(event: IssueEvent): TriageOutput {
	const issue = event.issue;
	if (!issue?.number) {
		return { recognised: false, labels: [] };
	}

	const parsed = parseIssueBody(issue.body ?? '');
	if (!parsed) {
		return { recognised: false, number: issue.number, labels: [] };
	}

	const verdict = classifyReport(parsed);
	const existing = new Set(
		(issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean)
	);
	const labels = [REPORT_LABEL, ...verdict.labels].filter((label) => !existing.has(label));

	const comment = [
		verdict.summary,
		'',
		...verdict.notes.map((note) => `- ${note}`),
		'',
		'_Filed by the `Teams Bridge: Report a Problem` command and triaged automatically. '
			+ 'No code has been changed and nothing has been closed._'
	].join('\n');

	return { recognised: true, number: issue.number, labels, comment };
}

// The Actions wrapper. Exercised by the workflow itself; the decision it delegates to is
// what the unit tests cover.
if (require.main === module) {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	const output: TriageOutput = eventPath
		? triage(JSON.parse(fs.readFileSync(eventPath, 'utf8')) as IssueEvent)
		: { recognised: false, labels: [] };
	fs.writeFileSync(process.env.TRIAGE_OUTPUT ?? 'triage.json', JSON.stringify(output, null, 2), 'utf8');
	console.log(`triage: recognised=${output.recognised} labels=${output.labels.join(',') || 'none'}`);
}
