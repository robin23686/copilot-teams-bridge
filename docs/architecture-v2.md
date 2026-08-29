# Architecture — v2 (identity-first, layered)

> Status: **design**, being implemented. The v1 description lives in `architecture.md`.

---

## 1. Why the layering changed

v1 had two folders — `core/` (no `vscode` import) and `vscode/` — which kept the domain
testable but left everything else in one bucket. `bridge.ts` grew to 891 LOC and did four
unrelated jobs: it owned session records, polled Teams, formatted notifications, and ran
the expiry lifecycle. `extension.ts` (519 LOC) held routing decisions that belong to the
domain.

That is why a change in one area kept breaking another: **there was no boundary to stop
it.** The 2026-08-27 failures are all boundary failures —

| Failure | Boundary that was missing |
|---|---|
| Reply delivered to the focused chat | No *policy* owned "may this be delivered?" — the injector decided, silently |
| Reply never fetched | No single component owned "who reads a thread" |
| Reply consumed despite not being delivered | The delivery *outcome* was not part of the contract (`Promise<void>`) |
| Bridge's own post read back as a user reply | Suppression was a step callers had to remember, not an invariant |

Each is a case of a rule living in the wrong place. v2 puts each rule in exactly one layer
and makes the dependency direction enforceable.

---

## 2. The four layers

```
┌───────────────────────────────────────────────────────────────────────────┐
│  L4  HOSTS                        entry points, wiring, platform APIs     │
│      hosts/vscode/  hosts/mcp/  hosts/cli/                                │
│      · extension activation · MCP stdio server · demo CLI                 │
│      · the ONLY layer allowed to import `vscode`                          │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ depends on ▼
┌──────────────────────────────────┴────────────────────────────────────────┐
│  L3  INFRASTRUCTURE               implements ports with real I/O          │
│      infrastructure/transports/   AgencyTeams, File                       │
│      infrastructure/persistence/  Memento, JsonFile                       │
│      · knows about subprocesses, files, HTTP — never about use cases      │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ implements ▼ (ports defined in L2)
┌──────────────────────────────────┴────────────────────────────────────────┐
│  L2  APPLICATION                  use cases + ports + services            │
│      application/ports/           ThreadTransport, SessionRepository,     │
│                                   HarnessAdapter, Clock, Logger           │
│      application/services/        SessionRegistry, ActivityClock,         │
│                                   HarnessRegistry, DeliveryPipeline       │
│      application/useCases/        AnnounceSession, PostUpdate,            │
│                                   PollReplies, DeliverReply, ExpireIdle   │
│      · orchestrates; no I/O of its own, only ports                        │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ depends on ▼
┌──────────────────────────────────┴────────────────────────────────────────┐
│  L1  DOMAIN                       entities, value objects, policies       │
│      domain/session.ts  identity.ts  reply.ts  thread.ts                  │
│      domain/policies/   idle · dedup · delivery · routing                 │
│      · pure functions and types. No I/O, no vscode, no clock, no async    │
└───────────────────────────────────────────────────────────────────────────┘

Dependencies point **inward only**. L1 imports nothing of ours.
```

### Enforcement, not convention

A layering that is only documented is a layering that erodes. `npm run lint:layers`
fails the build on any upward or sideways import:

| Layer | May import |
|---|---|
| `domain/` | nothing from `src/` |
| `application/` | `domain/` only |
| `infrastructure/` | `domain/`, `application/ports/` |
| `hosts/` | anything |
| anything except `hosts/` | **never** `vscode` |

---

## 3. Design patterns, and the failure each one prevents

| Pattern | Where | Prevents |
|---|---|---|
| **Hexagonal (Ports & Adapters)** | `application/ports/` | Teams/VS Code/file specifics leaking into rules; lets every use case be tested with no I/O |
| **Strategy** | `HarnessAdapter` per harness | One `if/else` trying to serve four surfaces and being correct for none (R9) |
| **Registry** | `HarnessRegistry` | Callers switching on harness type; adding a harness touches one map |
| **Null Object** | `HoldAdapter` | A missing strategy silently falling through to "the focused chat" |
| **Repository** | `SessionRepository` port | Two processes writing one file with no arbitration |
| **Pipeline / Chain of Responsibility** | `DeliveryPipeline` stages | Delivery rules scattered across relay, injector and extension |
| **Policy (Specification)** | `domain/policies/*` | Rules such as "is this idle?" being re-implemented per caller with different answers |
| **Value Object** | `SessionIdentity`, `ActivityWindow` | Identity as loose optional strings that are easy to forget to set |
| **Observer** | `SessionLifecycle` events | Expiry/revival side effects hard-wired into the poller |
| **Factory** | `TransportFactory` | Construction rules duplicated in extension, MCP server and CLI |
| **Result object** | `DeliveryOutcome` | `Promise<void>` hiding failure — **this exact gap destroyed four user instructions** |

---

## 4. Component map

```
L1  domain/
    session.ts          Session entity, invariants, isLive()
    identity.ts         SessionIdentity, HarnessKind, ChatHandle, identityOf()
    reply.ts            InboundReply, PendingReply, DeliveryOutcome, isRetryable()
    thread.ts           ThreadRef, OutboundNotification
    messageFormat.ts    parseReply, isEmptyReply, isClosingCommand   (pure)
    policies/
      idlePolicy.ts     hasLapsed(session, now, window) — the sliding rule, one place
      dedupPolicy.ts    isAlreadyKnown(session, replyId)
      deliveryPolicy.ts mayConsume(outcome), mayAutoSubmit(context)
      routingPolicy.ts  canRouteTo(identity) — "exact|derived → yes, unknown → no"
                        repliesReachChat(identity) — same inputs, so what the
                        thread promises can never drift from what routing does

L2  application/
    ports/
      threadTransport.ts    create/post/fetch/rename
      sessionRepository.ts  read/write/byThread/byId
      harnessAdapter.ts     canDeliver/deliver
      clock.ts              now()
      logger.ts             info/warn/error/debug
    services/
      sessionRegistry.ts    single owner of records; byThread() is the routing key
      activityClock.ts      records activity from either side; slides the window
      harnessRegistry.ts    Strategy + Registry + Null Object
      deliveryPipeline.ts   dedup → identify → route → deliver → settle
      sessionLifecycle.ts   expiry/revival events (Observer)
    useCases/
      announceSession.ts    R1
      postUpdate.ts         R3
      pollReplies.ts        R2 — the ONLY reader
      deliverReply.ts       R2/R8
      expireIdleSessions.ts R6
      reviveSession.ts      R7

L3  infrastructure/
    transports/agencyTeamsTransport.ts   (unchanged)
    transports/fileTransport.ts          (unchanged)
    persistence/mementoSessionRepository.ts
    persistence/jsonFileSessionRepository.ts   shared file, merge-on-write

L4  hosts/
    vscode/extension.ts        composition root only
    vscode/adapters/sidebarAdapter.ts      Strategy: vscode-sidebar   ← Phase 1
    vscode/adapters/agentMcpAdapter.ts     Strategy: vscode-agent-mcp ← Phase 2
    vscode/adapters/cliRuntimeAdapter.ts   Strategy: cli-runtime      ← Phase 3
    vscode/adapters/holdAdapter.ts         Null Object — always available
    vscode/watchers/chatSessionWatcher.ts  captures identity at creation
    vscode/notifyTool.ts                   captures identity from the tool token
    mcp/server.ts                          write-only: creates + posts, never polls
    cli/demo.ts
```

---

## 5. Flow diagrams — every scenario

### S1 · A chat starts in VS Code → a Teams thread appears (R1)

```
User types first prompt in Copilot Chat
        │
        ▼
VS Code writes  chatSessions/<chatId>.jsonl
        │
        ▼
ChatSessionWatcher.onDidCreate            [L4 hosts/vscode]
        │  debounce 1.5 s — the file is rewritten while the response streams
        ▼
parseTranscript → { id, title, prompt }   [L1 domain]
        │
        │  ◀── THE KEY STEP: the filename IS the chat id, so identity is a
        │      fact here. v1 threw it away and searched for it later.
        ▼
AnnounceSession use case                  [L2 application]
        │   identity = { harness:'vscode-sidebar',
        │                chat:{ kind:'chat-session-resource', value:<chatId> },
        │                confidence:'exact', capturedBy:'chat-watcher' }
        ├──▶ SessionRegistry.create(session, identity)   [L2] ─▶ SessionRepository [L3]
        └──▶ ThreadTransport.createThread(...)           [L3]
                    │
                    ▼
             Teams thread exists ── thread.id recorded against the session
                    │
                    ▼
             suppressOwnMessage(postedMessageId)
             (our own post must never be read back as a user reply)
```

### S2 · A Teams reply continues the work (R2 + R8)

```
                    ┌──── every pollIntervalMs (10 s) ────┐
                    ▼                                      │
PollReplies use case  [L2]                                 │
  for each live session (IdlePolicy.isLive)                │
        │                                                  │
        ▼                                                  │
  ThreadTransport.fetchReplies(thread, since)  [L3] ───────┘
        │
        ▼  InboundReply[]
DeliveryPipeline  [L2] ── five stages, each able to stop the chain
        │
   ┌────┴─────────────────────────────────────────────────────────┐
   │ 1  DEDUP      DedupPolicy.isAlreadyKnown(session, reply.id)   │
   │               seen ∪ delivered ∪ ownPostIds → drop            │
   ├───────────────────────────────────────────────────────────────┤
   │ 2  IDENTIFY   SessionRegistry.byThread(reply.threadId)        │
   │               ← the thread id is a FACT: it is how the reply   │
   │                 was fetched. No searching, no guessing.        │
   ├───────────────────────────────────────────────────────────────┤
   │ 3  ROUTE      HarnessRegistry.adapterFor(identity)            │
   │               unknown/undeliverable → HoldAdapter (Null Obj)  │
   ├───────────────────────────────────────────────────────────────┤
   │ 4  DELIVER    adapter.deliver(...) → DeliveryOutcome          │
   ├───────────────────────────────────────────────────────────────┤
   │ 5  SETTLE     DeliveryPolicy.mayConsume(outcome)              │
   │               delivered|held → consume + tombstone            │
   │               unroutable|failed → RETAIN for a later pass     │
   └───────────────────────────────────────────────────────────────┘
        │
        ├─ consumed ──▶ ActivityClock.record('teams-reply')  → window slides
        │               └▶ acknowledgeReply → "Got it — working on this."
        │                     └▶ suppressOwnMessage(id)   ◀── or it answers itself
        │
        └─ retained ──▶ postUnroutableNotice (once) and try again next pass
```

### S3 · Replying in VS Code still updates Teams (R3)

```
User types a turn in Copilot Chat
        │
        ▼
chatSessions/<chatId>.jsonl  changes
        │
        ▼
ChatSessionWatcher.onDidChange     [L4]
        │
        ▼
parseTranscript → latest user turn
        │
        ▼  ┌───────────────────────────────────────────────┐
        ├──┤ ECHO GUARD                                     │
        │  │ Was this turn injected BY the bridge?          │
        │  │  yes → record activity, post nothing           │
        │  │  no  → continue                                │
        │  └───────────────────────────────────────────────┘
        │      Without it: Teams reply → injected as a turn →
        │      watcher sees a turn → posts to Teams → …
        ▼
PostUpdate use case  [L2]        ← "post on every turn" (user decision, 2026-08-27)
        ├──▶ ActivityClock.record('chat-turn')   ← slides the 2 h window (R5)
        └──▶ ThreadTransport.postToThread(...)   [L3]
                    └──▶ suppressOwnMessage(postedMessageId)
```

### S4 · The sliding 2-hour window (R4 + R5)

```
   activity ──────┬───────────────┬─────────────────────────┬──────────▶ time
                  │               │                         │
             teams-reply      chat-turn                  notify
                  │               │                         │
                  ▼               ▼                         ▼
        ActivityClock.record(source)  [L2]
                  │
                  ▼
        session.lastActivityAt = now
        session.lastActivitySource = source
                  │
                  ▼
        IdlePolicy.hasLapsed(session, now, 2 h)   [L1 — pure, one definition]
                  │
        ┌─────────┴──────────┐
        │ now − last < 2 h   │  → live: keep polling
        │ now − last ≥ 2 h   │  → lapsed: go to S5
        └────────────────────┘

   Every source resets it. v1 counted only teams-reply and notify, so a
   conversation carried on entirely in the editor was declared dead while
   the user was mid-sentence in it.

   One window (2 h) for every harness — the MCP path's hard-coded 4 h is gone.
```

### S5 · Going quiet after 2 h (R6)

```
ExpireIdleSessions use case  [L2] ── runs on the same tick as the poller
        │
        ▼
for each session where IdlePolicy.hasLapsed(...)
        │
        ├──▶ SessionLifecycle.emit('expired', session)     [Observer]
        │            │
        │            ▼
        │      postExpiryNotice → Teams:
        │      "quiet for 2 hours … replies here are no longer being read.
        │       Open the chat in VS Code to revive it."
        │            └──▶ suppressOwnMessage(id)
        │
        └──▶ session.expiredAt = now
                     │
                     ▼
             PollReplies SKIPS this thread entirely   ← per user's spec
                     │
                     └── every other session keeps polling, untouched
```

### S6 · Reviving it in VS Code (R7)

```
User reopens / types in that chat
        │
        ▼
ChatSessionWatcher.onDidChange  [L4] ─▶ chatId ─▶ SessionRegistry.byChat(chatId)
        │
        ▼
ActivityClock.record('revival')  [L2]
        │
        ├── was expiredAt set?  ── no ──▶ just slide the window (S4)
        │
        └── yes
             ├──▶ session.expiredAt = undefined
             ├──▶ SessionLifecycle.emit('revived', session)   [Observer]
             │           └──▶ postResumedNotice → Teams:
             │                "back online — replies here are being read again"
             └──▶ PollReplies resumes this thread on the next tick
                  (watermark deliberately left alone, so anything sent while
                   it was quiet is still collected rather than skipped)
```

### S7 · A reply whose chat is unknown (the safety path)

Two halves, and the first is what makes the second rare.

**7a — say so in advance, on every update**

```
PostUpdate / AnnounceSession / any outbound notification
        │
        ▼
RoutingPolicy.repliesReachChat(identity)   [L1 domain — same inputs as routing]
        │
   ┌────┴─────┐
   │ true     │ ─▶ footer: "Reply in this thread to send Copilot a new instruction."
   │ false    │ ─▶ footer: "Replies here will not reach Copilot.
   └──────────┘             Open this chat in VS Code to give it the next instruction."
        │
        ▼
   Teams message

   The rule shares its inputs with the routing decision on purpose: if a reply
   WOULD be held, the thread said so BEFORE it was typed. Getting the update but
   no way to answer is a limitation; being invited to answer and silently
   ignored is a broken promise.

   Applies to the expiry notice and the undeliverable notice too — both used to
   state that replies were not being read and then invite one in the footer.
```

**7b — and if one is sent anyway, never destroy it**

```
reply ──▶ stage 2 IDENTIFY ──▶ identity.confidence = 'unknown'
                                        │
                                        ▼
                       RoutingPolicy.canRouteTo(identity) = false
                                        │
                                        ▼
                       HarnessRegistry.adapterFor(...) → HoldAdapter [Null Object]
                                        │
                                        ▼
                              returns 'unroutable'
                                        │
              ┌─────────────────────────┴──────────────────────────┐
              ▼                                                     ▼
   DeliveryPolicy.mayConsume('unroutable') = FALSE      postUnroutableNotice → Teams
              │                                          "could not be delivered …
              ▼                                           open the chat in VS Code"
   reply STAYS in pending, no tombstone
              │
              ▼
   retried on every later pass — so the moment identity becomes known
   (the user opens that chat, the transcript lands) it is delivered

   ◀── v1 consumed it here and wrote a permanent 'delivered' tombstone.
       Four real user instructions were destroyed that way on 2026-08-27.
       The `Promise<void>` signature is what made that invisible.
```

### S8 · Two processes, one file (writer arbitration)

```
   MCP server [L4 hosts/mcp]              Extension [L4 hosts/vscode]
   WRITE-ONLY                             SOLE READER
        │                                        │
        │ creates session, posts updates         │ polls every thread
        ▼                                        ▼
   JsonFileSessionRepository  ◀────────────────▶ JsonFileSessionRepository
        │                                        │
        └────────────┬───────────────────────────┘
                     ▼
            merge-on-write, always:
              read fresh → apply own delta → write
              never write a snapshot taken before the change

   v1 let whoever created a session be the only one polling it. The MCP
   server is spawned per tool call and exits with the turn, so for most of
   a session's life nothing was reading — replies sat in Teams unread.
   Making the extension the sole reader removes the failure by construction
   rather than adding a second reader to race with the first.
```

---

## 6. Phase boundaries (R9)

Only the sidebar adapter is built in Phase 1. Everything else resolves to `HoldAdapter`,
which refuses cleanly and says so in Teams — so an unfinished harness is *visibly* unfinished
rather than quietly wrong.

| Harness | Phase | Identity source | Adapter |
|---|---|---|---|
| `vscode-sidebar` | **1** | transcript filename (`exact`) | `SidebarAdapter` |
| `vscode-agent-mcp` | 2 | tool token, else transcript (`derived`) | `AgentMcpAdapter` |
| `cli-runtime` | 3 | debug-log folder — **hypothesis, to verify** | `CliRuntimeAdapter` |
| `external` | — | none | `HoldAdapter` |
| `unknown` | — | none | `HoldAdapter` |
