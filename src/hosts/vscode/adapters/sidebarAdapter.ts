import * as vscode from 'vscode';
import type { ChatInjector } from '../chatInjector';
import { asChatSessionResource } from '../../../domain/chatSessionLink';
import type { DeliverableReply, DeliveryOutcome, HarnessAdapter } from '../../../application/services/harness';
import type { SessionIdentity } from '../../../domain/types';

export interface SidebarAdapterDeps {
	injector: ChatInjector;
	/** Whether a reply may be sent straight away rather than left for the user to check. */
	mayAutoSubmit(): boolean;
	log: vscode.LogOutputChannel;
}

/**
 * Delivers a reply into the Copilot Chat panel or editor in this VS Code window.
 *
 * The first harness made correct, because it is the one whose conversation can be named
 * with certainty: VS Code writes a transcript per chat and the filename *is* the session
 * id, so identity is recorded when the session starts rather than searched for afterwards.
 *
 * Delivery reveals the owning chat before opening a request. That ordering is what makes
 * it correct rather than merely likely — without it the command resolves whichever chat
 * was last focused.
 */
export class SidebarAdapter implements HarnessAdapter {
	readonly harness = 'vscode-sidebar' as const;

	/**
	 * Serves the in-window agent-MCP harness too.
	 *
	 * Delivery is a write into a chat-session-resource -- the same route the sidebar uses --
	 * so the label that first named which surface recorded the session does not decide
	 * whether it can be reached. That question is `canDeliver`'s, and it already asks it
	 * correctly: a chat resource of the right kind, at any confidence above `unknown`.
	 * Claiming both harnesses here is what closes the gap between
	 * {@link deliverableHarnesses} and the registry, so an agent-MCP session is not
	 * declared deliverable by policy while being held forever in practice.
	 */
	readonly serves = ['vscode-sidebar', 'vscode-agent-mcp', 'vscode-agent-host'] as const;

	constructor(private readonly deps: SidebarAdapterDeps) {}

	/**
	 * Only with a chat to steer to. An identity naming the harness but not the conversation
	 * is not enough: delivering on it would mean falling back to the focused chat.
	 */
	canDeliver(identity: SessionIdentity): boolean {
		return identity.confidence !== 'unknown' && identity.chat?.kind === 'chat-session-resource';
	}

	async deliver(deliverable: DeliverableReply, identity: SessionIdentity): Promise<DeliveryOutcome> {
		const routed = {
			...deliverable,
			// The recorded identity wins over whatever the session record happens to carry,
			// so there is one source of truth for where a reply goes.
			//
			// Normalised, because identities were recorded in two forms: the notify tool
			// stored the full resource and the transcript watcher stored the bare id. Both
			// name the same conversation, and everything downstream needs the resource.
			session: { ...deliverable.session, chatSessionResource: asChatSessionResource(identity.chat?.value) }
		};
		return this.deps.injector.inject(routed, this.deps.mayAutoSubmit());
	}
}
