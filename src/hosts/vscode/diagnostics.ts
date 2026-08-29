import * as vscode from 'vscode';

/**
 * Recording what VS Code actually did, rather than what it was expected to do.
 *
 * Two days were lost to fixes that were reasoned out from minified workbench source and
 * from tests built on fakes that asserted the same assumption. Every one of them passed and
 * every one of them shipped the bug again, because nothing anywhere recorded the ground
 * truth: which commands exist, what the editor looked like before and after, and which of
 * the several forms a chat identity was actually stored in.
 *
 * So delivery now writes down what it observed at each step. The point is not tidier logs;
 * it is that the next failure can be diagnosed from one log line instead of another round
 * of guessing.
 */

/** One delivery attempt, as observed rather than as intended. */
export interface DeliveryTrace {
	sessionTitle: string;
	replyId: string;
	/** Identity as stored, before any normalising, so a bad form is visible. */
	storedChat?: string;
	/** What that became once normalised into a resource. */
	resource?: string;
	/** How the identity was captured, which names the producer that recorded it. */
	capturedBy?: string;
	harness?: string;
	confidence?: string;
	steps: string[];
}

export function beginTrace(sessionTitle: string, replyId: string): DeliveryTrace {
	return { sessionTitle, replyId, steps: [] };
}

export function note(trace: DeliveryTrace | undefined, step: string): void {
	trace?.steps.push(step);
}

/**
 * Writes the trace as a single line.
 *
 * One line on purpose. A delivery decision spread over eight interleaved log entries is
 * what made the last failure take a day to read; this one can be pasted straight back.
 */
export function writeTrace(log: vscode.LogOutputChannel, trace: DeliveryTrace, outcome: string): void {
	const fields = [
		`outcome=${outcome}`,
		`session=${JSON.stringify(trace.sessionTitle)}`,
		`reply=${trace.replyId}`,
		`harness=${trace.harness ?? '-'}`,
		`confidence=${trace.confidence ?? '-'}`,
		`capturedBy=${trace.capturedBy ?? '-'}`,
		`storedChat=${trace.storedChat ?? '-'}`,
		`resource=${trace.resource ?? '-'}`
	];
	log.info(`[route] ${fields.join(' ')} steps=[${trace.steps.join(' -> ')}]`);
}

/** The editor layout, as far as the extension host can see it. */
export function describeEditorState(): string {
	try {
		const groups = vscode.window.tabGroups?.all ?? [];
		const active = vscode.window.tabGroups?.activeTabGroup?.activeTab;
		const kinds = groups
			.flatMap((group) => group.tabs)
			.map((tab) => (tab.input as { constructor?: { name?: string } })?.constructor?.name ?? 'none');
		return `tabs=${kinds.length}[${[...new Set(kinds)].join(',')}] active=${
			(active?.input as { constructor?: { name?: string } })?.constructor?.name ?? 'none'
		} activeLabel=${JSON.stringify(active?.label ?? '')}`;
	} catch (error) {
		return `unreadable(${String(error)})`;
	}
}

/**
 * Whether the commands this bridge depends on exist in the running host.
 *
 * Worth asking explicitly. A command that has been renamed does not throw when executed —
 * `executeCommand` rejects, but several callers historically swallowed that — so a missing
 * command looked exactly like a chat that would not come forward.
 */
export async function probeCommands(log: vscode.LogOutputChannel): Promise<void> {
	const wanted = [
		'workbench.action.chat.open',
		'workbench.action.chat.openSessionInEditorGroup',
		'workbench.action.chat.openInSidebar'
	];
	try {
		const all = new Set(await vscode.commands.getCommands(true));
		const report = wanted.map((id) => `${id}=${all.has(id) ? 'present' : 'MISSING'}`);
		log.info(`[probe] host=${vscode.version} ${report.join(' ')}`);
	} catch (error) {
		log.warn(`[probe] could not list commands: ${String(error)}`);
	}
}
