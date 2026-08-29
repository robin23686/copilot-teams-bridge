import * as vscode from 'vscode';
import { chatSessionResourceFor, findChatSessionFor } from '../../domain/chatSessionLink';
import type { Session } from '../../domain/types';

export interface ChatSessionResolverDeps {
	/** Folder holding this workspace's chat transcripts. */
	chatSessionsUri: vscode.Uri;
	log: vscode.LogOutputChannel;
}

/** Enough to cover any conversation still worth replying to, without reading a whole history. */
const MAX_TRANSCRIPTS = 60;

/**
 * Finds the chat that started an agent session.
 *
 * Sessions created through the MCP server have no chat recorded, because that server runs
 * outside VS Code and cannot see one. Their replies therefore went to whichever chat was
 * focused. The transcripts hold the missing link: the chat that called the tool recorded
 * the call, so the session key identifies its own conversation.
 */
export class ChatSessionResolver {
	/** Resolved sessions, kept because a chat's id never changes once known. */
	private readonly known = new Map<string, string>();

	constructor(private readonly deps: ChatSessionResolverDeps) {}

	/** The chat resource for a session, or nothing when no transcript claims it. */
	async resolve(session: Session): Promise<string | undefined> {
		const cached = this.known.get(session.id);
		if (cached) {
			return cached;
		}

		let chatSessionId: string | undefined;
		try {
			chatSessionId = findChatSessionFor([session.key, session.id], await this.transcripts());
		} catch (error) {
			this.deps.log.warn(`Could not search chat transcripts: ${String(error)}`);
			return undefined;
		}

		if (!chatSessionId) {
			// Not cached: the transcript may simply not be written yet.
			this.deps.log.debug(`No chat transcript claims session "${session.title}".`);
			return undefined;
		}

		const resource = chatSessionResourceFor(chatSessionId);
		this.known.set(session.id, resource);
		this.deps.log.info(`Session "${session.title}" belongs to chat ${chatSessionId}.`);
		return resource;
	}

	/** Transcripts newest first, so a session resumed in a new chat resolves to that one. */
	private async transcripts(): Promise<{ id: string; text: string }[]> {
		const entries = await vscode.workspace.fs.readDirectory(this.deps.chatSessionsUri);
		const files = entries
			.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.jsonl'))
			.map(([name]) => name);

		const dated = await Promise.all(
			files.map(async (name) => {
				const uri = vscode.Uri.joinPath(this.deps.chatSessionsUri, name);
				try {
					return { name, uri, at: (await vscode.workspace.fs.stat(uri)).mtime };
				} catch {
					return undefined; // Deleted between listing and reading.
				}
			})
		);

		const newest = dated
			.filter((entry): entry is { name: string; uri: vscode.Uri; at: number } => Boolean(entry))
			.sort((a, b) => b.at - a.at)
			.slice(0, MAX_TRANSCRIPTS);

		const read = await Promise.all(
			newest.map(async (entry) => {
				try {
					const bytes = await vscode.workspace.fs.readFile(entry.uri);
					return { id: entry.name.replace(/\.jsonl$/, ''), text: Buffer.from(bytes).toString('utf8') };
				} catch {
					return undefined;
				}
			})
		);

		return read.filter((entry): entry is { id: string; text: string } => Boolean(entry));
	}
}
