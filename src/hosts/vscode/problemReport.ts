import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
	AREA_TITLES,
	MAX_ISSUE_BODY_CHARS,
	buildProblemReport,
	issueTitleFor,
	issueUrlFor,
	labelsFor,
	renderIssueBody,
	repositorySlugFrom,
	selectLogLines,
	truncateBody,
	type EnvironmentFacts,
	type HostAvailability,
	type ProblemArea,
	type ProblemReport,
	type StateFileFact
} from '../../domain/problemReport';

/**
 * The user-facing half of reporting a problem.
 *
 * Everything here is either asking the user something or reading the machine. The rules
 * about what a report contains, how it is redacted and how it is rendered live in the
 * domain module, so they can be tested without an editor — this file is deliberately thin
 * enough that its own correctness is mostly "did it collect the right things".
 *
 * Nothing leaves the machine without the user seeing it first. The report is opened in an
 * editor and a modal asks for consent, because a diagnostic bundle assembled silently is a
 * diagnostic bundle nobody can trust.
 */

const run = promisify(execFile);

/** How much of the log is worth attaching. Enough for a session's history, not a day's. */
const LOG_TAIL_LINES = 300;
/** Beyond this the log file is read from the end rather than whole. */
const LOG_READ_BYTES = 512 * 1024;

const FALLBACK_REPOSITORY = 'robin23686/copilot-teams-bridge';

export interface ProblemReportDeps {
	context: vscode.ExtensionContext;
	log: vscode.LogOutputChannel;
	/** Transport and configuration facts, read at report time rather than cached. */
	environment: () => Pick<EnvironmentFacts, 'transport' | 'teamsConfigured' | 'sessionCount' | 'listening'>;
	/** How live sessions would be routed, or undefined when that cannot be answered. */
	routing: () => string | undefined;
	/** Where the shared state files live. */
	bridgeHome: string;
}

interface Answers {
	title: string;
	description: string;
	reproSteps: string[];
	area: ProblemArea;
	includeSessionTitles: boolean;
}

/**
 * Runs the whole flow: interview, collect, show, submit.
 *
 * Returns quietly when the user backs out at any step. A wizard that punishes cancelling
 * with an error message trains people not to open it.
 */
export async function reportProblem(deps: ProblemReportDeps): Promise<void> {
	const answers = await interview();
	if (!answers) {
		return;
	}

	const report = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Teams Bridge: collecting diagnostics…' },
		() => collect(deps, answers)
	);

	const body = truncateBody(renderIssueBody(report), MAX_ISSUE_BODY_CHARS, report.savedTo);
	const savedTo = await saveReport(deps, report, body);
	const finished: ProblemReport = { ...report, savedTo: savedTo ?? report.savedTo };

	await preview(body);

	const open = 'Open a GitHub issue';
	const keep = 'Just keep the file';
	const choice = await vscode.window.showWarningMessage(
		'This report is about to be published to a public GitHub issue. It has been redacted — '
			+ 'home paths, usernames, email addresses and Teams identifiers are removed — but please '
			+ 'read the preview before continuing.',
		{ modal: true, detail: savedTo ? `A copy has been saved to ${savedTo}` : undefined },
		open,
		keep
	);

	if (choice !== open) {
		if (choice === keep && savedTo) {
			void vscode.window.showInformationMessage(`Teams Bridge: report saved to ${savedTo}.`);
		}
		return;
	}

	await submit(deps, finished, body, savedTo);
}

/** The part only the user knows. Four questions, each of which can end the flow. */
async function interview(): Promise<Answers | undefined> {
	const title = await vscode.window.showInputBox({
		title: 'Report a problem (1 of 4)',
		prompt: 'One line describing the problem',
		placeHolder: 'e.g. My Teams reply never reached the chat that asked the question',
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim().length < 8 ? 'Please give a little more than that.' : undefined)
	});
	if (!title) {
		return undefined;
	}

	const description = await vscode.window.showInputBox({
		title: 'Report a problem (2 of 4)',
		prompt: 'What happened, and what did you expect instead?',
		placeHolder: 'e.g. The reply landed in a different chat. I expected it in the one the thread was opened for.',
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim().length < 15 ? 'A sentence or two, so this can be acted on.' : undefined)
	});
	if (!description) {
		return undefined;
	}

	// Asked one step at a time rather than as one free-text box: an input box is a single
	// line, and steps crammed onto one line are the first thing a reader has to untangle.
	const reproSteps: string[] = [];
	for (let index = 1; index <= 10; index++) {
		const step = await vscode.window.showInputBox({
			title: `Report a problem (3 of 4) — step ${index}`,
			prompt: index === 1
				? 'How can this be reproduced? Leave empty to skip.'
				: 'Next step, or leave empty when you are done.',
			ignoreFocusOut: true
		});
		if (step === undefined) {
			// Escape here means "stop adding steps", not "abandon the report" -- the two
			// earlier answers are the expensive ones and should not be thrown away.
			break;
		}
		if (!step.trim()) {
			break;
		}
		reproSteps.push(step.trim());
	}

	const areas: { label: string; description: string; area: ProblemArea }[] = [
		{ label: AREA_TITLES['teams-delivery'], description: 'Nothing arrives in Teams, or the wrong thing does', area: 'teams-delivery' },
		{ label: AREA_TITLES['reply-routing'], description: 'A reply did not reach Copilot, or reached the wrong chat', area: 'reply-routing' },
		{ label: AREA_TITLES.sessions, description: 'Duplicate threads, sessions expiring, threads going quiet', area: 'sessions' },
		{ label: AREA_TITLES.setup, description: 'Install, sign-in, or the notify tool not being callable', area: 'setup' },
		{ label: AREA_TITLES.other, description: 'None of the above', area: 'other' }
	];
	const picked = await vscode.window.showQuickPick(areas, {
		title: 'Report a problem (4 of 4)',
		placeHolder: 'Which part of the bridge is at fault?',
		ignoreFocusOut: true
	});
	if (!picked) {
		return undefined;
	}

	const titlesChoice = await vscode.window.showQuickPick(
		[
			{ label: 'Withhold session titles', description: 'Recommended — titles are your own words', include: false },
			{ label: 'Include session titles', description: 'Helps when the problem is about a specific thread', include: true }
		],
		{ title: 'Report a problem', placeHolder: 'Session titles appear in the log. Include them?', ignoreFocusOut: true }
	);
	if (!titlesChoice) {
		return undefined;
	}

	return {
		title: title.trim(),
		description: description.trim(),
		reproSteps,
		area: picked.area,
		includeSessionTitles: titlesChoice.include
	};
}

/** The part the machine knows, gathered without asking. */
async function collect(deps: ProblemReportDeps, answers: Answers): Promise<ProblemReport> {
	const packageJson = deps.context.extension?.packageJSON as { version?: string } | undefined;
	const extra = safely(() => deps.environment(), {} as ReturnType<ProblemReportDeps['environment']>);

	const environment: EnvironmentFacts = {
		extensionVersion: packageJson?.version ?? 'unknown',
		vscodeVersion: vscode.version ?? 'unknown',
		platform: `${process.platform} ${process.arch}`,
		nodeVersion: process.versions?.node,
		...extra
	};

	const routing = answers.includeSessionTitles
		? safely(() => deps.routing(), undefined)
		: 'Withheld: session titles were not included in this report.';

	const report = buildProblemReport(
		{
			...answers,
			environment,
			hosts: await notificationHosts(),
			routing,
			logTail: await readLogTail(deps),
			stateFiles: await stateFiles(deps)
		},
		{
			homeDir: os.homedir(),
			userName: os.userInfo?.().username,
			secrets: configuredIds()
		}
	);

	deps.log.info(`[report] assembled area=${report.area} logLines=${report.logTail.length} hosts=${report.hosts.length}`);
	return report;
}

/**
 * Which notification surfaces are actually callable.
 *
 * Worth collecting unprompted. "The tool is disabled" was one of the more expensive
 * confusions this bridge produced, and it is answerable in one line — but only from inside
 * the host, which is exactly where the reporter is not looking.
 */
async function notificationHosts(): Promise<HostAvailability[]> {
	const hosts: HostAvailability[] = [];
	try {
		const tools = (vscode.lm as { tools?: readonly { name: string }[] } | undefined)?.tools ?? [];
		const names = tools.map((tool) => tool.name);
		hosts.push({
			name: 'copilotTeamsBridge_notify',
			available: names.includes('copilotTeamsBridge_notify'),
			detail: 'VS Code extension host'
		});
		const mcp = names.find((name) => name.includes('teams_notify'));
		hosts.push({
			name: mcp ?? 'teams_notify',
			available: mcp !== undefined,
			detail: 'bundled MCP server'
		});
	} catch (error) {
		hosts.push({ name: 'tool list', available: false, detail: String(error) });
	}
	return hosts;
}

/**
 * The tail of this window's log.
 *
 * `context.logUri` points straight at the folder the guidance previously asked people to
 * find by globbing timestamped directories under APPDATA, which is the step most reports
 * stop at.
 */
async function readLogTail(deps: ProblemReportDeps): Promise<string[]> {
	const logUri = deps.context.logUri;
	if (!logUri) {
		return [];
	}
	const file = vscode.Uri.joinPath(logUri, 'Copilot Teams Bridge.log');
	try {
		const bytes = await vscode.workspace.fs.readFile(file);
		const slice = bytes.length > LOG_READ_BYTES ? bytes.slice(bytes.length - LOG_READ_BYTES) : bytes;
		const lines = Buffer.from(slice).toString('utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
		return selectLogLines(lines, LOG_TAIL_LINES);
	} catch (error) {
		deps.log.warn(`[report] no log to attach: ${String(error)}`);
		return [];
	}
}

/** Whether the shared state files exist and how big they are. Never their contents. */
async function stateFiles(deps: ProblemReportDeps): Promise<StateFileFact[]> {
	const names = ['sessions.json', 'threads.json', 'delivered.json', 'posted.json'];
	const facts: StateFileFact[] = [];
	for (const name of names) {
		const uri = vscode.Uri.file(path.join(deps.bridgeHome, name));
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			facts.push({ name, exists: true, bytes: stat.size });
		} catch {
			facts.push({ name, exists: false });
		}
	}
	return facts;
}

/** The configured team and channel, so redaction can remove them literally. */
function configuredIds(): string[] {
	try {
		const config = vscode.workspace.getConfiguration('copilotTeamsBridge');
		return [config.get<string>('teamId', ''), config.get<string>('channelId', '')].filter(
			(value): value is string => Boolean(value && value.trim())
		);
	} catch {
		return [];
	}
}

/**
 * Writes the full report next to the extension's own storage.
 *
 * Saved before submission rather than after, so a failed or cancelled submission still
 * leaves the user holding everything they just wrote.
 */
async function saveReport(deps: ProblemReportDeps, report: ProblemReport, body: string): Promise<string | undefined> {
	try {
		const folder = vscode.Uri.joinPath(deps.context.globalStorageUri, 'problem-reports');
		await vscode.workspace.fs.createDirectory(folder);
		const stamp = report.createdAt.replace(/[:.]/g, '-');
		const file = vscode.Uri.joinPath(folder, `report-${stamp}.md`);
		await vscode.workspace.fs.writeFile(file, Buffer.from(body, 'utf8'));
		return file.fsPath;
	} catch (error) {
		deps.log.warn(`[report] could not save a copy: ${String(error)}`);
		return undefined;
	}
}

async function preview(body: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
	await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * Files the issue, preferring the path that can carry the whole report.
 *
 * `gh` takes a body file and labels in one call, so nothing is lost and triage can start
 * immediately. The browser fallback exists so a machine without the CLI still gets the
 * report filed, at the cost of a body trimmed to a URL-safe size.
 */
async function submit(
	deps: ProblemReportDeps,
	report: ProblemReport,
	body: string,
	savedTo: string | undefined
): Promise<void> {
	const repository = repositorySlugFrom(
		(deps.context.extension?.packageJSON as { repository?: { url?: string } } | undefined)?.repository?.url
	) ?? FALLBACK_REPOSITORY;

	if (savedTo) {
		const url = await createWithGh(deps, repository, report, savedTo);
		if (url) {
			deps.log.info(`[report] filed ${url}`);
			const openIssue = 'Open the issue';
			const choice = await vscode.window.showInformationMessage(`Teams Bridge: reported — ${url}`, openIssue);
			if (choice === openIssue) {
				await vscode.env.openExternal(vscode.Uri.parse(url));
			}
			return;
		}
	}

	await vscode.env.openExternal(vscode.Uri.parse(issueUrlFor(repository, report, body)));
	void vscode.window.showInformationMessage(
		savedTo
			? `Teams Bridge: opened a prefilled issue in your browser. The full report is at ${savedTo} — attach it if the form looks short.`
			: 'Teams Bridge: opened a prefilled issue in your browser.'
	);
}

/**
 * Creates the issue with the GitHub CLI, if it is installed and signed in.
 *
 * Labels are applied on a best-effort second attempt: a repository that has not yet been
 * given the label set would otherwise reject the whole call, and losing the report over a
 * missing label would be absurd when the triage workflow can add them anyway.
 */
async function createWithGh(
	deps: ProblemReportDeps,
	repository: string,
	report: ProblemReport,
	bodyFile: string
): Promise<string | undefined> {
	const base = ['issue', 'create', '--repo', repository, '--title', issueTitleFor(report), '--body-file', bodyFile];
	const withLabels = [...base, ...labelsFor(report).flatMap((label) => ['--label', label])];

	for (const args of [withLabels, base]) {
		try {
			const { stdout } = await run('gh', args, { timeout: 60_000, windowsHide: true });
			const url = /https:\/\/github\.com\/\S+/.exec(stdout)?.[0];
			if (url) {
				return url;
			}
		} catch (error) {
			deps.log.warn(`[report] gh issue create failed: ${describe(error)}`);
		}
	}
	return undefined;
}

function describe(error: unknown): string {
	const stderr = (error as { stderr?: string } | undefined)?.stderr;
	return (stderr && stderr.trim()) || (error instanceof Error ? error.message : String(error));
}

function safely<T>(read: () => T, fallback: T): T {
	try {
		return read() ?? fallback;
	} catch {
		return fallback;
	}
}
