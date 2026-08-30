# Reference — what the bridge does today

Everything below is verified against the code and, where marked **verified**, was exercised
end to end rather than read. Timing numbers come from the defaults in `src/vscode/config.ts`,
`src/mcp/server.ts` and `src/core/bridge.ts`.

For how it is built, see [architecture.md](architecture.md).
For the step-by-step flow of a single wait, see [how-waiting-works.md](how-waiting-works.md).
For the steps to get running, see [getting-started.md](getting-started.md);
for the long-form setup, [setup-guide.md](setup-guide.md).

---

## In one paragraph

Copilot posts a status update into a Microsoft Teams channel — one thread per Copilot
session — and tags you. You reply in that thread from anywhere, including your phone. The
reply comes back as Copilot's next instruction and the work continues. Nothing is exposed
to the internet: the bridge polls Teams through the Agency Teams MCP, using your own
Microsoft identity.

---

## The three ways it runs

| | **A — VS Code extension** | **B — MCP server** | **C — Local harness** |
|---|---|---|---|
| Used by | Copilot Chat sidebar | Agent sessions, Copilot CLI, Claude Desktop, Cursor | Tests, development, any client |
| Tool name | `copilotTeamsBridge_notify` | `teams_notify`, `teams_check_replies`, `teams_list_sessions` | n/a — files |
| Runs in | Extension host | Separate Node process | In-process |
| Talks to Teams | Yes, via Agency | Yes, via Agency | **No** — `outbox.jsonl` / `inbox.jsonl` |
| Session store | VS Code `globalState` | `~/.copilot-teams-bridge/sessions.json` | Either, depending on host |
| Setup needed | Team + channel in settings | None inside VS Code (see below) | Set transport to `file` |

**A and B are separate implementations sharing one engine (`src/core/bridge.ts`).** They
keep separate session stores, so a thread created on one is not visible to the other. That
is by design: the two hosts have different lifetimes and different limits.

### What do "agent" and "CLI" actually mean here?

They are not products you install or modes you pick. **They describe how the chat you are
typing into was started**, which decides which implementation answers.

| What you are using | Path | Why |
|---|---|---|
| The **Copilot Chat sidebar** in VS Code | **A** | The tool runs inside the extension itself |
| A **Copilot-mode** chat in VS Code | **A** | A chat tab, delivered into the same way; announced from VS Code's session index rather than a tool call |
| An **agent session** — a Copilot session driving tools and shell commands for you, including one running inside VS Code | **B** | It reaches the bridge through MCP, in a separate process |
| **Copilot CLI** in a terminal, Claude Desktop, Cursor | **B** | Same MCP route, different client |
| Tests and `demo.js` | **C** | No Teams at all, files on disk |

**How to tell which one you are on:** look at the tool name. Path A calls
`copilotTeamsBridge_notify`. Path B calls `teams_notify`. A Copilot-mode chat needs neither
— it is announced automatically.

### If both tools are available

Allow both in a restrictive custom agent so it remains compatible with either host, but
select only one notification tool for a session:

1. Prefer `copilotTeamsBridge_notify` when it is callable.
2. Otherwise use MCP `teams_notify`.
3. Keep using the selected tool and returned `sessionId` for every later update.

Do not call both and do not switch tools as an automatic retry. The extension and MCP paths
have different host identities, so changing paths can open a second Teams thread. A failure
on the selected path should be surfaced in chat rather than hidden behind a fallback.

The distinction matters for one reason: **on Path B nothing can interrupt an agent that is
busy.**

### Does it work with agent sessions, Copilot, and local harness mode?

**Yes, all three** — with one boundary worth knowing.

- **Copilot Chat sidebar** → Path A. Works as soon as the team and channel are set.
- **Agent sessions and the Copilot CLI runtime *hosted inside VS Code*** → Path B, and
  since the extension now registers the MCP server itself there is **nothing to configure**.
- **Local harness** → Path C. Set `copilotTeamsBridge.transport` to `file`, or run the MCP
  server with no team/channel environment variables and it falls back automatically. The
  full round trip works with no Teams and no network.
- **Hosts outside VS Code** — Claude Desktop, Cursor, a standalone `copilot` or `agency`
  CLI — still need their own MCP entry, because VS Code's registration only covers VS Code.
  Point it at the **installed extension**, not a source checkout:
  `%USERPROFILE%\.vscode\extensions\personal.copilot-teams-bridge-<version>\out\src\mcp\stdio.js`.

---

## Answering: chat or Teams, whichever suits you

**Both channels are live at once.** You are never obliged to answer in Teams just because
the update was posted there.

| You answer in | What happens |
|---|---|
| **This VS Code chat** | Continues the conversation natively — it is an ordinary chat turn |
| **Teams** | Delivered back into VS Code automatically |

This works because the agent **posts and then ends its turn** rather than blocking. A
frozen turn cannot accept chat input, so blocking would leave Teams as the only way to
reach it — precisely wrong for someone sitting at their desk.

`waitForReply` still exists for when you say you are stepping away and want the turn kept
alive. It is no longer the default.

> **Fixed 2026-08-27.** The tool description used to say *"PREFER waitForReply true on every
> call... blocks for up to 2 hours"*, so agents blocked routinely. The chat froze, and the
> only way to answer was Teams — even when the user was watching the editor. Both tool
> descriptions and the standing instructions now default to ending the turn. A wait that is
> interrupted is also reported honestly: the turn resuming usually means the user answered
> in the chat, so the agent is told to read there rather than wait on Teams again.

## How long will it wait — and can it continue afterwards?

Short answer: **a single wait is 2 hours in the sidebar and 150 seconds in an agent
session, and in both cases the conversation continues afterwards.** The difference is not
arbitrary.

| | Path A (sidebar) | Path B (agent / CLI) |
|---|---|---|
| One blocking wait | **2 h** (`waitForReplyTimeoutSeconds`, default 7200, clamp 30–7200) | **150 s** (`COPILOT_TEAMS_BRIDGE_WAIT_SECONDS`) |
| Host abandons the call after | n/a — it is in-process | **~5 min**, and it sends no progress token |
| Can it wait longer? | Yes, raise the setting | Yes, by **chaining** `teams_check_replies` with `waitSeconds` |
| Poll interval | 10 s (`pollIntervalSeconds`, clamp 3–300) | 10 s (`COPILOT_TEAMS_BRIDGE_POLL_SECONDS`) |
| Backoff on upstream failure | doubles to a 5 min ceiling, resets on success | same |
| Session idle timeout | **2 h** (`sessionIdleMinutes`, default 120) | **4 h** (engine default) |

### Why 150 s and not 2 h on Path B

Because the host gives up on a tool call at about five minutes and provides no way to ask
for an extension. A longer wait does not fail safely: the server reads your reply, marks it
seen, then discovers the caller has gone — so the message is **lost, not late**. A short
window that always returns is strictly better than a long one that can silently swallow
your reply.

**Nothing is lost when a window expires.** An empty return means *"nothing yet"*, never
*"the user declined"*. The agent chains another window, and a reply arriving between
windows is held in a buffer and handed over on the next check.

### What if I reply hours later?

**It still lands, and the work continues.** The wait window closing has nothing to do with
whether a reply is received — the bridge keeps polling every 10 s regardless of whether
anything is blocked on it. Verified:

```
Path A: reply 3 h later (idle 2h) | delivered=true
Path B: reply 5 h later (idle 4h) | delivered=true
```

That holds even past the idle timeout, because expiry is evaluated **after** delivery: a
reply arriving during a quiet spell is handed over *and* resets the window, rather than
being lost to a session that expired a moment earlier.

Two conditions apply:

- **VS Code must be running.** Nothing is polled while it is closed; replies are collected
  on the next start.
- **On Path B the agent must check.** The reply is queued, not pushed. Path A injects it
  into a chat automatically.

If a session does expire first, you are told **in the Teams thread** that replies are no
longer being read, so a message is never ignored without explanation.

### After the turn ends

- **Path A** — a later reply opens a **new chat request**, prefixed
  `[Teams reply · session "<title>" · from <name>]`, and is submitted automatically unless
  `autoSubmitReplies` is off. If the chat cannot be opened, the text is copied to the
  clipboard rather than dropped.
- **Path B** — a later reply is read by the **extension**, not by the MCP server, and then
  opens a new chat request exactly as Path A does.

  The MCP server is spawned per tool call and exits with the turn, so it is not running
  during the very gap in which a reply is most likely to arrive. Leaving it to poll its
  own threads meant a reply could sit in Teams unread indefinitely — not held, not
  queued, simply never fetched. The extension is alive whenever VS Code is, so it reads
  those threads on the server's behalf and queues into the same file the server writes.
  Everything after that point — de-duplication, chat routing, delivery — is unchanged,
  so which process did the reading stops mattering.

  What remains a real platform limit is that no MCP server can *interrupt* an agent
  mid-turn. A reply still waits for the turn to end; it no longer waits for a process
  that may never run again.

---

## What you can send back

### Text — fully supported

Plain text becomes the next instruction. A leading `@mention` is stripped, quoted originals
from "reply with quote" are removed, and formatting is flattened to plain text with line
breaks preserved.

### Slash commands — **verified**

| Reply | Effect |
|---|---|
| `/stop` `/cancel` `/close` `/done` | **Closes the session.** The agent is told to stop and the thread stops polling. |
| `/status` | Asks Copilot to report where it has got to. Any text after it is kept. |
| `/ping` | Recognised; confirms the bridge is alive. Does not close the session. |
| `/anythingelse` | **Not** a command — delivered verbatim, slash included. |

> **`/done` closes the session.** It reads like "I have finished typing", but it is a
> synonym for `/stop`. Use plain text if you mean "carry on".

#### When a command actually lands

A command is picked up by the next poll (~10 s), but it is **delivered when the agent next
checks**, and on Path B nothing can interrupt work already in flight.

| Situation | What happens to `/status` |
|---|---|
| The agent is waiting for you | Arrives within ~10 s, acted on immediately |
| The agent is mid-task | **Queued** — acted on the next time it checks |
| The turn has ended (Path A) | Opens a new chat request |
| The turn has ended (Path B) | Opens a new chat request, read by the extension |

Sending `/status` to a busy agent and seeing nothing happen is therefore expected. It is
not lost; it is waiting.

> **Fixed 2026-08-27.** Until this date a *bare* command reached the agent as a **blank
> message** on the MCP path. The command was parsed and the session was closed for
> `/stop`, `/done`, `/close` and `/cancel`, but the agent was handed an empty string and
> had nothing to act on. `/stop` was the worst case: the session ended while the agent
> carried on, unaware. The engine and the MCP server had also drifted apart — the engine
> closed on four commands, the server recognised two.

### Images and attachments — **not supported** (verified)

| You send | What Copilot receives |
|---|---|
| Text | The text |
| **Text + an image** | **The text only** — the image is dropped, the instruction still arrives |
| **An image on its own** | **Nothing at all** |
| A file attachment on its own | Nothing at all |
| An emoji or sticker on its own | Nothing at all |

`cleanReplyText` strips `<img>` tags (`src/core/messageFormat.ts`), so an image-only reply
cleans to an empty string. The engine marks it as seen and skips it
(`src/core/bridge.ts`), which means it is **silently and permanently discarded** — you get
no warning in Teams, and the agent never learns you replied. Polling again cannot recover
it, because the watermark has already moved past it.

Verified end to end:

```
image-only reply   | delivered=false | recoverable=false | markedSeen=true
text + image       | text="use this layout"
normal text        | delivered=true
```

**Deliberately not fixed yet** — text first, images later. Until then, if you want to send a
screenshot, **add a sentence with it** and the sentence will get through.

---

## Running several sessions at once

Parallel sessions are where misdelivery does real damage: a reply meant for one task, acted
on by a chat doing another, can derail both. Routing is handled differently on each path.

### Agent and CLI sessions — routed exactly

One MCP server is shared by every agent session in the window, so the agent says which task
it is working on and receives only that task’s replies:

```
teams_check_replies { sessionKey: "reserve-api" }  ->  only reserve-api replies
teams_check_replies { sessionKey: "cohort-icm"  }  ->  only cohort-icm replies
```

Anything belonging to another session is **left in the queue for its owner**, not consumed.

> **Fixed 2026-08-27.** An unscoped check returned whatever had arrived first, across every
> session, *and* marked it delivered. One agent would act on another’s instruction while the
> agent it belonged to waited for a reply that had already been taken.

### The VS Code sidebar — steered to its own chat

A sidebar reply has to be *pushed* into a chat, and `workbench.action.chat.open` writes to
whichever chat has focus. **It cannot be told which chat to use.** So the bridge brings the
right chat to the front first, using the one command that does take a session:
`workbench.action.chat.openSessionInEditorGroup` resolves `{ resource }` and opens *that*
session, which focuses it — and the write then lands there.

| Reply's chat vs. the chat in front | What happens |
|---|---|
| Same chat | Written and sent. **Nothing is moved** |
| A different chat | That chat is opened as an editor tab, then the reply is sent to it |
| Cannot be told which is in front | Same — the chat on record is brought forward |
| No chat recorded | Held, unless you opt into `focusedChat` |

**The cost:** a chat living in the side bar is *relocated* to an editor tab, because
`prepareSessionForMove` calls `clear()` on the side bar widget to detach the session. The
conversation is **not** lost — this is exactly what the built-in "Open as Editor" action
does — but the chat does leave the side bar. Set
`copilotTeamsBridge.replyTargeting` to `sidebarOnly` to never move anything; replies then
wait until you open their chat yourself.

> [!IMPORTANT]
> **Drafting is not a safety mechanism.** `isPartialQuery` chooses whether Copilot *runs*,
> not which conversation *receives* the text. A draft aimed at chat B still lands in chat A.
> An earlier version drafted whenever it could not confirm the target and called that safe;
> it was not, and users read other tasks' instructions in the chat they were working in.
> Delivery therefore either steers to the right chat first, or writes nothing.

### Proving it arrived

The reveal is not self-verifying. `TabInputChat` is an **empty marker class** carrying no
session id, so an active chat editor proves *a* chat is in front and never *which* one.

So delivery is confirmed rather than assumed: VS Code records every request in the
transcript of the chat that received it, and the bridge waits for its own marker line to
appear in the **target session's** transcript. Only then is the reply reported as delivered.

If the marker never appears, the reveal steered somewhere unexpected. The reply is **not**
reported as delivered, and steering is not retried for it — a second attempt would write
into that same wrong conversation again. You are asked instead.

Tune the wait with `copilotTeamsBridge.deliveryConfirmSeconds` (default 30) on a slow
machine. It is the **quiet window**: how long the target chat's transcript must be silent
with no sign of the request before delivery is treated as unproven — not a hard cap on how
long confirmation may take. Any change to the transcript resets it, so a cold chat whose
agent is still starting up keeps being waited for.

The identity comes from the tool invocation token. It is typed `never` in the public API but
the extension host really passes `{ sessionResource, workingDirectory }`, and VS Code's own
built-in tools use the same field. It is read defensively, so an older host simply falls
back rather than breaking.

A session created through the MCP server has no token to read, because that server runs
outside VS Code. Its chat is recovered instead from the transcripts: the chat that called
the tool recorded the call, so the session key identifies its own conversation. Only
recorded calls count — a reply delivered to the wrong chat names its own session in the
request, and treating that as a match would keep choosing the wrong chat. When no
transcript claims the session the reply is left unaddressed rather than guessed.

### Which chat is in front

Used only for the fast path — deciding whether steering is needed at all. There is no API
for it, so the bridge reads the transcripts: VS Code writes one per chat, and the one
written to most recently is the chat being worked in.

Relevant command behaviour, confirmed against the 1.135 bundle:

- `workbench.action.chat.open` always resolves `lastFocusedWidget`. No session argument.
- `workbench.action.chat.openSessionInEditorGroup` takes `{ resource }` and opens that
  session in an editor group. Passes a defined target, so it goes through
  `prepareSessionForMove` — the relocation described above.
- `workbench.action.chat.openInSidebar` only moves the *active editor*; it ignores any
  session argument, so it cannot be used to target a chat.

### When a reply cannot be delivered

Nothing is lost. The reply is:

1. **Kept** in the session's pending list — it was already marked seen, so dropping it would
   destroy the instruction.
2. **Reported** in the Teams thread, saying it is waiting rather than failed.
3. **Retried on every poll**, so opening the chat it belongs to delivers it within one
   interval with no further action.
4. **Offered to you** in a VS Code notification with **Deliver to current chat**, for when you
   want it here and now. That path writes to the focused chat — the same operation the
   automatic path refuses — because you chose the destination rather than the bridge guessing.

`copilotTeamsBridge.replyDelivery` controls auto-submit: `guarded` (default), `always`,
`never`. `copilotTeamsBridge.unroutableReplies` controls sessions with no chat at all:
`hold` (default) or `focusedChat`.

The request text also names its task and tells an unrelated chat to **say so and stop**
rather than invent context — but only when the target was not confirmed, since the warning
would otherwise be misleading.

## How much reaches Teams

Two sources feed a thread, and `copilotTeamsBridge.turnUpdates` chooses between them.

| Setting | What Teams gets |
|---|---|
| `everyTurn` *(default)* | A summary as **each turn finishes**, plus Copilot's own milestone updates |
| `milestonesOnly` | Only what Copilot chooses to report — start, blocked, finished |

`everyTurn` exists because the milestone updates are *guidance*: the model decides whether
to send one, and a turn that ends without one leaves the thread silent while work is
plainly happening. VS Code raises no event when a chat request finishes, so the transcript
is read instead — it is the only signal available.

### What a turn summary contains, and what it never does

- **Never the model's internal reasoning.** `thinking` parts carry real text but are not the
  answer and were never published to you, so relaying them would leak working-out. Excluded
  deliberately, and covered by a test that fails if the filter is removed.
- **Never tool machinery.** A summary made of "Ran tool X" lines says nothing about what was
  decided.
- **No code blocks or tables**, which are unreadable on a phone and would eat the budget.
- Cut at a sentence end, at `turnSummaryCharacters` (default 600).

### What it will not do

| Guarantee | Why |
|---|---|
| **Never opens a thread** | Summaries only go into a thread that already exists. You choose which chats Teams hears about; a turn is not that choice |
| **Never posts twice** | Each request id is recorded. The transcript is re-read on every write and after every reload, so without this the whole conversation would replay |
| **Never duplicates Copilot's own update** | If Copilot reported *during* that turn, its wording wins and the automatic summary stands down |
| **Never posts a half-answer** | A turn is only summarised once its `result` is written, after a quiet period |
| **Never posts to a closed session** | `/stop` in Teams means stop |

A turn also slides the two-hour idle window, so a conversation carried on entirely in the
editor is not declared idle while you are mid-sentence in it.

## Where updates appear

**Both places.** Teams is an *additional* audience, never a replacement for the chat you
are already looking at.
| You are | You should see |
|---|---|
| In VS Code | The full update in the chat **and** a Teams post |
| On your phone | The Teams post |

The Teams summary is often shorter, because it is read on a phone. The chat answer is the
complete one and should stand on its own.

> **Fixed 2026-08-27.** The tool result used to say only "Posted to the Teams thread",
> which reads as *the update has been delivered*. Agents therefore replied in chat with a
> bare "posted to Teams" — so a user sitting in VS Code watched their own work be sent
> somewhere else and had to open Teams to read about the editor in front of them. Both
> paths now state explicitly that posting does not discharge the duty to answer in chat.

## What Copilot sends you

Each update carries a title, a markdown summary, a status, an optional question, and an
optional list of changed files. Status drives the emoji and colour of the thread:

| Status | Meaning |
|---|---|
| `progress` | Work has started or is continuing |
| `needs-input` | Blocked; a question is included and a reply is expected |
| `completed` | This piece of work is done — the thread stays open |
| `failed` | The attempt did not succeed |

The first update **creates** the thread and tags you; later updates for the same session key
**reply within it**, so one Copilot session is one Teams conversation.

---

## Session lifecycle

1. **Created** on the first notification for a session key.
2. **Kept alive** by every notification and every reply.
3. **Expires** after the idle timeout (2 h on Path A, 4 h on Path B), and you are told so
   in the thread.
4. **Resumed by replying.** For 24 hours after expiry the thread is still read, just less
   often. A reply revives the session, confirms it in Teams, and is delivered normally.
5. **Abandoned** once that grace period passes. A reply then is not picked up.
6. **Closed immediately** by `/stop`, `/cancel`, `/close` or `/done`. A closed thread is
   never read again, because closing is something you asked for.

> **Fixed 2026-08-27.** An expired session was dropped from polling outright, so a reply
> sent after the window closed was never read — no error, no warning, and no way to tell it
> apart from the bridge being broken. Expiry exists to stop paying for threads nobody uses,
> but a reply is proof somebody still is, and that was the one signal being ignored.

### You are told when your reply is picked up

When an instruction reaches an agent, a short **"Got it — working on this."** is posted in
the thread. Until the agent produces its own first update there is otherwise no sign the
reply arrived, which reads exactly like it having been lost.

It is posted at *delivery*, not when the reply is merely read: promising work while the
message still sits in a queue would be worse than silence. A `/stop` gets no
acknowledgement, since the agent confirms having stopped. Turn it off with
`copilotTeamsBridge.acknowledgeReplies`.

`sessionId` is the exact handle returned by the first call; `sessionKey` is the stable name
you choose. Passing the id back is what guarantees follow-ups land in the same thread.

---

## Configuration

### VS Code settings (`copilotTeamsBridge.*`)

| Setting | Default | Purpose |
|---|---|---|
| `transport` | `agency` | `agency` for Teams, `file` for the local harness |
| `teamId` / `channelId` | empty | Which Teams channel to use — **required** for `agency` |
| `agency.command` | `agency` | Only if the CLI is not on PATH |
| `pollIntervalSeconds` | `10` | Reply poll interval (3–300) |
| `waitForReplyTimeoutSeconds` | `7200` | Longest single blocking wait (30–7200) |
| `sessionIdleMinutes` | `120` | Idle time before a session expires |
| `autoSubmitReplies` | `true` | Submit an injected reply automatically |
| `autoStart` | `true` | Begin polling when VS Code starts |
| `acknowledgeReplies` | `true` | Post "working on this" when your reply is picked up |
| `expiredGraceHours` | `0` | How long an expired thread is still watched. Zero (the default) means it is not read at all and replies posted after expiry are ignored — the session is reactivated from VS Code. Setting a value above 0 opts back into the old resume-by-reply behaviour |
| `unroutableReplies` | `hold` | What to do when the owning chat cannot be identified — `hold` leaves it in Teams, `focusedChat` sends it to whichever chat is focused |
| `announceSessions` | `true` | Open a thread when a Copilot session starts |
| `announceMinPromptLength` | `30` | Shortest prompt worth announcing |
| `file.directory` | extension storage | Where the local harness keeps its files |

### MCP environment variables

| Variable | Default |
|---|---|
| `COPILOT_TEAMS_BRIDGE_TEAM` / `_CHANNEL` | unset — falls back to the file transport |
| `COPILOT_TEAMS_BRIDGE_AGENCY` | `agency` |
| `COPILOT_TEAMS_BRIDGE_WAIT_SECONDS` | 150 |
| `COPILOT_TEAMS_BRIDGE_POLL_SECONDS` | 10 |
| `COPILOT_TEAMS_BRIDGE_HOME` | `~/.copilot-teams-bridge` |

Inside VS Code the team, channel, agency command and poll interval are passed automatically
from your settings; changing them restarts the server.

---

## Commands

| Command | Use |
|---|---|
| **Set Up** | Pick the team and channel interactively |
| **Start a Session** | Open a Teams thread by hand |
| **Send Test Notification** | Prove the connection works |
| **Show Sessions and Threads** | See every session and its status |
| **Check Teams for Replies Now** | Poll immediately |
| **Extend a Session** / **Rename a Session** | Postpone expiry; retitle a thread |
| **Start / Stop Listening for Replies** | Control polling |

Local harness, no Teams required:

```powershell
node out/src/cli/demo.js doctor --team <id> --channel <id>
node out/src/cli/demo.js notify --title "T" --summary "s"
node out/src/cli/demo.js listen
node out/src/cli/demo.js sessions
```

---

## Failure modes that are handled

- **The Agency session lapses while idle.** Every later call returns `-32001 Session not
  found` forever. The transport detects this, restarts the subprocess and retries once.
- **Teams cannot be read.** Reported as an error rather than "no replies", so a broken read
  is never mistaken for silence.
- **A reply arrives with nothing waiting.** Buffered and delivered on the next check
  instead of being dropped.
- **The turn is cancelled mid-wait.** The reply is handed back to the queue.
- **The upstream starts failing.** Polling backs off, doubling to a five-minute ceiling.
- **The chat window cannot be opened.** The instruction is copied to the clipboard.

---

## Known gaps

- **Images, attachments, stickers and emoji-only replies are dropped silently** — see above.
  The silent part is the worst of it: nothing tells you the reply went nowhere.
- **Nothing is polled while VS Code is closed.** Replies are picked up on the next start,
  provided the session has not expired.
- **Announcing no longer depends on the model.** The bridge watches the transcripts VS Code
  writes for every chat and opens a Teams thread itself, so a session is announced whether
  or not the model calls the tool. Turn it off with `copilotTeamsBridge.announceSessions`.
  Prompts shorter than `announceMinPromptLength` (30 characters) are skipped as chit-chat.
  This reads VS Code internal storage, so it is written defensively and degrades to the old
  model-driven behaviour rather than failing if the format changes.
- **Path A and Path B do not share sessions.** The same work continued in the other host
  starts a new thread.
- **A sidebar reply can still land in the wrong chat when the host does not identify the
  calling chat.** The identity is read from an undocumented field, so a future VS Code could
  stop providing it; the reply is then held rather than delivered, as below.
- **A reply for a `copilot` CLI session cannot be routed into a chat.** A terminal CLI
  session has no VS Code chat, and resuming it is withheld — see
  [known-issues.md](known-issues.md) issue 5. Such a reply is queued for the agent and
  collected by `teams_check_replies`; if the agent has already exited it is not delivered,
  and the thread says so. **A Copilot-mode chat is different** and *is* routed correctly
  since 1.1.0: it is a chat tab, so the reply is revealed and submitted into it like any
  other. Sidebar and agent chats have always been routed correctly. Observed 2026-08-27,
  updated 2026-08-29.
- **Only Windows has been run.** Nothing in the extension is Windows-specific — paths come
  from `os.homedir()` and the VS Code storage API, and the process spawn already branches
  on `process.platform` for the `.cmd` shim — but no part of it has been executed on
  macOS or Linux, and whether the Agency CLI is available there is unverified. Treat
  non-Windows as untested rather than supported.
- **Starting a session *from* Teams is not implemented** — see [phase-2-plan.md](phase-2-plan.md).

### Why an unroutable reply is not delivered at all

> **Changed 2026-08-27.** A reply whose chat could not be identified used to be injected
> into "the focused chat" with a warning telling that chat it might not own the task. That
> sounds like a neutral fallback. It is not, and the reason is worth stating.

`workbench.action.chat.open` takes no session target. Its command is registered without a
mode, so it always resolves through `revealWidget()`, which starts from the chat widget
service's `lastFocusedWidget` — *"the chat most recently focused"*, with no relationship to
the session the reply belongs to.

The bridge itself moves that pointer. Delivering a reply correctly requires revealing the
owning chat first, and `openSessionInEditorGroup` passes no `preserveFocus`, so revealing a
chat **focuses** it. So:

1. A reply is routed correctly to chat X. X is now `lastFocusedWidget`.
2. The next reply that cannot be identified goes to "the focused chat" — which is X.
3. Reading that misrouted message in X focuses X again, so the one after that goes there too.

**The better targeting works, the more reliably misroutes pile into whichever chat was last
correctly targeted.** That is not a fallback, it is a bias. An instruction landing in an
unrelated task costs both tasks, so the reply is now left in Teams and reported there
instead — it is still in the thread, and nothing has been put where it does not belong.

Set `copilotTeamsBridge.unroutableReplies` to `focusedChat` for the old behaviour, which is
reasonable if you only ever run one chat at a time.

Every injection now records **which** chat it went to, so this is readable from the log
rather than inferred from where messages turn up.
