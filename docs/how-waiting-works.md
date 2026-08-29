# How waiting works, per host

There are **two completely separate implementations** of the bridge, and which one you
get depends on how you started Copilot. They share the core engine but differ in every
timing that matters. Most confusion about "why didn't my reply arrive" comes from
reading the numbers for the path you were not on.

## Which path am I on?

| You are using | Path | Tool the model calls |
|---|---|---|
| Copilot Chat in the VS Code sidebar | **A — extension** | `copilotTeamsBridge_notify` |
| An agent session, or `copilot` CLI | **B — MCP server** | `teams_notify` |
| Claude Desktop, Cursor, any MCP client | **B — MCP server** | `teams_notify` |

Path A runs **inside the VS Code extension host**. Path B runs in a **separate Node
process** (`out/src/mcp/stdio.js`) that VS Code launches from the extension's own installed
folder, using the editor's Node runtime.

They keep separate session stores — `globalState` for A, `~/.copilot-teams-bridge/sessions.json`
for B — so a thread created on one path is not visible to the other.

## The numbers

| | Path A (VS Code extension) | Path B (MCP server) |
|---|---|---|
| Longest single blocking wait | **2 h** (`waitForReplyTimeoutSeconds`, max 7200) | **150 s** (`COPILOT_TEAMS_BRIDGE_WAIT_SECONDS`) |
| Host abandons a tool call after | n/a — in-process | **~5 min**, and it sends no progress token |
| How to wait longer | nothing to do | chain `teams_check_replies` with `waitSeconds` |
| Thread poll interval | **10 s** (`pollIntervalSeconds`, 3–300) | **10 s** (`COPILOT_TEAMS_BRIDGE_POLL_SECONDS`) |
| Backoff when reads fail | doubles to a **5 min** ceiling, resets on success or a new wait | same |
| Session idle expiry | **2 h** (`sessionIdleMinutes`) | **4 h** (not configurable) |
| Reply when nothing is blocking | a **new turn in the same chat** within ~10 s | the **extension** reads it and delivers it the same way; only CLI and external clients hold it for the next `teams_check_replies` |
| Reply if the caller disappears | handed back, re-dispatched to chat | handed back to the queue |

The 150 s window is not a limitation of the bridge — it is chosen to sit comfortably
inside the ~5 min at which the host gives up. **A wait that outlives its host is worse
than a short one**: the bridge consumes the reply and marks it read, the host discards the
response, and your message is gone rather than merely late. Short windows keep every
reply recoverable.

## Path A — VS Code Copilot Chat sidebar

### A1. Blocking (`waitForReply: true`)

```
Copilot ── notify(waitForReply) ──► Teams thread          you get a mention
   │
   │  turn is paused, context intact
   │  bridge polls the thread every 10 s, for up to 2 h
   │
   ◄── your reply ── returns as the tool result ── turn continues
```

Two hours is the cap because a paused turn holds a Copilot request open.

If you **cancel the chat turn** while it is waiting, the wait is not simply dropped: it
stays registered, and whatever it collects afterwards is handed back and re-dispatched,
so the reply arrives as a new chat request instead of vanishing.

### A2. Passive (`waitForReply` omitted)

```
Copilot ── notify ──► Teams thread ── turn ends
                          │
                          │  background poll, every 10 s
                          ▼
            your reply ──► opens a NEW chat request
                           prefixed `[Teams reply · session "<title>" · from <name>]`
```

Auto-submitted unless you set `autoSubmitReplies` to false. There is no time limit here
beyond session expiry, so this is the path that lets you reply hours later.

## Path B — agent sessions, CLI, other MCP clients

### B1. Blocking, one window

```
agent ── teams_notify(waitForReply) ──► Teams thread
   │
   │  blocks up to 150 s, polling every 10 s
   │
   ├── you replied  ──► returned as the tool result, work continues
   └── silence      ──► "no reply yet" + how to keep listening
```

An empty window means *nothing yet*, **never** *the user declined to answer*.

### B2. Blocking longer, by chaining

```
teams_notify(waitForReply)        150 s ─┐
teams_check_replies(waitSeconds)  150 s ─┤  no new Teams post,
teams_check_replies(waitSeconds)  150 s ─┘  so you are not spammed
```

Use `teams_check_replies`, not another `teams_notify`, or you get a duplicate message in
the thread for every window.

### B3. Passive

```
agent ── teams_notify ──► Teams thread ── turn ends
                              │
       your reply ──► polled by the EXTENSION (not the server)
                              │
                              ▼
        delivered as a new turn in the originating chat, ~10 s
```

**The asymmetry is smaller than it looks.** Nothing in the MCP protocol lets a server
interrupt an agent that is not calling it, and that is still true. But the MCP server is
spawned per tool call and exits with the turn, so leaving it to poll its own threads meant
a reply could sit unread indefinitely. Instead the **extension** reads those threads on the
server's behalf — it is alive whenever VS Code is — and delivers the reply into the chat
that raised it, exactly as Path A does. This is `relayAgentReplies`, on by default.

So for a **VS Code agent session** a reply does *not* wait for the agent to check. It waits
only for the turn to end.

For the **`copilot` CLI and external MCP clients** the original behaviour still applies:
there is no chat for the extension to write into, so the reply is held in the queue and
returned by the next `teams_check_replies`. It is held, not lost.

## Failure modes that are handled

| What happens | What the bridge does |
|---|---|
| Agency subprocess's upstream session lapses while idle | Detects `-32001`, restarts the subprocess, retries once |
| Upstream starts returning 429 / 5xx | Polling backs off, doubling to a 5 min ceiling, and returns to normal on the first success |
| A thread cannot be read at all | Reports an **error naming the reason** — never "no replies" |
| Host abandons the call mid-wait | `notifications/cancelled` honoured; the reply goes back on the queue |
| Chat turn cancelled mid-wait | The wait hands its reply back, re-dispatched to chat |
| Reply arrives with nothing waiting | Held in a bounded queue rather than marked seen and dropped |
| Session goes quiet past its idle window | A notice is posted in the thread, so silence is never unexplained |

## What is still not handled

- **Nothing is polled while VS Code is closed.** A reply sent overnight is picked up when
  you next open VS Code, provided the session has not expired.
- **The model must choose to call the tool.** The instructions file steers it; nothing
  enforces it.
- On Path B, a reply that arrives after a turn ends is delivered into the originating chat
  by the extension — but for the `copilot` CLI and external MCP clients there is no chat to
  write into, so it still needs the agent to check before it is seen.
