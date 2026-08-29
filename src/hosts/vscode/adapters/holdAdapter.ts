import * as vscode from 'vscode';
import type { DeliverableReply, DeliveryOutcome, HarnessAdapter } from '../../../application/services/harness';
import type { SessionIdentity } from '../../../domain/types';

export interface HoldAdapterDeps {
	log: vscode.LogOutputChannel;
	/**
	 * Delivers anyway, when the user has explicitly chosen that over holding.
	 *
	 * Returning undefined means hold. The choice stays the user's: holding is the safe
	 * default, but someone running a single chat may reasonably prefer a reply to arrive in
	 * whatever is focused over not arriving at all.
	 */
	deliverAnyway?(deliverable: DeliverableReply): Promise<DeliveryOutcome | undefined>;
}

/**
 * The adapter used whenever no other one can reach the conversation.
 *
 * A Null Object rather than an absent case on purpose. The alternative — falling through
 * when no strategy matches — is what put one task's instruction into another task's chat:
 * `workbench.action.chat.open` resolves the *focused* widget when given no target, and
 * revealing a chat focuses it, so each correct delivery armed the next misroute.
 *
 * Refusing is not a failure. The reply stays in Teams, the thread is told, and the caller
 * retains it for a later pass, so nothing is lost by declining to guess.
 */
export class HoldAdapter implements HarnessAdapter {
	readonly harness = 'unknown' as const;

	/**
	 * Reply ids already warned about, so the same hold is not logged on every poll.
	 *
	 * A retained reply is retried on each pass, and until this was bounded the same
	 * warning was written a thousand times an hour into the output channel — burying
	 * every other log line and giving the user the impression that everything was on
	 * fire when in fact nothing had changed. Once the warning has been made, subsequent
	 * attempts for the same id log at debug instead.
	 */
	private readonly warned = new Set<string>();

	/** So a very long-running install cannot grow the set without limit. */
	private static readonly MAX_WARNED = 1_000;

	constructor(private readonly deps: HoldAdapterDeps) {}

	/** Never. This adapter exists to say no in exactly one place. */
	canDeliver(): boolean {
		return false;
	}

	async deliver(deliverable: DeliverableReply, identity: SessionIdentity): Promise<DeliveryOutcome> {
		const anyway = await this.deps.deliverAnyway?.(deliverable);
		if (anyway) {
			return anyway;
		}
		const replyId = deliverable.reply.id;
		const message =
			`Holding the Teams reply for "${deliverable.session.title}": ` +
			`harness "${identity.harness}" (confidence "${identity.confidence}") cannot be ` +
			`delivered into from this window, and the focused chat is not a safe guess.`;
		if (replyId && this.warned.has(replyId)) {
			// Same reply, same hold, same reason — logged at debug so the outcome is still
			// traceable without flooding the visible log every poll.
			this.deps.log.debug(message);
		} else {
			this.deps.log.warn(message);
			if (replyId) {
				if (this.warned.size >= HoldAdapter.MAX_WARNED) {
					// Drops the oldest so the set cannot grow without bound. Losing an entry
					// re-arms the warning once, which is a small regression against the
					// alternative of leaking memory forever.
					const oldest = this.warned.values().next().value;
					if (oldest !== undefined) {
						this.warned.delete(oldest);
					}
				}
				this.warned.add(replyId);
			}
		}
		return 'unroutable';
	}
}
