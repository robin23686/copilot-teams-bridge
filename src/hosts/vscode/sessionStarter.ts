import * as vscode from 'vscode';
import type { Bridge } from '../../application/bridge';
import type { SessionIdentity } from '../../domain/types';

/**
 * Opens a Teams thread for a Copilot session.
 *
 * VS Code exposes no hook that fires on every chat request, so a session is announced
 * either by the model calling the notify tool at the start of its work (see the
 * instructions snippet in the README) or by the user running the start command. Both
 * funnel through here so a session is announced at most once.
 */

export interface SessionStarterDeps {
	bridge(): Bridge;
	log: vscode.LogOutputChannel;
	promptPreviewLength?: number;
}

const announced = new Set<string>();

export interface AnnounceRequest {
	sessionKey: string;
	title: string;
	prompt?: string;
	/**
	 * Who owns this session, recorded now rather than derived later.
	 *
	 * This is the moment the answer is free: the caller knows which surface it is and, for
	 * a chat transcript, the filename is the chat's own id. Discarding it here is what
	 * forced delivery to search transcripts afterwards and guess when the search failed.
	 */
	identity?: SessionIdentity;
}

/**
 * Announces a session on Teams, at most once per key.
 * Returns false when the session had already been announced.
 */
export async function announceSession(deps: SessionStarterDeps, request: AnnounceRequest): Promise<boolean> {
	if (announced.has(request.sessionKey)) {
		return false;
	}
	announced.add(request.sessionKey);

	const summary = ['**Session started.**'];
	if (request.prompt?.trim()) {
		const preview = summarise(request.prompt, deps.promptPreviewLength ?? 500);
		summary.push('', `> ${preview.split('\n').join('\n> ')}`);
	}
	summary.push('', 'Reply in this thread and it becomes the next instruction for this session.');

	try {
		await deps.bridge().notify({
			sessionKey: request.sessionKey,
			title: request.title,
			summary: summary.join('\n'),
			status: 'progress',
			identity: request.identity
		});
		deps.log.info(
			request.identity?.chat
				? `Announced session "${request.title}" on Teams, owned by chat ${request.identity.chat.value}`
				: `Announced session "${request.title}" on Teams`
		);
		return true;
	} catch (error) {
		// Allow a retry rather than marking a session announced when the post failed.
		announced.delete(request.sessionKey);
		throw error;
	}
}

/** Clears the announced set, used when configuration changes rebuild the bridge. */
export function resetAnnouncements(): void {
	announced.clear();
}

export function titleFromPrompt(prompt: string): string {
	const firstLine = prompt.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Copilot session';
	return firstLine.length <= 70 ? firstLine : `${firstLine.slice(0, 69)}…`;
}

function summarise(prompt: string, max: number): string {
	const trimmed = prompt.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
