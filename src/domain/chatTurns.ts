/**
 * Reading completed turns out of a Copilot chat transcript.
 *
 * VS Code raises no event when a chat request finishes, so the transcript is the only
 * signal that a turn happened at all. Kept in the domain layer as pure parsing, which lets
 * it be tested against real transcript shapes without an editor.
 *
 * The format is internal and undocumented, so everything here is read defensively: an
 * unexpected shape yields no turn rather than throwing, and a partially written line is
 * skipped so the next write can be read instead.
 */

/** A finished request/response pair, ready to be summarised for Teams. */
export interface ChatTurn {
	requestId: string;
	/** What the user asked. */
	prompt: string;
	/** What Copilot answered, as plain markdown with tool noise removed. */
	response: string;
	/** Whether the answer is finished; an in-flight turn must not be reported. */
	complete: boolean;
	/**
	 * When the turn began, as epoch milliseconds, or 0 when the editor did not record it.
	 *
	 * Used to tell whether the model already reported this turn to Teams itself. A notify
	 * call made during the turn is a deliberate, better-written update than anything that
	 * can be salvaged from the transcript, so the automatic summary stands down for it.
	 */
	startedAt: number;
}

/** Beyond this a transcript is treated as too long to rescan on every write. */
const MAX_LINES_SCANNED = 4_000;

/**
 * Collects every turn recorded in a transcript, oldest first.
 *
 * Requests are gathered by id rather than by position, because the editor writes them three
 * different ways — whole-session snapshots, appended arrays, and keyed deltas into an
 * existing entry — and all three occur in practice. Keying by id means a later write that
 * completes a turn updates that turn instead of appearing as a second one.
 */
export function parseTurns(text: string): ChatTurn[] {
	const turns = new Map<string, ChatTurn>();
	const rows = text.split('\n');
	const limit = Math.min(rows.length, MAX_LINES_SCANNED);

	for (let index = 0; index < limit; index++) {
		const row = rows[index].trim();
		if (!row) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(row);
		} catch {
			continue; // A partial write; a later change event will see it whole.
		}
		for (const request of requestsIn(parsed)) {
			const turn = toTurn(request);
			if (!turn) {
				continue;
			}
			// Merged rather than replaced. A turn is written repeatedly as its answer
			// streams, and a later keyed delta may touch one field without repeating the
			// rest — so overwriting would silently drop an answer that had already arrived.
			const existing = turns.get(turn.requestId);
			turns.set(turn.requestId, existing ? mergeTurn(existing, turn) : turn);
		}
	}

	return [...turns.values()];
}

/** Finds request objects wherever this line happens to carry them. */
function requestsIn(node: unknown, depth = 0): Record<string, unknown>[] {
	if (!node || typeof node !== 'object' || depth > 4) {
		return [];
	}
	if (Array.isArray(node)) {
		return node.flatMap((entry) => requestsIn(entry, depth + 1));
	}

	const record = node as Record<string, unknown>;
	if (typeof record.requestId === 'string') {
		return [record];
	}

	const found: Record<string, unknown>[] = [];
	for (const value of Object.values(record)) {
		found.push(...requestsIn(value, depth + 1));
	}
	return found;
}

function toTurn(request: Record<string, unknown>): ChatTurn | undefined {
	const requestId = request.requestId;
	if (typeof requestId !== 'string' || !requestId) {
		return undefined;
	}

	const message = request.message as { text?: unknown } | undefined;
	const prompt = typeof message?.text === 'string' ? message.text.trim() : '';
	if (!prompt) {
		// A keyed delta touching some other field of the request. Nothing to report yet.
		return undefined;
	}

	return {
		requestId,
		prompt,
		response: responseTextOf(request.response),
		// `result` is written when the turn settles, so its presence is what separates a
		// finished answer from one still streaming. Reporting mid-stream would post a
		// half-sentence to Teams and then post it again once it completed.
		//
		// Deliberately not also requiring `responseTimestamp`: real transcripts carry it
		// only sometimes, so demanding both marked every turn incomplete and nothing was
		// ever posted.
		complete: Boolean(request.result),
		startedAt: typeof request.timestamp === 'number' ? request.timestamp : 0
	};
}

/** Keeps whichever copy of a turn knows more, since writes arrive piecemeal. */
function mergeTurn(existing: ChatTurn, incoming: ChatTurn): ChatTurn {
	return {
		requestId: existing.requestId,
		prompt: incoming.prompt || existing.prompt,
		// A later write with no prose is an update to some other field, not an answer that
		// vanished, so the text already collected stands.
		response: incoming.response.length >= existing.response.length ? incoming.response : existing.response,
		// Completion only ever moves forwards.
		complete: existing.complete || incoming.complete,
		startedAt: existing.startedAt || incoming.startedAt
	};
}

/**
 * Flattens the response parts into the prose the user actually saw.
 *
 * The array mixes markdown with tool invocations, file references and progress notices.
 * Only the markdown is worth relaying: a summary made of "Ran tool X" lines tells the
 * reader nothing about what was decided.
 */
function responseTextOf(response: unknown): string {
	if (!Array.isArray(response)) {
		return '';
	}

	const pieces: string[] = [];
	for (const part of response) {
		const text = markdownOf(part);
		if (text) {
			pieces.push(text);
		}
	}
	return pieces.join('').trim();
}

function markdownOf(part: unknown): string | undefined {
	if (!part || typeof part !== 'object') {
		return undefined;
	}
	const record = part as { kind?: unknown; value?: unknown };
	// Anything that names its kind is machinery or private reasoning — `thinking` above all,
	// which carries real text and must never reach Teams. Prose is the unnamed case.
	if (typeof record.kind === 'string' && record.kind !== 'markdownContent') {
		return undefined;
	}
	if (typeof record.value === 'string') {
		return record.value;
	}
	// A MarkdownString, which nests the text one level down.
	const nested = record.value as { value?: unknown } | undefined;
	return typeof nested?.value === 'string' ? nested.value : undefined;
}

/**
 * Condenses a turn into something worth reading on a phone.
 *
 * A Copilot answer routinely runs to hundreds of lines of prose, code and tables. Relaying
 * it verbatim would make the Teams thread unreadable and bury the replies, which are the
 * only reason the thread exists — so the summary keeps the opening prose and says plainly
 * that it is a summary rather than pretending to be the whole answer.
 */
export function summariseTurn(turn: ChatTurn, maxLength = 600): string {
	const prose = turn.response
		// Fenced code says little in a summary and eats the whole budget.
		.replace(/```[\s\S]*?```/g, '')
		.split('\n')
		.map((line) => line.trim())
		// Tables read as noise once the columns are gone.
		.filter((line) => line && !/^\|/.test(line) && !/^[-=]{3,}$/.test(line))
		.join('\n')
		.trim();

	if (!prose) {
		return '_Copilot answered without prose — open the chat in VS Code to see it._';
	}
	if (prose.length <= maxLength) {
		return prose;
	}

	// Cut at a sentence or line end when one is near the limit, so the summary does not
	// stop mid-word.
	const window = prose.slice(0, maxLength);
	const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
	return `${(cut > maxLength * 0.6 ? window.slice(0, cut + 1) : window).trim()}\u2026`;
}
