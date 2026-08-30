# Diagnosing a problem

What to look at when the bridge does not do what you expected, and what to send if you
report it.

Almost every question this bridge raises is one of two: **did my message reach Teams?** and
**did my reply reach Copilot?** They are answered in different places, so start by deciding
which one you have.

---

## 1. Open the log

**View → Output**, then pick **Copilot Teams Bridge** from the dropdown.

This is the first thing to look at and usually the last thing you need. It records every
decision the bridge makes, in order.

### Turn up the level

The output channel has a **gear icon → Set As Default / log level**, or run
**Developer: Set Log Level…** from the Command Palette and choose **Copilot Teams Bridge**.

| Level | What you get |
|---|---|
| **Info** (default) | Every delivery, every expiry, every failure |
| **Debug** | Also the near-misses — "no transcript claims this session", "no single Copilot-mode session matches" |

If a reply is being *held* and you cannot see why, **Debug is the level that tells you**.

### The log on disk

Useful when the window has been reloaded or you want to attach it to a report:

```
%APPDATA%\Code\logs\<timestamp>\window<N>\exthost\personal.copilot-teams-bridge\Copilot Teams Bridge.log
```

macOS and Linux use `~/Library/Application Support/Code/logs/…` and `~/.config/Code/logs/…`.

There is one folder per VS Code launch and one `window<N>` per window, so take the **newest**
one. On Windows:

```powershell
Get-ChildItem "$env:APPDATA\Code\logs" -Recurse -Filter 'Copilot Teams Bridge.log' |
  Where-Object { $_.FullName -notmatch 'mcpServer' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

---

## 2. Read the `[route]` line

Every reply delivery writes exactly one line, deliberately: a decision spread over eight
interleaved entries is what made an early failure take a day to read.

```
[route] outcome=delivered session="My task" reply=1788027804030
        harness=vscode-sidebar confidence=exact capturedBy=chat-watcher
        storedChat=vscode-chat-session://local/MmVkOWE… resource=vscode-chat-session://local/MmVkOWE…
        steps=[targeting=known -> beforeReveal(tabs=0[] active=none activeLabel="")
               -> parsed(scheme=vscode-chat-session authority=local) -> commandResolved
               -> chatInFront(tabs=1[mg] active=mg activeLabel="My task")
               -> focusedEditorGroup -> revealed -> wrote(mode=revealed submitted=true)
               -> landingConfirmed]
```

### `outcome` — the answer

| Outcome | Meaning | What to do |
|---|---|---|
| `delivered` | Written into the owning chat and confirmed | Nothing |
| `held` | Put in the chat input for you to check and send | Look at the chat; press Enter |
| `unroutable` | Deliberately not delivered — the owning chat is not known | See §4 |
| `failed` | Something went wrong; will be retried | Check the lines above it |
| `abandoned` | Retried and given up on | The reply stays in Teams; re-send it |

### `steps` — where it stopped

Read left to right. The last step is where it got to.

| Step | Meaning |
|---|---|
| `targeting=known` | The owning chat was recorded — the good case |
| `targeting=none` | No chat recorded; it cannot be steered to one |
| `badResource(…)` | The stored chat reference is malformed |
| `commandRejected(…)` | VS Code refused to open the chat |
| `chatInFront(… activeLabel="X")` | **X is the chat it actually brought forward** — compare it to the session title |
| `noChatInFront(…)` | The reveal did not put a chat in front at all |
| `wrote(mode=revealed submitted=true)` | The text was written and sent |
| `landingConfirmed` | Proved it arrived, by finding the marker in that chat's transcript |
| `landingUnconfirmed` | Written, but could not be proved — treated as not delivered |
| `cannotSteer(…)` | Given up: a previous attempt could not be proved, so it will not keep trying |

`activeLabel` is the single most useful field in the line. If it names a *different*
conversation from `session`, the reveal went to the wrong chat and everything after it is
suspect.

---

## 3. Ask the extension what it thinks

Three commands answer most questions without reading anything.

**`Teams Bridge: Show How Replies Will Be Routed`** — the important one. For every live
session it prints where a reply *would* go, before one arrives:

```
My task
    harness  vscode-sidebar (exact, via chat-watcher)
    chat     vscode-chat-session://local/MmVkOWE…
    adapter  vscode-sidebar
    replies  reach Copilot
```

`replies will be held` here means a reply will **not** be delivered, and you can see that
now rather than after sending one.

**`Teams Bridge: Show Sessions and Threads`** — which sessions exist and which Teams thread
each owns.

**`Teams Bridge: Check Teams for Replies Now`** — forces a poll instead of waiting for the
10-second cycle. Useful for telling "not polling" apart from "polled and decided not to
deliver".

Also available: **`Teams Bridge: Test a Harness Type`** (exercise the delivery path against
a chat you pick), **`Teams Bridge: Send Test Notification`** (prove the Teams half works at
all), and **`Teams Bridge: Reset All Local State`** (see §6).

---

## 4. Symptoms

### Nothing appears in Teams

1. **Is the transport configured?** Run **`Teams Bridge: Send Test Notification`**. If that
   fails the problem is Teams, not the bridge.
2. **`agency was not found`** — install the [Agency CLI](https://aka.ms/agency) and reload.
3. **Nothing at all, no error** — check `teamId` and `channelId` are set. Without them the
   MCP server falls back to a local file transport and an agent will believe it posted while
   the messages go to `~/.copilot-teams-bridge/inbox/`.
4. **A sidebar chat was never announced** — announcing skips prompts shorter than
   `announceMinPromptLength` (30 characters) as chit-chat, and can be switched off with
   `announceSessions`.

### I replied in Teams and nothing happened

Find the `[route]` line for that reply. If there is none, the reply was never read:

- **Is the bridge listening?** The log says `Teams bridge listening every 10s` when it is.
  Run **`Teams Bridge: Start Listening for Replies`** if not.
- **Is the session expired?** An expired thread is not read at all. You would have been told
  in the thread — *"this session has gone quiet…"* — and the fix is to carry on in that chat
  in VS Code, or run **`Teams Bridge: Extend a Session`**.
- **Nothing is polled while VS Code is closed.** A reply sent overnight is picked up when you
  next open VS Code.

If there *is* a line, its `outcome` says what was decided.

### It says `unroutable`

The bridge knew it could not identify the owning chat and refused to guess, because writing
one task's instruction into another task's conversation is worse than not delivering it. The
reply stays in Teams and is retried when the chat becomes identifiable.

At **Debug** level the log says which check failed — no transcript claims the session, or
more than one Copilot-mode chat matched.

### The reply went to the wrong chat

Check `activeLabel` in the `[route]` line against `session`. If they differ, report it with
that line — it contains everything needed.

### A thread stopped responding with no explanation

Sessions expire after `sessionIdleMinutes` (default **120**). Expiry is evaluated by the
running extension, so it is noticed at the next poll after VS Code is open — not on a timer
while it is closed. A session that went quiet overnight is expired shortly after you start
the editor, and the thread is told then.

---

## 5. Where state lives

| What | Where |
|---|---|
| Sidebar sessions | VS Code `globalState` (not a file) |
| Agent / CLI sessions | `~/.copilot-teams-bridge/sessions.json` |
| Thread claims | `~/.copilot-teams-bridge/threads.json` |
| Replies already delivered | `~/.copilot-teams-bridge/delivered.json` |
| Messages the bridge itself posted | `~/.copilot-teams-bridge/posted.json` |
| Local-transport fallback | `~/.copilot-teams-bridge/inbox/` |
| CLI MCP registration | `~/.copilot/mcp-config.json` |

`sessions.json` is worth reading directly when a reply is held: `identity`, `thread`,
`chatSessionResource` and `pending` between them explain most decisions.

---

## 6. Starting clean

**`Teams Bridge: Reset All Local State`** forgets every session and thread claim. New work
opens new threads; existing Teams threads are left in place but nothing is listening to them
any more.

Use it when the local state is inconsistent, not as a first response — it discards the
identity records that make delivery accurate.

---

## 7. Reporting a problem

**Command Palette → `Teams Bridge: Report a Problem`.** It asks what happened, collects
everything below on its own — log tail, routing decision, versions, which notification hosts
are callable — redacts it, shows it to you, and opens a labelled issue once you agree.
[What it collects and what it removes](reporting-a-problem.md).

Everything after this point is the manual route, for when the extension will not start.

Open an issue at
[github.com/robin23686/copilot-teams-bridge/issues](https://github.com/robin23686/copilot-teams-bridge/issues)
with:

1. **The `[route]` line**, if the problem involves a reply. It is usually sufficient on its
   own.
2. **What you expected and what happened**, including which chat you expected the reply in.
3. **The surface** — sidebar, Copilot mode, an agent session, or the `copilot` CLI. The
   routing differs per surface and this is the first thing anyone will ask.
4. **Extension and VS Code versions** — `Help → About`, and the extensions list.
5. **The log**, at Debug level if you can reproduce it.

Please check the log for anything you would rather not share before attaching it. It records
session **titles** and chat identifiers; it does not record message bodies or your prompts.

Known problems are listed in [known-issues.md](known-issues.md) — worth a look before
filing, since several observed behaviours are already recorded there with their evidence.
