import * as vscode from 'vscode';
import { chatSessionResourceFor, findChatSessionFor } from '../../domain/chatSessionLink';
import { matchAgentHostSession } from './agentHostIndex';
import type { AgentHostSession } from './agentHostSessions';
import type { Session } from '../../domain/types';

export interface ChatSessionResolverDeps {
	/** Folder holding this workspace's chat transcripts. */
	chatSessionsUri: vscode.Uri;
	log: vscode.LogOutputChannel;
	/**
	 * Copilot-mode sessions VS Code currently knows about, for the fallback below.
	 *
	 * Injected rather than read here so the sqlite access stays in one place and this class
	 * remains testable without a VS Code profile on disk.
	 */
	agentHostSessions?: () => AgentHostSession[];
	/** The folder this window is working in, used to rule out sessions from another. */
	workspacePath?: () => string | undefined;
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
			// No transcript claims it. A Copilot-mode chat writes none at all, so this is
			// the normal path for that surface rather than an error -- try it before giving
			// up, and cache only a definite answer.
			const viaAgentHost = this.resolveAgentHost(session);
			if (viaAgentHost) {
				this.known.set(session.id, viaAgentHost);
				return viaAgentHost;
			}
			// Not cached: the transcript may simply not be written yet.
			this.deps.log.debug(`No chat transcript claims session "${session.title}".`);
			return undefined;
		}

		const resource = chatSessionResourceFor(chatSessionId);
		this.known.set(session.id, resource);
		this.deps.log.info(`Session "${session.title}" belongs to chat ${chatSessionId}.`);
		return resource;
	}

	/**
	 * Falls back to VS Code's own chat index for a Copilot-mode session.
	 *
	 * Only reached when no transcript claims the session, which is always the case for that
	 * surface. {@link matchAgentHostSession} returns nothing unless exactly one session
	 * fits, so an ambiguous window holds the reply instead of choosing between two
	 * conversations.
	 */
	private resolveAgentHost(session: Session): string | undefined {
		const list = this.deps.agentHostSessions?.();
		if (!list || list.length === 0) {
			return undefined;
		}
		const match = matchAgentHostSession(list, {
			notifiedAt: session.lastNotifyAt,
			createdAt: session.createdAt,
			workspacePath: this.deps.workspacePath?.()
		});
		if (!match) {
			this.deps.log.debug(
				`No single Copilot-mode session matches "${session.title}"; leaving it unresolved rather than guessing.`
			);
			return undefined;
		}
		this.deps.log.info(`Session "${session.title}" belongs to the Copilot-mode chat "${match.label}".`);
		return match.resource;
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
