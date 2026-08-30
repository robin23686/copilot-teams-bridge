/**
 * Turning a problem into something that can actually be answered.
 *
 * The existing advice — read the log, find the `[route]` line, name the surface, check it
 * for anything private — asks the user to do the diagnosis before they are allowed to
 * report it. The steps most often skipped are the two that decide whether a report can be
 * acted on at all, so the report is assembled here instead, from facts the extension
 * already holds.
 *
 * Everything in this module is pure: it takes collected facts and returns text, and it
 * parses that same text back into facts. Both directions live together on purpose. The
 * issue body is a contract between the command that writes it and the automation that
 * reads it, and a contract asserted from only one side is one that drifts silently.
 */

/** Which part of the bridge the user thinks is at fault. Drives the area label. */
export type ProblemArea =
	/** Nothing arrives in Teams, or arrives wrong. */
	| 'teams-delivery'
	/** A Teams reply did not reach Copilot, or reached the wrong chat. */
	| 'reply-routing'
	/** Threads, sessions, duplicates, expiry. */
	| 'sessions'
	/** Install, sign-in, configuration, the notify tool not being callable. */
	| 'setup'
	| 'other';

export const AREA_LABELS: Record<ProblemArea, string> = {
	'teams-delivery': 'area:teams-delivery',
	'reply-routing': 'area:reply-routing',
	sessions: 'area:sessions',
	setup: 'area:setup',
	other: 'area:unsorted'
};

export const AREA_TITLES: Record<ProblemArea, string> = {
	'teams-delivery': 'Messages to Teams',
	'reply-routing': 'Replies back into Copilot',
	sessions: 'Sessions and threads',
	setup: 'Setup and configuration',
	other: 'Something else'
};

/** The label every automatically assembled report carries, and automation keys on. */
export const REPORT_LABEL = 'auto-report';
export const TRIAGE_LABEL = 'needs-triage';
/** Applied when the report is missing the evidence needed to answer it. */
export const NEEDS_INFO_LABEL = 'needs-info';

/** Marks a body as machine-written, so hand-filed issues are left alone. */
export const REPORT_MARKER = '<!-- copilot-teams-bridge:report v1 -->';
/** The fenced block holding the parsable facts. */
const META_FENCE = 'report-meta';

/** GitHub rejects a body over 65536 characters; stay clear of the edge. */
export const MAX_ISSUE_BODY_CHARS = 60_000;
/**
 * How much body survives the browser fallback.
 *
 * A prefilled `issues/new` URL is subject to whatever the browser and the server accept,
 * and the failure mode is a truncated or rejected navigation rather than an error — so the
 * budget is set well below any of the limits in play and the rest is left in the saved file.
 */
export const MAX_URL_BODY_CHARS = 6_000;

/** What the extension knows about the machine, none of it asked for. */
export interface EnvironmentFacts {
	extensionVersion: string;
	vscodeVersion: string;
	platform: string;
	nodeVersion?: string;
	/** `agency` or `file`; a file-transport report explains a lot on its own. */
	transport?: string;
	/** Whether a team and channel are configured at all. Not their values. */
	teamsConfigured?: boolean;
	sessionCount?: number;
	listening?: boolean;
}

/** Whether a notification surface can actually be called, which is its own class of bug. */
export interface HostAvailability {
	name: string;
	available: boolean;
	detail?: string;
}

/** A state file's existence and size. Never its contents. */
export interface StateFileFact {
	name: string;
	exists: boolean;
	bytes?: number;
}

/** What the user typed plus what was collected around them. */
export interface ProblemReportInput {
	title: string;
	description: string;
	reproSteps: string[];
	area: ProblemArea;
	/** Session titles are the user's own words, so they are opt in rather than opt out. */
	includeSessionTitles: boolean;
	environment: EnvironmentFacts;
	hosts: HostAvailability[];
	/** Output of the routing description, or a note saying why there was none. */
	routing?: string;
	logTail: string[];
	stateFiles: StateFileFact[];
	/** Where the full copy was saved, so a truncated submission can point at it. */
	savedTo?: string;
}

/** A report after redaction, ready to render. Identical shape, safer contents. */
export interface ProblemReport extends ProblemReportInput {
	createdAt: string;
}

export interface RedactionOptions {
	homeDir?: string;
	userName?: string;
	/**
	 * Literal strings that must never appear — the configured team and channel ids.
	 *
	 * Matched literally rather than by pattern because these are known exactly, and a
	 * pattern that is nearly right is how an identifier escapes.
	 */
	secrets?: string[];
}

/**
 * Removes the things a user should not have to notice they were about to publish.
 *
 * Order is load-bearing. Channel ids look enough like email addresses that the email rule
 * would claim them first and hide which kind of identifier was there, so the specific
 * patterns run before the general ones.
 */
export function redactText(text: string, options: RedactionOptions = {}): string {
	if (!text) {
		return '';
	}
	let out = text;

	for (const secret of options.secrets ?? []) {
		const trimmed = secret.trim();
		if (trimmed.length >= 6) {
			out = replaceAll(out, trimmed, '<configured-id>');
		}
	}

	const home = options.homeDir?.trim();
	if (home && home.length >= 3) {
		// A path can reach the log JSON-escaped, so the escaped spelling has to go too --
		// otherwise redaction looks like it worked while the doubled form sails through.
		out = replaceAll(out, home.replace(/\\/g, '\\\\'), '~');
		out = replaceAll(out, home, '~');
		out = replaceAll(out, home.replace(/\\/g, '/'), '~');
	}

	// Teams identifiers, before the email rule can mistake them for addresses.
	out = out.replace(/19:[^\s"'<>]+@thread\.[a-z0-9]+/gi, '<channelId>');
	out = out.replace(/\b(teamId|channelId)\b(\s*[=:]\s*)("?)[^\s",}]+\3/gi, '$1$2<redacted>');

	out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, '<email>');

	// Chat identities are long opaque blobs. The first few characters are enough to tell
	// two chats apart in one report, which is all a reader ever needs them for.
	out = out.replace(
		/((?:vscode-chat-session|agent-host-copilotcli|agent-host-[a-z0-9-]+):\/\/[^\s/"']*\/)([A-Za-z0-9+/=_-]{9,})/g,
		(_match, prefix: string, id: string) => `${prefix}${id.slice(0, 8)}…`
	);
	out = out.replace(
		/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
		(id) => `${id.slice(0, 8)}…`
	);

	const user = options.userName?.trim();
	if (user && user.length >= 3) {
		out = replaceAll(out, user, '<user>');
	}

	return out;
}

/**
 * Applies redaction across every field, so nothing depends on remembering to call it.
 *
 * Redacting at render time was the obvious alternative and the wrong one: the report is
 * also written to disk and shown in an editor, and each of those would then need its own
 * reminder. Redacting once, at construction, means an unredacted report never exists.
 */
export function buildProblemReport(
	input: ProblemReportInput,
	options: RedactionOptions = {},
	now: Date = new Date()
): ProblemReport {
	const clean = (value: string): string => redactText(value, options);
	return {
		...input,
		title: clean(input.title).trim(),
		description: clean(input.description).trim(),
		reproSteps: input.reproSteps.map(clean).map((step) => step.trim()).filter(Boolean),
		routing: input.routing ? clean(input.routing) : undefined,
		logTail: input.logTail.map(clean),
		hosts: input.hosts.map((host) => ({ ...host, detail: host.detail ? clean(host.detail) : undefined })),
		savedTo: input.savedTo ? clean(input.savedTo) : undefined,
		createdAt: now.toISOString()
	};
}

/**
 * Keeps the log lines worth reading when there are more than will fit.
 *
 * Taking the newest N is the naive answer and it loses the `[route]` line, because a
 * delivery decision is usually followed by a burst of routine polling that pushes it out of
 * the window. So a slice of the budget is reserved for the interesting older lines.
 */
export function selectLogLines(lines: string[], maxLines: number): string[] {
	if (maxLines <= 0) {
		return [];
	}
	if (lines.length <= maxLines) {
		return [...lines];
	}

	const reserve = Math.floor(maxLines / 4);
	const tailSize = Math.max(1, maxLines - reserve - 1);
	const tail = lines.slice(lines.length - tailSize);
	const dropped = lines.slice(0, lines.length - tailSize);
	const salvaged = reserve > 0 ? dropped.filter(isInteresting).slice(-reserve) : [];

	return [...salvaged, `… ${dropped.length - salvaged.length} earlier lines omitted …`, ...tail];
}

function isInteresting(line: string): boolean {
	return /\[route\]|\[selftest\]|\[probe\]|\berror\b|\bwarn(ing)?\b|failed/i.test(line);
}

export function issueTitleFor(report: ProblemReport): string {
	const title = report.title.trim() || 'Problem report';
	return title.length > 120 ? `${title.slice(0, 117)}…` : title;
}

export function labelsFor(report: ProblemReport): string[] {
	return [REPORT_LABEL, TRIAGE_LABEL, AREA_LABELS[report.area] ?? AREA_LABELS.other];
}

/** Renders the issue body: prose for a human, a fenced block for the automation. */
export function renderIssueBody(report: ProblemReport): string {
	const sections: string[] = [REPORT_MARKER, ''];

	sections.push(`**Area:** ${AREA_TITLES[report.area] ?? AREA_TITLES.other}`, '');
	sections.push('## What happened', '', report.description || '_Not described._', '');

	if (report.reproSteps.length > 0) {
		sections.push('## Steps to reproduce', '');
		report.reproSteps.forEach((step, index) => sections.push(`${index + 1}. ${step}`));
		sections.push('');
	}

	sections.push('## Environment', '');
	sections.push('| | |', '|---|---|');
	for (const [key, value] of environmentRows(report)) {
		sections.push(`| ${key} | ${value} |`);
	}
	sections.push('');

	if (report.hosts.length > 0) {
		sections.push('## Notification hosts', '');
		for (const host of report.hosts) {
			const state = host.available ? 'callable' : 'NOT callable';
			sections.push(`- \`${host.name}\` — ${state}${host.detail ? ` (${host.detail})` : ''}`);
		}
		sections.push('');
	}

	if (report.routing) {
		sections.push('## How replies would be routed', '', '```', report.routing.trimEnd(), '```', '');
	}

	if (report.stateFiles.length > 0) {
		sections.push('## State files', '');
		for (const file of report.stateFiles) {
			sections.push(`- \`${file.name}\` — ${file.exists ? `${file.bytes ?? 0} bytes` : 'absent'}`);
		}
		sections.push('');
	}

	if (report.logTail.length > 0) {
		sections.push(`## Log (last ${report.logTail.length} lines)`, '', '```log', ...report.logTail, '```', '');
	} else {
		sections.push('## Log', '', '_No log was found on disk._', '');
	}

	sections.push('```' + META_FENCE);
	for (const [key, value] of metaRows(report)) {
		sections.push(`${key}: ${value}`);
	}
	sections.push('```');

	return sections.join('\n');
}

function environmentRows(report: ProblemReport): [string, string][] {
	const environment = report.environment;
	const rows: [string, string][] = [
		['Extension', environment.extensionVersion],
		['VS Code', environment.vscodeVersion],
		['Platform', environment.platform]
	];
	if (environment.nodeVersion) {
		rows.push(['Node', environment.nodeVersion]);
	}
	if (environment.transport) {
		rows.push(['Transport', environment.transport]);
	}
	if (environment.teamsConfigured !== undefined) {
		rows.push(['Team and channel set', environment.teamsConfigured ? 'yes' : 'no']);
	}
	if (environment.sessionCount !== undefined) {
		rows.push(['Active sessions', String(environment.sessionCount)]);
	}
	if (environment.listening !== undefined) {
		rows.push(['Listening for replies', environment.listening ? 'yes' : 'no']);
	}
	return rows;
}

function metaRows(report: ProblemReport): [string, string][] {
	const rows: [string, string][] = [
		['version', '1'],
		['area', report.area],
		['extensionVersion', report.environment.extensionVersion],
		['vscodeVersion', report.environment.vscodeVersion],
		['platform', report.environment.platform],
		['createdAt', report.createdAt],
		['logLines', String(report.logTail.length)],
		['reproSteps', String(report.reproSteps.length)],
		['hostsUnavailable', String(report.hosts.filter((host) => !host.available).length)],
		['sessionTitles', report.includeSessionTitles ? 'included' : 'withheld']
	];
	if (report.environment.transport) {
		rows.push(['transport', report.environment.transport]);
	}
	if (report.environment.sessionCount !== undefined) {
		rows.push(['sessionCount', String(report.environment.sessionCount)]);
	}
	return rows;
}

/** The facts recovered from an issue body. The automation's whole input. */
export interface ParsedReport {
	meta: Record<string, string>;
	area: ProblemArea;
	description: string;
	logLines: string[];
	/** Outcomes named on any `[route]` line, which is the fastest read of a delivery bug. */
	routeOutcomes: string[];
	hostsUnavailable: number;
	reproSteps: number;
}

/**
 * Reads a report back out of an issue body.
 *
 * Returns undefined for anything without the marker, so a hand-written issue is never
 * relabelled by a classifier that was only ever shown machine-written input.
 */
export function parseIssueBody(body: string): ParsedReport | undefined {
	if (!body || !body.includes(REPORT_MARKER)) {
		return undefined;
	}

	const meta: Record<string, string> = {};
	const metaBlock = new RegExp('```' + META_FENCE + '\\r?\\n([\\s\\S]*?)```').exec(body);
	for (const line of (metaBlock?.[1] ?? '').split(/\r?\n/)) {
		const match = /^([A-Za-z][\w.-]*)\s*:\s*(.*)$/.exec(line.trim());
		if (match) {
			meta[match[1]] = match[2].trim();
		}
	}

	const logBlock = /```log\r?\n([\s\S]*?)```/.exec(body);
	const logLines = (logBlock?.[1] ?? '')
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);

	const routeOutcomes = [...body.matchAll(/\[route\][^\n]*?outcome=([a-z]+)/g)].map((match) => match[1]);

	return {
		meta,
		area: isArea(meta.area) ? meta.area : 'other',
		description: sectionOf(body, 'What happened'),
		logLines,
		routeOutcomes,
		hostsUnavailable: toNumber(meta.hostsUnavailable),
		reproSteps: toNumber(meta.reproSteps)
	};
}

function sectionOf(body: string, heading: string): string {
	const pattern = new RegExp(`##\\s+${heading}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)`);
	return (pattern.exec(body)?.[1] ?? '').trim();
}

function isArea(value: string | undefined): value is ProblemArea {
	return value !== undefined && value in AREA_LABELS;
}

function toNumber(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** What triage concluded, as data, so the workflow only has to apply it. */
export interface TriageVerdict {
	labels: string[];
	/** One line for the issue's first comment. */
	summary: string;
	/** What a maintainer should look at, or what is missing. */
	notes: string[];
}

/**
 * A first pass over a report, before a human reads it.
 *
 * Kept pure and in the domain layer because rules that live in a workflow file are rules
 * nobody tests: they are exercised only by filing a real issue, and they fail silently in a
 * log nobody opens.
 */
export function classifyReport(parsed: ParsedReport): TriageVerdict {
	const labels = new Set<string>([AREA_LABELS[parsed.area]]);
	const notes: string[] = [];

	if (parsed.routeOutcomes.length > 0) {
		const outcome = parsed.routeOutcomes[parsed.routeOutcomes.length - 1];
		notes.push(`Last delivery outcome was \`${outcome}\`.`);
		if (outcome === 'unroutable' || outcome === 'held') {
			labels.add(AREA_LABELS['reply-routing']);
			notes.push('The owning chat was not established, so start from the identity that was recorded.');
		}
		if (outcome === 'failed' || outcome === 'abandoned') {
			labels.add(AREA_LABELS['reply-routing']);
		}
	}

	if (parsed.hostsUnavailable > 0) {
		labels.add(AREA_LABELS.setup);
		notes.push(
			`${parsed.hostsUnavailable} notification host(s) were not callable — check the tool allowlist before the bridge itself.`
		);
	}

	if (parsed.logLines.length === 0) {
		labels.add(NEEDS_INFO_LABEL);
		notes.push('No log was attached, so the decision the bridge made cannot be read.');
	}
	if (parsed.reproSteps === 0) {
		notes.push('No reproduction steps were given.');
	}
	if (parsed.description.length < 30) {
		labels.add(NEEDS_INFO_LABEL);
		notes.push('The description is too short to act on.');
	}

	const summary = labels.has(NEEDS_INFO_LABEL)
		? 'Automated triage: this report is missing evidence needed to answer it.'
		: `Automated triage: filed against ${AREA_TITLES[parsed.area]}.`;

	return { labels: [...labels], summary, notes };
}

/**
 * Cuts a body to a budget at a line boundary, saying so where it was cut.
 *
 * A body silently clipped mid-sentence reads like the reporter gave up halfway, which is
 * the worst possible impression for a report that was in fact complete.
 */
export function truncateBody(body: string, maxChars: number, savedTo?: string): string {
	if (body.length <= maxChars) {
		return body;
	}
	const notice = savedTo
		? `\n\n_Truncated to fit. The full report was saved to \`${savedTo}\` — please attach it._`
		: '\n\n_Truncated to fit._';
	const budget = Math.max(0, maxChars - notice.length);
	const cut = body.slice(0, budget);
	const lastBreak = cut.lastIndexOf('\n');
	return `${(lastBreak > budget * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd()}${notice}`;
}

/**
 * A prefilled `issues/new` URL, for when no CLI is available to file it properly.
 *
 * The fallback exists because the alternative is telling a user who has just written a
 * report that nothing can be done with it.
 */
export function issueUrlFor(repository: string, report: ProblemReport, body: string): string {
	const base = `https://github.com/${repository}/issues/new`;
	const trimmed = truncateBody(body, MAX_URL_BODY_CHARS, report.savedTo);
	const params = new URLSearchParams({
		title: issueTitleFor(report),
		body: trimmed,
		labels: labelsFor(report).join(',')
	});
	return `${base}?${params.toString()}`;
}

/**
 * Reads `owner/name` out of whatever spelling `package.json` happens to carry.
 *
 * The repository is already declared there, and a second hardcoded copy is a second thing
 * to forget when the project moves.
 */
export function repositorySlugFrom(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return match ? `${match[1]}/${match[2]}` : undefined;
}

function replaceAll(text: string, needle: string, replacement: string): string {
	if (!needle) {
		return text;
	}
	return text.split(needle).join(replacement);
}
