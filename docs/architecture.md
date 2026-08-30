# Architecture

How the bridge is put together, and why. For what it does from a user's point of view see
[reference.md](reference.md); for setup steps see [getting-started.md](getting-started.md).

---

## The shape of it

```
        VS CODE                                          MICROSOFT TEAMS
 ┌──────────────────────────┐
 │  Copilot Chat (sidebar)  │  calls copilotTeamsBridge_notify
 │                          │────────────┐
 └──────────────────────────┘            │
                                         ▼
 ┌──────────────────────────┐    ┌───────────────┐
 │  Agent / CLI session     │    │               │      ┌──────────────┐
 │                          │───▶│  Bridge core  │─────▶│  agency CLI  │──▶ ┌─────────┐
 └──────────────────────────┘    │               │◀─────│  (Teams MCP) │◀── │ channel │
      calls teams_notify         │  sessions     │      └──────────────┘    │ thread  │
      via the MCP server         │  polling      │        subprocess        └─────────┘
                                 │  routing      │        stdio JSON-RPC
                                 └───────────────┘
```

Everything above the core is a **host adapter**. Everything below it is a **transport**. The
core knows about neither Teams nor VS Code.

---

## What "host" means here

A **host** is the program that runs your Copilot session and calls the tool. The bridge
cannot choose it — you do, by where you type.

| You type in | Host | Why it needs its own adapter |
|---|---|---|
| The **Copilot Chat sidebar** | **A** — the extension | The tool runs in-process, inside VS Code |
| An **agent session** (Copilot driving tools and shell commands for you) | **B** — the MCP server | It cannot reach an in-process VS Code tool, so it speaks MCP over stdio |
| **Copilot CLI**, Claude Desktop, Cursor | **B** — the MCP server | Same MCP route, different client |
| Tests and `demo.js` | **C** — the CLI harness | No Teams, no VS Code |

Same engine underneath, three different doorways into it. **How to tell which you are on:**
the tool name. Host A calls `copilotTeamsBridge_notify`; Host B calls `teams_notify`.

## Layers

| Layer | Files | Responsibility |
|---|---|---|
| **Core** | `core/bridge.ts` | Sessions, polling, routing, waiters, buffering, backoff |
| | `core/messageFormat.ts` | Render outgoing HTML; parse incoming replies and commands |
| | `core/types.ts` | The contracts every layer agrees on |
| **Transports** | `transports/agencyTeamsTransport.ts` | Real Teams, via the Agency CLI subprocess |
| | `transports/fileTransport.ts` | Local loopback: two `.jsonl` files, no network |
| **Host A** | `vscode/extension.ts`, `notifyTool.ts`, `chatInjector.ts` | The VS Code extension |
| **Host B** | `mcp/server.ts`, `mcp/stdio.ts`, `mcp/jsonRpc.ts` | An MCP server for agent sessions |
| **Host C** | `cli/demo.ts` | Command-line harness for testing |

**One core, three hosts, two transports.** The dependency arrows only ever point inwards:
`core/` imports nothing from `vscode/` or `mcp/`, which is what lets the whole engine be
tested headlessly.

### Why two hosts rather than one

They are not redundant — they solve different problems:

| | Host A (extension) | Host B (MCP server) |
|---|---|---|
| Lives in | The extension host process | Its own Node process |
| Can it *push* to the user? | Yes — opens a chat request | No — must be asked |
| Session store | VS Code `globalState` | `~/.copilot-teams-bridge/sessions.json` |
| Reply after the turn ends | Injected into a chat | Queued until the agent checks |

An MCP server cannot interrupt an agent that is not calling it — nothing in the protocol
allows it. So Host A exists to *push*, and Host B exists because agent sessions cannot reach
the extension's in-process tool. Each covers the other's blind spot.

They keep **separate session stores** deliberately: the two hosts have different lifetimes,
and a shared store would need cross-process locking to avoid two pollers racing the
"already seen" watermark.

---

## The core

### Sessions

A session is the mapping **one task ↔ one Teams thread**:

```ts
{ id, key, title, thread?, chatSessionResource?,
  lastReplyAt?, seenReplyIds[], status, closed?, expiredAt?,
  pending?, deliveredReplyIds? }
```

- `key` is chosen by the caller (the task name) and matched loosely.
- `id` is generated, exact, and wins over the key when supplied.
- `thread` is assigned on the first post; it *is* the addressing, so nobody types an id.
- `chatSessionResource` records which chat opened the task, used to route replies back.
- `pending` holds replies collected while nobody was waiting, so a stopped process loses none.
- `deliveredReplyIds` records what has already been handed to a chat.

The last pair exists because two processes write the agent session file: the MCP server
adds to the queue, the extension empties it as it delivers. Neither can tell a reply the
other removed from one it has not seen yet, so a removal is recorded rather than implied.
Without that record the server restored delivered replies from its own memory on its next
write, and the same instruction was injected into chat every few seconds until the server
was stopped. Both writers reconcile against the record, so a stale write is harmless.

### Who reads a thread

Whoever creates a session used to be the only process that read its Teams thread. For the
extension that is fine — it runs as long as VS Code does. For the MCP server it is not: it
is spawned per tool call and exits with the turn, so it is not running during the gap in
which a reply is most likely to arrive. A reply could therefore sit in Teams unread with
nothing wrong anywhere in the delivery path, because nothing had fetched it in the first
place. That single split accounts for symptoms that looked unrelated: replies not picked
up, picked up much later, or picked up all at once when a server happened to start.

The extension now reads on the server's behalf and appends to the same queue in the same
file. It deliberately does not deliver directly — by joining the existing queue, the
de-duplication, chat resolution and delivered-id records all apply unchanged, and which
process did the reading stops being something the rest of the system has to know.

A reply can now be seen by both processes, so the drain drops one already recorded as
delivered, and a reply that is read but never queued — an empty message, a reaction — is
recorded as seen so it is not fetched again on every pass. A thread that cannot be read at
all is reported once rather than every few seconds.

### The polling loop

One timer, not one per session — a single tick walks every live session:

```
tick ──▶ for each live session ──▶ transport.fetchReplies(thread, since lastReplyAt)
                                        │
                                   new replies?
                                        │
                        mark seen, advance watermark, parse command
                                        │
                                   dispatch ──▶ waiter?  ──▶ resolve it
                                                └▶ handler? ──▶ deliver
                                                └▶ neither? ──▶ buffer as undelivered
                                        │
                              expire idle sessions (AFTER delivering)
```

Three details that matter:

- **Expiry runs after delivery**, so a reply arriving during a quiet spell is handed over
  *and* resets the window instead of being lost to a session that expired a moment earlier.
- **Failures cause backoff** — the interval doubles to a five-minute ceiling and resets on
  success, so a failing upstream is not hammered by every session at once.
- **Nothing is dropped for want of a listener.** A reply with no waiter and no handler goes
  into the undelivered buffer and is handed to whoever asks next.

### Routing

The reason a reply reaches the right task, on each path:

| Step | How |
|---|---|
| Teams thread → session | Exact: each session owns one thread id |
| Session → agent (Host B) | The agent names its session; others' replies stay queued |
| Session → chat (Host A) | Reveal `chatSessionResource`, then deliver |
| Session → chat (Host B relayed) | Recover the chat from the transcript, then as above |

Host A reads the identity from the tool invocation token — typed `never` in the public API,
but really `{ sessionResource, workingDirectory }`, the same field VS Code's own built-in
tools use. It is read defensively; if a future build stops providing it, the reply is held
rather than guessed at.

Host B has no such token: the MCP server is a separate process with no VS Code API, so its
sessions record no chat at all and every relayed reply once went to whichever chat happened
to be focused. The transcript supplies what the server cannot. VS Code records each tool
call and its arguments in the transcript of the chat that made it, so the session key held
by the server appears in the transcript of the chat that sent it, and finding it names that
chat exactly.

Only recorded tool calls are read, never the transcript text. A misdelivered reply quotes
its own session key in the request it delivers, so the wrong chat's transcript ends up
containing the key too; matching on that would pin the session to the chat it was last
mistakenly sent to and repeat the error forever.

When no transcript claims the session — a Copilot CLI chat keeps none — the reply is **not
delivered**. There is no neutral chat to fall back to: `workbench.action.chat.open` resolves
to `lastFocusedWidget`, and revealing a chat to deliver correctly is itself what sets that
pointer, so unroutable replies would accumulate in whichever chat was last targeted. See
[reference.md](reference.md#why-an-unroutable-reply-is-not-delivered-at-all).

### Transports

Anything implementing four methods can carry the traffic:

```ts
createThread(notification)              → PostResult
postToThread(thread, notification)      → PostResult
fetchReplies(thread, sinceIso)          → InboundReply[]
renameThread?(thread, notification)     // optional
```

**`AgencyTeamsTransport`** spawns `agency mcp teams --transport stdio` and speaks JSON-RPC to
it, calling `SendMessageToChannel`, `ReplyToChannelMessage`, `ListChannelMessageReplies`,
`ListChannelMembers`, `UpdateChatMessage`, `ListTeams`, `ListChannels`.

This is the only route that works without admin consent in a tenant that pre-authorises
first-party apps: the Agency MCP platform is already approved, so reads succeed where a
direct Graph call with a user token returns 403. **No app registration, no tunnel, nothing
listening on a port.**

It also self-heals. The Agency proxy's session lapses after a few minutes idle and then
fails *every* later call with `-32001 Session not found`, forever, with no other signal. The
transport recognises that specific code, restarts the subprocess and retries once.

**`FileTransport`** writes `outbox.jsonl` and reads `inbox.jsonl`. The whole round trip is
testable with no Teams and no network, and it doubles as the way to wire up any other chat
system.

---

## Request flow

### Posting an update

```
Copilot calls the tool
   └─▶ ensureSession(key|id)          reuse the task's thread, or open one
   └─▶ transport.createThread/postToThread
   └─▶ record chatSessionResource     (Host A, when the host reveals it)
   └─▶ return: "posted, AND still answer in this chat"
```

The tool result deliberately does **not** end the turn's obligations: it tells the agent that
Teams is an additional audience, not a replacement for the chat.

### Receiving a reply

```
poll tick ──▶ new reply in thread
   └─▶ cleanReplyText()        strip mentions, quotes, HTML
   └─▶ parseReply()            split off /stop /status /ping …
   └─▶ dispatch
         ├─ Host A: reveal the owning chat, then inject the request
         └─ Host B: hand to the waiting call, or queue for the owner
```

### Delivery guard (Host A only)

When the chat cannot be identified, the bridge refuses to guess:

| Sessions live | Reply |
|---|---|
| One | Sent — unambiguous |
| Two or more | Left **unsent** in the chat input, with a notification |

A held reply costs a keystroke; a reply auto-sent into the wrong chat can derail two tasks.
`replyDelivery` overrides this in either direction.

---

## Design decisions worth knowing

**Polling, not webhooks.** A webhook needs a public endpoint. Polling every 10 s from the
user's own machine, under their own identity, needs nothing — no registration, no consent,
no inbound network. The cost is up to 10 s of latency, which is invisible next to how long a
human takes to reply.

**Wait windows are short on Host B.** VS Code abandons a tool call at ~5 minutes and sends no
progress token, so a longer wait cannot be kept alive. Worse, it fails *unsafely*: the server
reads the reply, marks it seen, then finds the caller gone — the message is **lost, not
late**. 150 s that always returns beats 900 s that can silently swallow a reply.

**Blocking is not the default.** A blocked turn cannot accept chat input, which would remove
the chat as a reply route and force the user to their phone to answer a question about the
editor in front of them.

**Errors are never silence.** A failed read is reported as an error, not as "no replies" —
otherwise a broken bridge looks exactly like a quiet user.

---

## Configuration

### 1. Teams channel — required

`Ctrl+Shift+P` → **Teams Bridge: Set Up** signs in through Agency, lists your teams and
channels, and writes the settings. It must be a **channel in a team**, not a 1:1 chat.

Manually, from **⋯ → Get link to channel** (decode `%3a`→`:`, `%40`→`@`):

```json
{
  "copilotTeamsBridge.teamId": "00000000-1111-…",
  "copilotTeamsBridge.channelId": "19:…@thread.tacv2"
}
```

### 2. MCP — nothing to do

The extension registers its own MCP server with VS Code
(`contributes.mcpServerDefinitionProviders`), so there is no `mcp.json` to write.

**Where to see it:** `Ctrl+Shift+P` → **MCP: List Servers**. It appears as
**Copilot Teams Bridge**, and from there you can start, stop, restart it, view its output,
or list the three tools it provides. Its log is also written to
`%APPDATA%\Code\logs\<date>\window1\mcpServer.personal.copilot-teams-bridge*.log`.

**How it learns your channel.** The server is a *separate process*, so it cannot read your
VS Code settings. The extension passes them in the environment when it launches it:

```
command: <the editor’s own Node runtime>
args:    <installed extension>/out/src/mcp/stdio.js
env:     ELECTRON_RUN_AS_NODE=1
         COPILOT_TEAMS_BRIDGE_TEAM=<your teamId setting>
         COPILOT_TEAMS_BRIDGE_CHANNEL=<your channelId setting>
         COPILOT_TEAMS_BRIDGE_AGENCY=<your agency.command setting>
         COPILOT_TEAMS_BRIDGE_POLL_SECONDS=<your pollIntervalSeconds setting>
```

So configuring the channel **once**, in settings, configures both hosts. Because the values
are read at launch and cannot change afterwards, the definition’s version string includes
them — changing the team or channel makes VS Code restart the server rather than leave it
pointed at the old channel.

If team and channel are unset, the server falls back to the **file transport** rather than
failing, which is what makes the local harness work with no configuration at all.

> **Upgrading from a hand-written entry?** Delete the bridge entry from
> `%APPDATA%\Code\User\mcp.json`. Two copies share one session store and can swallow each
> other’s replies. The extension warns you once if it finds one.

Hosts **outside** VS Code (Claude Desktop, Cursor, a standalone CLI) do need their own
entry, with the same environment variables set by hand, pointed at the **installed
extension** rather than a source checkout:

```
%USERPROFILE%\.vscode\extensions\personal.copilot-teams-bridge-<version>\out\src\mcp\stdio.js
```

### 3. Instructions — installed for you

A model only calls a tool it has been told about, so the bridge ships a small instructions
file and **installs it itself**. There is nothing to copy.

- **Teams Bridge: Set Up** writes it as part of the wizard.
- **Every activation** re-checks it and rewrites it if it differs from the version shipped
  with the build, silently. The guidance changes as the bridge does, and without this a
  user who set up once would keep the original behaviour indefinitely, with nothing to
  explain why their agent behaves unlike the documentation.

It is written to **both** folders, because the two hosts read different ones and a file in
one is invisible to the other:

| Host | Folder |
|---|---|
| A — Copilot Chat | `%APPDATA%\Code\User\prompts\` |
| B — agent / CLI sessions | `%USERPROFILE%\.copilot\instructions\` |

The source is `assets/teams-bridge.instructions.md` in the extension, shipped in the VSIX.
To read what Copilot is being told, open either installed copy.

Two cases still need you:

- **A reload** for a newly written file to take effect.
- **A custom agent with a `tools:` allowlist** should include both
  `copilotTeamsBridge_notify` and `copilot-teams-bridge/*`, because different hosts expose
  different surfaces. The installed instruction still requires exactly one path per
  session: prefer the extension tool, otherwise use MCP, and never switch automatically.

### All settings

| Setting | Default | Purpose |
|---|---|---|
| `teamId` / `channelId` | — | **Required.** Which channel to use |
| `transport` | `agency` | `agency` for Teams, `file` for the local harness |
| `agency.command` | `agency` | Only if the CLI is not on PATH |
| `pollIntervalSeconds` | `10` | Reply poll interval (3–300) |
| `waitForReplyTimeoutSeconds` | `7200` | Longest single blocking wait (30–7200) |
| `sessionIdleMinutes` | `120` | Idle time before a session expires |
| `replyDelivery` | `guarded` | `guarded` / `always` / `never` — see the guard above |
| `autoSubmitReplies` | `true` | Send an injected reply automatically |
| `autoStart` | `true` | Begin polling when VS Code starts |
| `acknowledgeReplies` | `true` | Post "working on this" when your reply is picked up |
| `expiredGraceHours` | `0` | How long an expired thread is still watched (0 disables reading it entirely) |
| `announceSessions` | `true` | Open a thread when a Copilot session starts |
| `announceMinPromptLength` | `30` | Shortest prompt worth announcing |
| `file.directory` | extension storage | Where the local harness keeps its files |

### MCP environment variables

Set automatically inside VS Code; needed only for external hosts.

| Variable | Default |
|---|---|
| `COPILOT_TEAMS_BRIDGE_TEAM` / `_CHANNEL` | unset — falls back to the file transport |
| `COPILOT_TEAMS_BRIDGE_AGENCY` | `agency` |
| `COPILOT_TEAMS_BRIDGE_WAIT_SECONDS` | `150` |
| `COPILOT_TEAMS_BRIDGE_POLL_SECONDS` | `10` |
| `COPILOT_TEAMS_BRIDGE_HOME` | `~/.copilot-teams-bridge` |

---

## Security

- **No inbound network.** Nothing listens; the bridge only makes outbound calls.
- **No app registration, no admin consent, no tunnel.**
- **Your identity.** Messages are posted as you, through the Agency CLI's existing sign-in.
- **No secrets stored.** Settings hold only a team id and a channel id.
- **Per user.** Nothing is shared between people who install it.

---

## Testing

142 tests, no VS Code instance required:

| Suite | Covers |
|---|---|
| `bridge.test.ts` | Sessions, polling, waiters, buffering, backoff, expiry |
| `mcpServer.test.ts` | JSON-RPC framing, tools, waits, cancellation, session scoping |
| `extensionActivation.test.ts` | Activation, tool + command registration, reply delivery |
| `agencyTeamsTransport.test.ts` | Subprocess protocol, session-lapse recovery |
| `messageFormat.test.ts` | HTML rendering, reply cleaning, command parsing |
| `legacyMcpEntry.test.ts` | Detecting a stale hand-written `mcp.json` |

The VS Code API is hand-mocked, and `FileTransport` stands in for Teams, so the full round
trip runs headlessly in CI.
