# Feature Plan: v2 — Identity-First Redesign

| Field | Value |
|-------|-------|
| Status | PENDING APPROVAL |
| Created | 2026-08-27 |
| Last Updated | 2026-08-27 |
| Approved | No |
| Owner | robin23686 |
| Branch | TBD (ask before Stage 2) |
| Spec File | User conversation, 2026-08-27 (10 numbered goals) |
| Deployed | Local VSIX only |

---

## 1. Why redesign

Every bug chased on 2026-08-27 traces to **two structural faults**, not to ten separate
defects. Fixing them one at a time is why each fix appeared to work and then broke
something else.

### Fault 1 — identity is *guessed after the fact* instead of *captured at the source*

A Teams reply has to end up in the chat that started the work. Today the chat is
discovered **later**, by searching up to 60 `.jsonl` transcripts for the session key
(`ChatSessionResolver`). That is a heuristic standing in for a fact that was available
and thrown away:

| Moment | Chat identity available? | Recorded? |
|---|---|---|
| `ChatSessionWatcher` sees a new transcript | **Yes** — the filename *is* the chat session id | ❌ discarded; only `chat-<id>` is used as a key |
| `notifyTool` invoked in-process | **Yes** — `toolInvocationToken.sessionResource` | ✅ recorded |
| MCP server `teams_notify` | **No** — different process, no VS Code API | ❌ nothing to record |
| CLI runtime | **No** — writes no transcript at all | ❌ never resolvable |

When resolution fails, delivery used to fall back to "the focused chat". Proven from
VS Code's own source: `workbench.action.chat.open` is registered with no mode argument, so
it always calls `revealWidget()`, which resolves `chatWidgetService.lastFocusedWidget`; and
`openSessionInEditorGroup` has `getOptions(){return{}}` — no `preserveFocus` — so revealing
a chat *focuses* it. **The bridge's own correct delivery therefore armed the next
misroute**, and reading the misrouted message focused that chat again. Self-reinforcing.

### Fault 2 — session ownership is split across a process that is not always alive

Whoever created a session was the only process that polled its Teams thread.

- Extension → polls `globalState` sessions. Alive whenever VS Code is.
- MCP server → polls `~/.copilot-teams-bridge/sessions.json`. **Spawned per tool call and
  exits with the turn** — precisely absent during the gap when a reply is most likely.

`bridge.ts:371` was the only `fetchReplies` call site in the codebase, and
`AgentReplyRelay` had no transport at all — it only drained what the MCP server had already
written. Verified against live Teams: two replies sat in the thread in nobody's seen-list,
never fetched.

> Partially fixed in `84bdaa2` (the extension now reads on the server's behalf). v2 makes
> single-ownership a **structural property** rather than a second reader bolted on.

### What this costs today

| Symptom seen | Actually caused by |
|---|---|
| Reply landed in the wrong chat | Fault 1 |
| Reply not picked up at all | Fault 2 |
| Reply picked up much later / in a burst | Fault 2 |
| Same instruction delivered repeatedly | Fault 2 (two writers, one file) |
| "Fixing one thing breaks another" | Both — every fix was a downstream patch |

### Observed live, 2026-08-27 20:12 — the current cost of Fault 1

A reply to this very plan's thread was fetched, then **deliberately withheld**:

```
20:12:19 [info]    Relaying a Teams reply for agent session "v2 redesign plan…"
20:12:20 [warning] Not injecting…: its chat could not be identified, and the
                   focused chat is not a safe guess.
```

`chatSessionResource` was `NONE`; the transcript fallback could not help because this is a
`cli-runtime` session whose transcript was 38 minutes stale, and the three transcripts that
*did* contain the session key contained it as prose rather than as a tool call — so
`findChatSessionFor` correctly refused to match rather than guess.

The user was told in Teams, and the notice **names its own root cause**: *"This happens when
the chat keeps no transcript for the bridge to match, such as a Copilot CLI session."*

This is the hold behaviour working exactly as designed — and it shows the shape of the
remaining problem precisely. **The previous fix traded misrouting for silence.** Both are
symptoms of identity being unknown at delivery time, which is what R8 removes: an identity
recorded at creation is never unknown, so neither branch is ever reached.

---

## 2. User journeys

| # | Who | Wants | Success looks like |
|---|---|---|---|
| J1 | Robin, at his desk | Start a chat in VS Code and have a Teams thread appear for it | Thread exists within seconds, titled after the task |
| J2 | Robin, on his phone | Reply in Teams and have Copilot pick it up and continue | Copilot acknowledges and resumes **in the originating chat**, within one poll interval |
| J3 | Robin, back at his desk | Reply in VS Code instead — Teams should stay in sync | Teams thread shows he answered in the editor; work continues |
| J4 | Robin, returning after lunch | Know whether the thread is still live | Replies inside 2 h always work; after 2 h idle Teams tells him it has gone quiet and how to revive it |
| J5 | Robin, reviving | Reopen the chat in VS Code and carry on from Teams again | Teams gets a "back online" note and replies work again |

---

## 3. Requirements

Traceable to the ten goals as given.

| Req | Requirement | Source | Priority | State today |
|---|---|---|---|---|
| **R1** | Starting a chat in VS Code opens a new Teams thread for it | Goal 1 | Must | ⚠️ Partial — `ChatSessionWatcher` announces, but only for the sidebar harness and it discards the chat id |
| **R2** | A Teams reply is picked up, acknowledged, and continues the work | Goal 2 | Must | ⚠️ Works only when routing succeeds and a poller is alive |
| **R3** | Replying in Copilot chat still posts an update to Teams and continues | Goal 3 | Must | ❌ Not built — updates only happen if the model chooses to call the notify tool |
| **R4** | A thread stays live for 2 h; any reply inside that window is picked up | Goal 4 | Must | ⚠️ Split: sidebar is already 2 h (`sessionIdleMinutes`, default 120); the MCP path is **4 h and not configurable** (`Bridge` fallback, `stdio.ts` passes no value). The window is also not reset by all activity |
| **R5** | The 2 h window is a **sliding** timer, reset by the last turn from *either* side | Goal 5 | Must | ❌ Only Teams replies and explicit `notify` calls reset it; a pure in-editor turn does not |
| **R6** | After 2 h idle: post a note in Teams, stop polling *that* thread, keep polling others | Goal 6 | Must | ⚠️ Notice exists, but expired threads keep being polled at 1/6 rate for 24 h |
| **R7** | Reviving the chat in VS Code posts a note to Teams and resumes polling | Goal 7 | Must | ⚠️ `extendSession` exists but is command-driven, not triggered by editor activity |
| **R8** | Capture thread ↔ chat ↔ **harness type** at session creation; route inbound by thread id → identity → harness-specific injector | Goal 8 | Must | ❌ The core gap. Identity is re-derived by transcript search; there is no harness concept at all |
| **R9** | Perfect one harness first, then extend — not all at once | Goal 9 | Must | ❌ Current code tries to be harness-agnostic and is correct for none |
| **R10** | Redesign and refactor the existing code; do not discard it | Goal 10 | Must | — governs how R1–R9 are delivered |
| **R11** | When a session's chat cannot receive replies, keep sending updates but state in the thread that a reply will not reach Copilot and that the next instruction must be given in VS Code | Goal 11 (2026-08-28) | Must | ✅ **Done** — footer now warns instead of inviting; expiry and undeliverable notices no longer contradict their own body |

---

## 4. Target architecture

```
┌──────────────────────── VS Code extension host (single owner) ────────────────────────┐
│                                                                                        │
│   ChatSessionWatcher ──────┐                                                           │
│   (transcripts .jsonl)     │  captures: chat id + harness + first prompt               │
│                            ▼                                                           │
│   notifyTool ────────▶ SessionRegistry ◀──────── McpIngest (file, write-only)          │
│   (sessionResource)     │  thread ⇄ chat ⇄ harness, one record, one writer             │
│                         │                                                              │
│                         ├──▶ ActivityClock ── sliding 2 h, fed by BOTH sides           │
│                         │        │                                                     │
│                         │        └──▶ LifecycleNotifier ── expiry / revival notes      │
│                         │                                                              │
│                         └──▶ Poller (the ONLY reader) ──▶ Teams transport              │
│                                     │                                                  │
│                                     ▼                                                  │
│                              DeliveryPipeline                                          │
│                              dedup → identity lookup → adapter dispatch                │
│                                     │                                                  │
│                    ┌────────────────┼────────────────┬──────────────────┐              │
│                    ▼                ▼                ▼                  ▼              │
│            SidebarAdapter    AgentMcpAdapter   CliRuntimeAdapter   HoldAdapter          │
│              (Phase 1)         (Phase 2)         (Phase 3)      (unknown identity)      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Two invariants the design must make impossible to violate:**

1. **One reader.** Only the extension calls `fetchReplies`. The MCP server becomes
   write-only: it creates/updates session records and posts, never polls. This kills
   Fault 2 by construction rather than by adding a second reader.
2. **Identity is written once, at creation, by whoever has it — and is never guessed.**
   If it is unknown, that is recorded as a *fact* (`confidence: 'unknown'`) and the reply is
   held with a note to Teams. Guessing is not a fallback.

### Inbound routing (R8)

```
Teams reply
   │
   ├─ thread id ──▶ SessionRegistry.byThread(threadId)   ← primary key, always known
   │                        │
   │                        ▼
   │                 SessionIdentity { harness, chat?, confidence }
   │                        │
   │                        ▼
   └───────────▶ HarnessRegistry.adapterFor(identity.harness)
                            │
                  ┌─────────┴─────────┐
             canDeliver?          cannot
                  │                   │
                  ▼                   ▼
             adapter.deliver     hold + notify Teams
```

The thread id is *always* known for an inbound reply — it is how the reply was fetched.
So routing starts from a fact, not a search.

---

## 5. Domain model changes

```ts
export type HarnessKind =
  | 'vscode-sidebar'    // Phase 1 — Copilot Chat panel/editor in VS Code
  | 'vscode-agent-mcp'  // Phase 2 — agent session in VS Code, speaks MCP over stdio
  | 'cli-runtime'       // Phase 3 — Copilot CLI runtime hosted in VS Code
  | 'external'          // Claude Desktop, Cursor, standalone CLI — hold only
  | 'unknown';

export interface ChatHandle {
  /** Harness-specific. Sidebar: the chat session id behind vscode-chat-session://local/… */
  kind: 'chat-session-resource' | 'cli-debug-log' | 'none';
  value: string;
}

export interface SessionIdentity {
  harness: HarnessKind;
  chat?: ChatHandle;
  /** exact = handed to us by the host; derived = inferred; unknown = do not guess. */
  confidence: 'exact' | 'derived' | 'unknown';
  capturedBy: 'chat-watcher' | 'notify-tool' | 'mcp-ingest' | 'resolver';
  capturedAt: string;
}
```

`Session` gains `identity: SessionIdentity` and keeps `chatSessionResource` as a
**derived accessor** during migration so nothing downstream breaks in one step (R10).

### Activity model (R4, R5)

```ts
export interface ActivityRecord {
  lastActivityAt: string;
  lastActivitySource: 'teams-reply' | 'chat-turn' | 'notify' | 'revival';
}
```

Sliding window = `now - lastActivityAt > idleMs`. The fix for R5 is simply that
**`chat-turn` becomes a source**, fed by the transcript watcher's `onDidChange`, which
already fires — it is currently used only to detect *new* sessions.

---

## 6. Component disposition (R10 — refactor, don't discard)

Current source: **4,455 LOC across 23 files**, tests **3,032 LOC / 185 tests**.

| Component | LOC | Disposition | Why |
|---|---|---|---|
| `core/transports/agencyTeamsTransport.ts` | 449 | **Keep as-is** | Works; subprocess restart on lapse already handled |
| `core/transports/fileTransport.ts` | 106 | **Keep as-is** | Test/demo transport |
| `core/messageFormat.ts` | 223 | **Keep as-is** | Parsing/cleaning is sound and well covered |
| `core/sessionMerge.ts` | 56 | **Keep**, simplify later | Two-writer reconciliation; can shrink once single-writer lands |
| `core/chatTranscript.ts` | 87 | **Keep, extend** | Add "latest user turn" parsing for R3/R5 |
| `core/chatSessionLink.ts` | 156 | **Keep, narrow** | Resource build/parse stays; transcript *search* moves behind `resolver` confidence='derived' |
| `mcp/jsonRpc.ts`, `mcp/stdio.ts` | 177 | **Keep as-is** | Protocol plumbing |
| `vscode/config.ts`, `setup.ts`, `mcpProvider.ts` | 334 | **Keep, extend** | New settings only |
| `core/bridge.ts` | **891** | **Split** → `SessionRegistry`, `Poller`, `Notifier`, `Lifecycle` | Single largest file; four responsibilities in one class |
| `vscode/extension.ts` | **519** | **Reduce to composition root** | Currently holds logic that belongs in components |
| `vscode/agentReplyRelay.ts` | 310 | **Generalise → `DeliveryPipeline`** | Already the dedup/queue/deliver path; becomes harness-agnostic |
| `vscode/chatInjector.ts` | 198 | **Becomes `SidebarAdapter`** | Its logic *is* the sidebar harness strategy |
| `vscode/chatSessionResolver.ts` | 91 | **Demote to fallback** | Only runs for legacy records with no captured identity |
| `vscode/chatSessionWatcher.ts` | 134 | **Extend** | Must record identity (R8) and emit activity (R5) |
| `mcp/server.ts` | 485 | **Make write-only** | Remove polling; keeps notify/create |
| `vscode/notifyTool.ts` | 188 | **Extend** | Record `harness: 'vscode-agent-mcp'`/`'vscode-sidebar'` + `confidence: 'exact'` |
| **New** | ~250 | `harness/registry.ts`, `harness/adapters/*.ts`, `core/activityClock.ts` | R8/R9 |

**Nothing is deleted.** Two files are renamed to what they already are; one is split.

---

## 7. Phased delivery (R9)

### Phase 1 — Foundation + `vscode-sidebar`, perfected

The only harness in scope. Everything else routes to `HoldAdapter` and says so in Teams.

| T# | Req | Task | Layer |
|---|---|---|---|
| T1 | R8 | Add `HarnessKind`, `ChatHandle`, `SessionIdentity`, `ActivityRecord` to `core/types.ts`; `chatSessionResource` becomes a derived accessor over `identity.chat` | core |
| T2 | R8/R10 | Extract `SessionRegistry` from `bridge.ts` — owns records, `byThread(threadId)`, single writer | core |
| T3 | R8 | `HarnessRegistry` + `HarnessAdapter` interface + `HoldAdapter` (the safe default) | core |
| T4 | R8/R1 | `ChatSessionWatcher` records `identity { harness:'vscode-sidebar', chat:<transcript id>, confidence:'exact' }` at announce | vscode |
| T5 | R8 | `notifyTool` records identity from `toolInvocationToken.sessionResource`, `confidence:'exact'` | vscode |
| T6 | R8/R2 | `SidebarAdapter` — `chatInjector` logic behind the adapter interface; reveal-then-open, no focus fallback | vscode |
| T7 | R2/R10 | `agentReplyRelay` → `DeliveryPipeline`: dedup → `byThread` → `adapterFor` → deliver | vscode |
| T8 | R5 | `ActivityClock`; transcript `onDidChange` emits `chat-turn` | core+vscode |
| T9 | R4 | Unify the idle window on **2 h** for every harness — the MCP path's hard-coded 4 h `Bridge` default becomes configurable and defaults to the same value | config |
| T10 | R6 | On expiry: post notice, **stop polling that thread entirely**; others unaffected | core |
| T11 | R7 | Editor activity on an expired session → revive, post "back online" note, resume polling | core+vscode |
| T12 | R3 | User turn in VS Code chat → post a compact update to the Teams thread, with echo-suppression for turns the bridge itself injected | vscode |
| T13 | R10 | MCP server becomes write-only; extension is the sole reader | mcp |
| T14 | R1 | End-to-end: new sidebar chat → thread → Teams reply → same chat → editor reply → Teams update | test |
| T15 | R11 | Footer states whether a reply can reach Copilot, decided by the same policy as routing so the promise cannot drift from the behaviour | core |

**Phase 1 exit criteria** — all verified against the live log, not just unit tests:
- 20 consecutive sidebar replies, 20 landing in the originating chat, 0 misroutes
- a reply sent with no MCP server running is picked up within one poll interval
- idle 2 h → notice posted, that thread stops being polled, others keep working
- revive in VS Code → note posted, polling resumes, next reply delivered

### Phase 2 — `vscode-agent-mcp`

Only starts once Phase 1 exit criteria hold. `AgentMcpAdapter`; identity captured by
`notifyTool` when in-process, else by `McpIngest` recording `harness:'vscode-agent-mcp',
confidence:'derived'` and the resolver filling the chat handle.

### Phase 3 — `cli-runtime`

Lead already identified: the debug-log folder name appears to be the chat id — to be
verified before design, per the schema-verification lesson (an SME statement is a
hypothesis until checked against the source).

---

## 8. Testing strategy

Same discipline that caught three vacuous tests this session:

1. **Every new test gets a negative control.** Remove the fix, prove *that* test fails and
   ideally only that one. A test that encodes its own assumption cannot test it.
2. **Build-failure detection in the control harness** — a broken build must never be
   mistaken for a passing test.
3. **Live-log verification before any success claim.** Unit tests did not catch Fault 1 or
   Fault 2; both were only visible in the log and against real Teams.
4. **Regression guard:** the existing 185 tests must stay green throughout. Any that break
   are examined for a stale *timing hook* before being changed — as with the mid-delivery
   race test, whose intent was right but whose hook had drifted.

New coverage required: identity capture per harness · `byThread` routing · adapter
dispatch · hold-on-unknown · sliding clock from both sources · expiry stops one thread only
· revival resumes · echo-suppression on R3.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| R3 echo loop — bridge posts an update for the turn it just injected | Teams spam, possible feedback loop | Suppress turns whose text matches an injected reply; test explicitly |
| Migration of existing session records without `identity` | Live sessions break on upgrade | `identity` optional; missing → `confidence:'unknown'` → resolver fallback → hold. Never worse than today |
| R6 removes the 24 h grace poll | A reply sent just after expiry is no longer collected | Deliberate: the expiry notice tells the user to revive in VS Code. **Flagged for your call** — grace exists because silent ignoring was the original complaint |
| `bridge.ts` split (891 LOC) | Large refactor, regression risk | Extract one responsibility at a time, full suite green between each; no behaviour change in the same commit as a move |
| VS Code internals change (`lastFocusedWidget`, resource format) | Routing breaks silently | Keep reveal-then-open, but never fall back to focus; unknown → hold, which fails loudly instead of quietly |
| 3 legacy sessions with placeholder thread ids | `UnknownError` noise | Prune during T2 registry migration |

---

## 10. Open questions

1. **Branch name?** (I will not assume one.)
2. **Worktree or current tree?** Recommend a worktree so this chat's extension keeps working.
3. **R6 grace period** — keep a short grace poll (say 10 min) after the notice, or stop dead
   as literally specified?
4. **R3 update volume** — post to Teams on *every* editor turn, or only on turns that look
   substantive (the `minPromptLength` idea already in the watcher)?
5. **R4 2 h for all harnesses**, or keep a longer window for agent sessions (currently 4 h)?
