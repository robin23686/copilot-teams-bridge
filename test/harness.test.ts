import * as assert from 'assert';
import { describe, it } from 'node:test';
import { deliverableHarnesses, HarnessRegistry, identityOf, mayResolveByTranscript, preferIdentity, replyReachability, repliesReachChat, worthRetrying } from '../src/application/services/harness';
import type { DeliveryOutcome, HarnessAdapter } from '../src/application/services/harness';
import type { HarnessKind, Session, SessionIdentity } from '../src/domain/types';

function sessionWith(extra: Partial<Session> = {}): Session {
	return {
		id: 's1',
		key: 'task',
		title: 'A task',
		createdAt: '2026-01-01T00:00:00Z',
		lastActivityAt: '2026-01-01T00:00:00Z',
		seenReplyIds: [],
		status: 'progress',
		...extra
	};
}

function identity(extra: Partial<SessionIdentity> = {}): SessionIdentity {
	return {
		harness: 'vscode-sidebar',
		chat: { kind: 'chat-session-resource', value: 'vscode-chat-session://local/abc' },
		confidence: 'exact',
		capturedBy: 'chat-watcher',
		capturedAt: '2026-01-01T00:00:00Z',
		...extra
	};
}

class StubAdapter implements HarnessAdapter {
	constructor(
		readonly harness: SessionIdentity['harness'],
		private readonly usable = true,
		readonly serves?: readonly HarnessKind[]
	) {}
	canDeliver(candidate: SessionIdentity): boolean {
		return this.usable && candidate.confidence !== 'unknown';
	}
	async deliver(): Promise<DeliveryOutcome> {
		return 'delivered';
	}
}

const hold = new (class implements HarnessAdapter {
	readonly harness = 'unknown' as const;
	canDeliver(): boolean {
		return false;
	}
	async deliver(): Promise<DeliveryOutcome> {
		return 'unroutable';
	}
})();

describe('identityOf', () => {
	// Upgrading must never turn working delivery into a hold, so a session that was
	// routable under the old scheme has to stay routable under the new one.
	it('derives an identity from a session recorded before identities existed', () => {
		const derived = identityOf(sessionWith({ chatSessionResource: 'vscode-chat-session://local/old' }));
		assert.strictEqual(derived.harness, 'vscode-sidebar');
		assert.strictEqual(derived.chat?.value, 'vscode-chat-session://local/old');
		assert.notStrictEqual(derived.confidence, 'unknown', 'it was deliverable before and must remain so');
	});

	// Recording "harness known, chat unknown" is useful, but it must not hide a chat the
	// session already carries -- that would be worse than recording nothing at all.
	it('does not let an identity without a chat mask one the session still has', () => {
		const merged = identityOf(
			sessionWith({
				chatSessionResource: 'vscode-chat-session://local/old',
				identity: identity({ harness: 'vscode-agent-mcp', chat: undefined, confidence: 'unknown' })
			})
		);
		assert.strictEqual(merged.chat?.value, 'vscode-chat-session://local/old', 'the known chat must survive');
		assert.strictEqual(merged.harness, 'vscode-agent-mcp', 'while keeping the harness that was recorded');
		assert.notStrictEqual(merged.confidence, 'unknown', 'and it is now deliverable');
	});

	it('reports a session with nothing recorded as unknown', () => {
		const derived = identityOf(sessionWith());
		assert.strictEqual(derived.harness, 'unknown');
		assert.strictEqual(derived.confidence, 'unknown');
	});

	it('keeps a recorded identity that already names its chat', () => {
		const recorded = identity();
		assert.deepStrictEqual(identityOf(sessionWith({ identity: recorded })), recorded);
	});
});

describe('preferIdentity', () => {
	// More than one path announces a session and they do not know the same amount. A later,
	// blinder caller must not erase what an earlier one established.
	it('keeps the better identity rather than the newer one', () => {
		const exact = identity({ confidence: 'exact' });
		const blind = identity({ chat: undefined, confidence: 'unknown', capturedBy: 'mcp-ingest' });
		assert.deepStrictEqual(preferIdentity(exact, blind), exact, 'a blind caller must not erase a known chat');
		assert.deepStrictEqual(preferIdentity(blind, exact), exact, 'and must be upgraded by a knowing one');
	});

	it('follows the move when a task continues in a different chat', () => {
		const first = identity({ chat: { kind: 'chat-session-resource', value: 'a' } });
		const second = identity({ chat: { kind: 'chat-session-resource', value: 'b' } });
		assert.strictEqual(preferIdentity(first, second)?.chat?.value, 'b');
	});

	// A weaker identity that still names *a* chat is the dangerous case: it looks usable, so
	// nothing downstream would question it, and the reply would go to a conversation guessed
	// from a transcript instead of the one the host actually named.
	it('does not let a guessed chat replace one the host confirmed', () => {
		const confirmed = identity({ confidence: 'exact', chat: { kind: 'chat-session-resource', value: 'real' } });
		const guessed = identity({ confidence: 'derived', chat: { kind: 'chat-session-resource', value: 'guess' } });
		assert.strictEqual(
			preferIdentity(confirmed, guessed)?.chat?.value,
			'real',
			'an exact identity must survive a merely derived one'
		);
	});

	it('leaves the existing identity alone when nothing new is offered', () => {
		const existing = identity();
		assert.deepStrictEqual(preferIdentity(existing, undefined), existing);
	});
});

describe('HarnessRegistry', () => {
	it('routes to the adapter for the recorded harness', () => {
		const sidebar = new StubAdapter('vscode-sidebar');
		const registry = new HarnessRegistry(hold).register(sidebar);
		assert.strictEqual(registry.adapterFor(identity()), sidebar);
	});

	// The failure this whole design exists to prevent: with no adapter, delivery used to
	// fall through to whichever chat was focused, putting one task's instruction into
	// another task's conversation.
	it('holds rather than falls through when no adapter claims the harness', () => {
		const registry = new HarnessRegistry(hold).register(new StubAdapter('vscode-sidebar'));
		assert.strictEqual(registry.adapterFor(identity({ harness: 'cli-runtime' })), hold);
	});

	// An adapter that exists but cannot reach this particular conversation is no better
	// than no adapter at all, and must not be handed the reply anyway.
	it('holds when the adapter cannot reach the conversation', () => {
		const registry = new HarnessRegistry(hold).register(new StubAdapter('vscode-sidebar'));
		assert.strictEqual(registry.adapterFor(identity({ chat: undefined, confidence: 'unknown' })), hold);
	});

	// The regression this whole change exists to close. An adapter reached by a route
	// (a chat-session-resource) is reached by that route no matter which harness label
	// was recorded against the session -- so one adapter must be able to claim more than
	// one harness. Without this, agent-MCP sessions are declared deliverable in policy
	// yet held forever in practice, and the reply retries every ten seconds.
	it('routes every harness an adapter claims through `serves` to that adapter', () => {
		const shared = new StubAdapter('vscode-sidebar', true, ['vscode-sidebar', 'vscode-agent-mcp']);
		const registry = new HarnessRegistry(hold).register(shared);
		assert.strictEqual(registry.adapterFor(identity({ harness: 'vscode-sidebar' })), shared);
		assert.strictEqual(registry.adapterFor(identity({ harness: 'vscode-agent-mcp' })), shared);
	});

	// `serves` is optional, so an adapter written before it existed keeps working. The
	// registry still indexes it under its primary `harness`.
	it('falls back to `harness` when `serves` is not set', () => {
		const legacy = new StubAdapter('vscode-sidebar');
		const registry = new HarnessRegistry(hold).register(legacy);
		assert.strictEqual(registry.adapterFor(identity({ harness: 'vscode-sidebar' })), legacy);
		assert.strictEqual(registry.adapterFor(identity({ harness: 'vscode-agent-mcp' })), hold);
	});

	// The structural invariant. If a harness is on the deliverable list, an adapter must
	// exist that claims it -- otherwise the reachability check tells the user "yes, reply
	// here" while routing silently refuses. This is exactly what the log line
	// `harness "vscode-agent-mcp" (confidence "exact") cannot be delivered into from this
	// window` reported, on a session whose chat had already been resolved.
	it('has an adapter registered for every harness declared deliverable', () => {
		const shared = new StubAdapter('vscode-sidebar', true, ['vscode-sidebar', 'vscode-agent-mcp']);
		const registry = new HarnessRegistry(hold).register(shared);
		const served = registry.servedHarnesses();
		for (const harness of deliverableHarnesses) {
			assert.ok(
				served.has(harness),
				`${harness} is declared deliverable but no registered adapter serves it`
			);
		}
	});
});

describe('replyReachability', () => {
	// The distinction the boolean cannot make. "unknown" is not yet identified, not
	// undeliverable: the relay resolves the chat lazily when a reply arrives, and delivery
	// usually succeeds. Asserting "will not reach Copilot" in that state stops the user
	// replying and the work stalls.
	it('is "yes" for a known chat on a deliverable harness', () => {
		assert.strictEqual(replyReachability(identity()), 'yes');
		assert.strictEqual(replyReachability(identity({ confidence: 'derived' })), 'yes');
		assert.strictEqual(replyReachability(identity({ harness: 'vscode-agent-mcp' })), 'yes');
	});

	it('is "unknown" when the identity has not been captured yet', () => {
		assert.strictEqual(
			replyReachability(identity({ harness: 'unknown', chat: undefined, confidence: 'unknown' })),
			'unknown'
		);
	});

	it('is "no" for a harness with no adapter', () => {
		assert.strictEqual(replyReachability(identity({ harness: 'cli-runtime' })), 'no');
		assert.strictEqual(replyReachability(identity({ harness: 'external' })), 'no');
	});

	// repliesReachChat is implemented in terms of the new function; every existing caller
	// keeps its current boolean.
	it('keeps repliesReachChat aligned with the tri-state', () => {
		assert.strictEqual(repliesReachChat(identity()), true);
		assert.strictEqual(repliesReachChat(identity({ confidence: 'derived' })), true);
		assert.strictEqual(repliesReachChat(identity({ harness: 'vscode-agent-mcp' })), true);
		assert.strictEqual(
			repliesReachChat(identity({ harness: 'unknown', chat: undefined, confidence: 'unknown' })),
			false
		);
		assert.strictEqual(repliesReachChat(identity({ harness: 'cli-runtime' })), false);
		assert.strictEqual(repliesReachChat(identity({ harness: 'external' })), false);
		assert.strictEqual(repliesReachChat(identity({ confidence: 'unknown' })), false);
	});
});

describe('repliesReachChat', () => {
	// Every message ends by inviting a reply, so this decides whether that invitation is
	// honest. It shares its inputs with routing on purpose.
	it('is false for a harness this window cannot deliver into', () => {
		assert.strictEqual(repliesReachChat(identity({ harness: 'external' })), false);
		assert.strictEqual(repliesReachChat(identity({ harness: 'unknown' })), false);
	});

	it('is false when the conversation was never established', () => {
		assert.strictEqual(repliesReachChat(identity({ confidence: 'unknown' })), false);
	});

	it('is true for a harness whose conversation is known', () => {
		assert.strictEqual(repliesReachChat(identity()), true);
		assert.strictEqual(repliesReachChat(identity({ confidence: 'derived' })), true);
	});

	// If the promise and the routing decision could disagree, the thread would invite a
	// reply that delivery then refuses -- which is the broken promise, in two places.
	it('agrees with the routing decision for every harness', () => {
		const registry = new HarnessRegistry(hold).register(new StubAdapter('vscode-sidebar'));
		for (const harness of ['vscode-sidebar', 'vscode-agent-mcp', 'cli-runtime', 'external', 'unknown'] as const) {
			for (const confidence of ['exact', 'derived', 'unknown'] as const) {
				const candidate = identity({ harness, confidence });
				const routable = registry.adapterFor(candidate) !== hold;
				if (routable) {
					assert.ok(
						repliesReachChat(candidate),
						`${harness}/${confidence} is deliverable, so the thread must not say otherwise`
					);
				}
			}
		}
	});
});

describe('mayResolveByTranscript', () => {
	// A transcript search matches a session key inside a recorded tool call. A CLI or
	// external session writes no transcript of its own, so a match can only ever be some
	// other conversation's -- which is how one task's instruction reaches another's chat.
	it('refuses for a harness that writes no transcript of its own', () => {
		assert.strictEqual(mayResolveByTranscript(identity({ chat: undefined, harness: 'cli-runtime' })), false);
		assert.strictEqual(mayResolveByTranscript(identity({ chat: undefined, harness: 'external' })), false);
	});

	it('allows it for harnesses whose own transcript records the call', () => {
		assert.strictEqual(mayResolveByTranscript(identity({ chat: undefined, harness: 'vscode-sidebar' })), true);
		assert.strictEqual(mayResolveByTranscript(identity({ chat: undefined, harness: 'vscode-agent-mcp' })), true);
	});

	// Searching when the answer is already recorded is how an exact identity gets
	// second-guessed by a weaker one.
	it('refuses when the chat is already known', () => {
		assert.strictEqual(mayResolveByTranscript(identity()), false);
	});
});

describe('worthRetrying', () => {
	// Keeping a reply is right when the chat merely has not been identified yet: opening it
	// makes the reply deliverable, and discarding it would destroy an instruction.
	it('keeps a reply whose chat may still be identified', () => {
		assert.strictEqual(worthRetrying('unroutable', identity({ chat: undefined, harness: 'unknown' })), true);
	});

	// It is wrong when the harness itself cannot be reached from this window. No amount of
	// waiting changes that, so the reply would be re-read on every pass forever.
	it('releases a reply for a harness this window cannot reach', () => {
		assert.strictEqual(worthRetrying('unroutable', identity({ chat: undefined, harness: 'cli-runtime' })), false);
		assert.strictEqual(worthRetrying('unroutable', identity({ chat: undefined, harness: 'external' })), false);
	});

	// A transient failure is worth another attempt whatever the harness -- the reply was
	// deliverable, something simply went wrong on the way.
	it('always retries a transient failure', () => {
		assert.strictEqual(worthRetrying('failed', identity({ chat: undefined, harness: 'cli-runtime' })), true);
	});

	it('never retries a reply that was actually delivered', () => {
		assert.strictEqual(worthRetrying('delivered', identity()), false);
		assert.strictEqual(worthRetrying('held', identity()), false);
	});

	// The whole point of `abandoned`: it is terminal. If it were retried, the injector would
	// keep short-circuiting to abandoned on every poll, logging the same explanation and
	// posting the same Teams failure notice forever — which is the third bug this exists
	// to close.
	it('never retries a reply the injector has given up on', () => {
		assert.strictEqual(worthRetrying('abandoned', identity({ chat: undefined, harness: 'unknown' })), false);
		assert.strictEqual(worthRetrying('abandoned', identity({ chat: undefined, harness: 'vscode-sidebar' })), false);
	});
});