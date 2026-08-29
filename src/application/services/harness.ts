import type { ChatHandle, HarnessKind, InboundReply, Session, SessionIdentity } from '../../domain/types';
import { isAgentHostResource } from '../../domain/chatSessionLink';

/** A reply paired with the session it belongs to, ready to be handed to a harness. */
export interface DeliverableReply {
	session: Session;
	reply: InboundReply;
	/** Cleaned instruction text, with any leading slash command removed. */
	text: string;
	command?: string;
}

/** What became of a reply, which decides what the user is told and whether it is retried. */
export type DeliveryOutcome =
	/** Handed to the conversation that started the work. */
	| 'delivered'
	/** Placed in the chat input for the user to check and send. */
	| 'held'
	/**
	 * Deliberately not delivered, because the owning conversation is not known.
	 *
	 * Distinct from `failed`: nothing went wrong, there was simply nowhere safe to put it.
	 * The reply must be **retained** so it can be delivered once the chat becomes known.
	 */
	| 'unroutable'
	/** The harness was reachable but delivery failed; worth retrying. */
	| 'failed'
	/**
	 * The automatic route has been given up on for this reply — retrying would repeat the
	 * same failure and re-log the same explanation. The user is told once and the reply is
	 * consumed instead of being retained.
	 *
	 * Reached when a reveal-and-write pair was tried and the target transcript could not
	 * confirm the write landed there. Continuing to poll would keep sending the same text
	 * into the same wrong chat and flood the Teams thread with identical failure notices.
	 * The reply stays in Teams for the user to move by hand — nothing is lost — but this
	 * bridge stops trying.
	 */
	| 'abandoned';

/** Outcomes after which a reply must not be consumed, or the instruction is lost. */
export function isRetryable(outcome: DeliveryOutcome): boolean {
	return outcome === 'unroutable' || outcome === 'failed';
}

/**
 * Whether keeping a reply for another attempt could ever help.
 *
 * Retrying is right when the chat merely has not been identified *yet* — opening it makes
 * the reply deliverable, and discarding it would destroy an instruction. It is wrong when
 * the harness itself cannot be reached from this window: no amount of waiting changes that,
 * so the reply would be re-read on every pass forever. Those are answered once and released.
 */
/**
 * Extra facts that can make a session reachable beyond what its harness alone implies.
 *
 * Every field is optional and every default is "no", so omitting this argument reproduces
 * the behaviour that existed before CLI resume was contemplated. That is deliberate: the
 * options thread through call sites that have nothing to do with the CLI, and those sites
 * must keep behaving identically without having to be updated in step with this file.
 */
export interface ReplyRoutingOptions {
	/**
	 * Whether resuming a `copilot` CLI session is permitted.
	 *
	 * Off unless the user has opted in. Resuming spawns a non-interactive agent run, which
	 * the CLI only allows with `--allow-all-tools`, so this is a trust decision about the
	 * Teams channel rather than a convenience toggle.
	 */
	cliResumeEnabled?: boolean;
}

/**
 * Whether a reply for this session can be delivered by resuming its CLI session.
 *
 * Deliberately *not* expressed by adding `cli-runtime` to {@link deliverableHarnesses}.
 * That set is consulted by {@link replyReachability}, which decides the footer on every
 * message, so widening it would promise a reply could be routed for every CLI session --
 * including ones with no recorded id, and including when the user has not opted in. That is
 * precisely the shape of the agent-MCP regression: deliverable by policy, unroutable in
 * practice. Reachability here is a property of the individual session, so it is asked of
 * the session.
 */
export function canResumeCliSession(identity: SessionIdentity, options?: ReplyRoutingOptions): boolean {
	return (
		options?.cliResumeEnabled === true &&
		identity.harness === 'cli-runtime' &&
		typeof identity.cliSessionId === 'string' &&
		identity.cliSessionId.length > 0
	);
}

export function worthRetrying(
	outcome: DeliveryOutcome,
	identity: SessionIdentity,
	options?: ReplyRoutingOptions
): boolean {
	if (!isRetryable(outcome)) {
		return false;
	}
	// A transient failure is always worth another attempt, whatever the harness.
	if (outcome === 'failed') {
		return true;
	}
	// Asked of the harness alone: a CLI session may well have an exact chat recorded, and
	// it is still not reachable from here. Confidence answers "which chat?", not "can we
	// get to it?" — conflating the two is what would keep an unanswerable reply forever.
	return (
		identity.harness === 'unknown' ||
		DELIVERABLE_HARNESSES.has(identity.harness) ||
		canResumeCliSession(identity, options)
	);
}

/**
 * Delivers a reply into one kind of Copilot surface.
 *
 * Each surface is reached differently — a chat session resource for the sidebar, a debug
 * log for the CLI runtime, nothing at all for an external client. Keeping them behind one
 * interface is what lets a single harness be made correct without the others interfering,
 * and lets an unsupported one refuse cleanly instead of guessing.
 */
export interface HarnessAdapter {
	readonly harness: SessionIdentity['harness'];
	/**
	 * Extra harnesses this adapter can also serve, beyond its primary `harness`.
	 *
	 * Delivery is performed by a *route* (a chat-session-resource, a CLI socket, and so on),
	 * not by the label that named which surface first recorded the session. When two
	 * harnesses reach the same route -- as the sidebar and an in-window agent-MCP session
	 * both do, both writing into a chat-session-resource -- the same adapter must claim
	 * both, or the second becomes deliverable-in-policy yet unroutable-in-practice.
	 *
	 * Undefined means the adapter serves only its own `harness`, so existing adapters are
	 * unaffected. `canDeliver` still decides on the individual identity.
	 */
	readonly serves?: readonly HarnessKind[];
	/** Whether this adapter can reach the conversation described by the identity. */
	canDeliver(identity: SessionIdentity): boolean;
	deliver(deliverable: DeliverableReply, identity: SessionIdentity): Promise<DeliveryOutcome>;
}

/**
 * Chooses the adapter for a session.
 *
 * A reply is always fetched *from a thread*, so the thread id is a fact rather than a
 * guess; the identity recorded against that thread names the harness, and the harness
 * names the adapter. Nothing in this path searches or infers.
 */
export class HarnessRegistry {
	private readonly adapters = new Map<string, HarnessAdapter>();

	constructor(
		/** Used whenever no adapter claims the harness, or the identity is not usable. */
		private readonly fallback: HarnessAdapter
	) {}

	register(adapter: HarnessAdapter): this {
		const claimed = adapter.serves ?? [adapter.harness];
		for (const harness of claimed) {
			this.adapters.set(harness, adapter);
		}
		return this;
	}

	/** The adapter for an identity, or the fallback when it cannot be delivered to. */
	adapterFor(identity: SessionIdentity): HarnessAdapter {
		const adapter = this.adapters.get(identity.harness);
		return adapter?.canDeliver(identity) ? adapter : this.fallback;
	}

	/**
	 * The harnesses a registered adapter has claimed.
	 *
	 * Exposed so an invariant test can assert that every {@link deliverableHarnesses}
	 * entry is actually served by an adapter -- the check that would have caught the
	 * agent-mcp regression, where a harness was declared deliverable by policy but no
	 * adapter existed to reach it.
	 */
	servedHarnesses(): ReadonlySet<HarnessKind> {
		return new Set(this.adapters.keys()) as ReadonlySet<HarnessKind>;
	}
}

/**
 * Keeps the better of two identities.
 *
 * Sessions are announced by more than one path, and they do not all know the same amount:
 * the transcript watcher can name the chat, the MCP server cannot see one at all. Taking
 * the newest would let a later, blinder caller erase an identity that was already exact,
 * and the reply would go from delivered to held for no reason the user could see.
 */
export function preferIdentity(
	existing: SessionIdentity | undefined,
	incoming: SessionIdentity | undefined
): SessionIdentity | undefined {
	if (!incoming) {
		return existing;
	}
	if (!existing) {
		return incoming;
	}
	const rank = (identity: SessionIdentity): number =>
		identity.confidence === 'exact' ? 2 : identity.confidence === 'derived' ? 1 : 0;
	if (rank(incoming) > rank(existing)) {
		return incoming;
	}
	if (rank(incoming) < rank(existing)) {
		return existing;
	}
	// Equally trustworthy, so the newer one wins — a task continued in a different chat
	// should follow the move rather than keep pointing at the conversation it left.
	return incoming.chat ? incoming : existing;
}

/**
 * The identity of a session, filled in from whatever the record can still tell us.
 *
 * Two rules, both learned the hard way:
 *
 * A stored identity that names no conversation must not *mask* one the session already
 * carries. Recording "this came from MCP, chat unknown" is useful — it says which harness
 * to use — but if the session also has a chat resource from the older scheme, that is the
 * missing piece rather than a contradiction, and dropping it would turn working delivery
 * into a hold on upgrade.
 *
 * A session with no identity at all but a chat resource was routable before and stays
 * routable now. Only a session with nothing is unknown.
 */
/**
 * Harnesses whose chat can honestly be identified from a transcript.
 *
 * A transcript search is a *search*: it matches a session key inside a recorded tool call.
 * That is sound only where the transcript is written by the conversation being named. A CLI
 * or external session writes no transcript of its own, so a search can only ever match
 * somebody else's — which is precisely how one task's instruction reaches another task's
 * chat. For those, no answer is the correct answer.
 */
const RESOLVABLE_BY_TRANSCRIPT: ReadonlySet<SessionIdentity['harness']> = new Set([
	'vscode-sidebar',
	'vscode-agent-mcp',
	'unknown'
]);

/** Whether a transcript search may be used to name this session's chat. */
export function mayResolveByTranscript(identity: SessionIdentity): boolean {
	// An identity that already names its chat needs no search, and must not be second-guessed.
	return !identity.chat && RESOLVABLE_BY_TRANSCRIPT.has(identity.harness);
}

/** How to describe a harness to the user, who did not choose it and cannot see it. */
export function describeHarness(harness: SessionIdentity['harness']): string {
	switch (harness) {
		case 'vscode-sidebar':
			return 'the Copilot Chat panel in VS Code';
		case 'vscode-agent-mcp':
			return 'a Copilot agent session in VS Code';
		case 'cli-runtime':
			return 'the Copilot CLI runtime';
		case 'vscode-agent-host':
			return 'a Copilot-mode chat in VS Code';
		case 'external':
			return 'a Copilot client outside this VS Code window';
		default:
			return 'a Copilot session this window cannot reach';
	}
}

export function identityOf(session: Session): SessionIdentity {
	const legacyChat: ChatHandle | undefined = session.chatSessionResource
		? { kind: 'chat-session-resource', value: session.chatSessionResource }
		: undefined;

	if (session.identity) {
		if (session.identity.chat || !legacyChat) {
			return session.identity;
		}
		return {
			...session.identity,
			chat: legacyChat,
			// The conversation is now named, so this can be delivered — but it was pieced
			// together rather than handed over, which is what `derived` means.
			confidence: session.identity.confidence === 'unknown' ? 'derived' : session.identity.confidence
		};
	}

	if (legacyChat) {
		return {
			// A Copilot-mode chat is recognisable from the reference alone, and calling it
			// "the Copilot Chat panel" in a message to the user would be plainly wrong.
			harness: isAgentHostResource(session.chatSessionResource) ? 'vscode-agent-host' : 'vscode-sidebar',
			chat: legacyChat,
			confidence: 'derived',
			capturedBy: 'resolver',
			capturedAt: session.createdAt
		};
	}

	return {
		harness: 'unknown',
		confidence: 'unknown',
		capturedBy: 'resolver',
		capturedAt: session.createdAt
	};
}

/**
 * Harnesses this extension can hand a reply back to.
 *
 * Deliberately a list of what *is* supported rather than what is not: a harness added later
 * is undeliverable until it is proven otherwise, which is the safe direction to be wrong in.
 *
 * `cli-runtime` is deliberately absent. It is a planned target, but a planned target is not
 * a working one, and listing it here would promise a delivery that no adapter can make —
 * the thread would invite a reply that is then held forever. It joins this list on the day
 * its adapter does.
 */
const DELIVERABLE_HARNESSES: ReadonlySet<SessionIdentity['harness']> = new Set([
	'vscode-sidebar',
	'vscode-agent-mcp',
	// Safe to declare here only because a session is never recorded as `vscode-agent-host`
	// without the chat handle that resolution produced -- see HarnessKind. `canDeliver`
	// still checks the handle on the individual identity.
	'vscode-agent-host'
]);

/**
 * The harnesses this extension promises it can deliver into.
 *
 * Exposed as a read-only view so the invariant test can pair it against the registry
 * without duplicating the list -- the source of truth stays in one place.
 */
export const deliverableHarnesses: ReadonlySet<HarnessKind> = DELIVERABLE_HARNESSES;

/**
 * Three states for whether a reply posted in this session's thread can reach Copilot.
 *
 * The distinction that matters is the third: `"unknown"` is *not yet identified*, not
 * *undeliverable*. A session created by the standalone MCP server records no identity —
 * that process cannot see VS Code — but when a reply arrives the relay resolves the chat
 * lazily (from the session key, or by transcript search) and delivery usually succeeds.
 * Asserting "replies here will not reach Copilot" in that state is a false negative, and
 * the user reasonably stops replying.
 *
 * The rule to preserve: if we wrongly invite a reply that cannot be routed, the existing
 * unroutable notice tells the user and the reply is retained — nothing is lost. If we
 * wrongly deny, the user does not reply at all and the work stalls, which is strictly
 * worse.
 */
export type ReplyReachability = 'yes' | 'no' | 'unknown';

export function replyReachability(identity: SessionIdentity, options?: ReplyRoutingOptions): ReplyReachability {
	if (DELIVERABLE_HARNESSES.has(identity.harness) && identity.confidence !== 'unknown') {
		return 'yes';
	}
	// A CLI session is reachable only when it carries a resumable id and the user has
	// opted in. Both are session-level facts, so neither can be inferred from the harness.
	if (canResumeCliSession(identity, options)) {
		return 'yes';
	}
	if (identity.harness === 'unknown') {
		// Not yet identified — the relay will try to resolve it when a reply arrives.
		return 'unknown';
	}
	return 'no';
}

/**
 * Whether a reply posted in this session's thread can reach Copilot.
 *
 * Every outbound message ends with an invitation to reply, so this decides whether that
 * invitation is honest. A session whose harness cannot be delivered into, or whose chat was
 * never identified, must say so *before* the user types — finding out afterwards means they
 * have already spent the instruction and believe work is underway.
 *
 * Shares its inputs with the routing decision on purpose: if a reply would be held rather
 * than delivered, the thread said so in advance.
 */
export function repliesReachChat(identity: SessionIdentity, options?: ReplyRoutingOptions): boolean {
	return replyReachability(identity, options) === 'yes';
}
