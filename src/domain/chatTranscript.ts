/**
 * Reading Copilot chat transcripts.
 *
 * Kept out of the VS Code layer because it is pure parsing, which lets it be tested
 * against real transcripts without an editor.
 */
/**
 * Pulls the id, title and opening prompt out of a transcript.
 *
 * VS Code writes these two different ways, and both occur in practice: some transcripts
 * carry the whole session in the first line, while others start with an empty shell and
 * append every field as a keyed delta. Rather than encode the delta semantics, which are
 * internal and would break the moment they change, this looks for the values it needs
 * wherever they appear. Exported for tests.
 */
export function parseTranscript(text: string): { id: string; title: string; prompt: string } | undefined {
	const rows = text.split('\n');
	let id: string | undefined;
	let title: string | undefined;
	let prompt: string | undefined;

	// Bounded, so a long conversation costs no more than the announcement is worth.
	const limit = Math.min(rows.length, MAX_LINES_SCANNED);
	for (let index = 0; index < limit; index++) {
		const row = rows[index].trim();
		if (!row) {
			continue;
		}
		let parsed: { k?: unknown; v?: unknown };
		try {
			parsed = JSON.parse(row) as { k?: unknown; v?: unknown };
		} catch {
			continue; // A partial write; a later change event will try again.
		}

		const value = parsed.v as Record<string, unknown> | undefined;
		if (index === 0 && typeof value?.sessionId === 'string') {
			id = value.sessionId;
		}

		const key = Array.isArray(parsed.k) ? parsed.k : undefined;
		if (key?.[0] === 'customTitle' && typeof parsed.v === 'string') {
			title = parsed.v; // The editor names the session once it has answered.
		} else if (!title && typeof value?.customTitle === 'string') {
			title = value.customTitle;
		}

		if (!prompt) {
			prompt = findPrompt(parsed.v, 0);
		}

		if (id && title && prompt) {
			break;
		}
	}

	if (!id || !prompt) {
		// No request yet means no work has started, so there is nothing to announce.
		return undefined;
	}
	return { id, title: title?.trim() || titleFrom(prompt), prompt };
}

const MAX_LINES_SCANNED = 400;

/** Finds the first user message in an unfamiliar object graph. */
function findPrompt(node: unknown, depth: number): string | undefined {
	if (!node || typeof node !== 'object' || depth > 3) {
		return undefined;
	}
	const message = (node as { message?: { text?: unknown } }).message;
	if (typeof message?.text === 'string' && message.text.trim()) {
		return message.text;
	}
	for (const nested of Object.values(node as Record<string, unknown>)) {
		const found = findPrompt(nested, depth + 1);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function titleFrom(prompt: string): string {
	const firstLine = prompt.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Copilot session';
	return firstLine.length <= 70 ? firstLine : `${firstLine.slice(0, 69)}\u2026`;
}
