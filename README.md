# Copilot Teams Bridge

Chat with your coding agent from Microsoft Teams.

When Copilot starts a task it opens a Teams thread and tags you. When it finishes — or gets
stuck — it posts there. You reply from your phone, and your reply becomes the agent's next
instruction.

```
   VS Code                                      Teams
┌──────────────┐                 ┌──────────────────────────────────┐
│ you: "add a  │ ──── starts ──► │ @You  ⏳ Add a solutionArea…     │
│  filter…"    │                 │                                  │
│              │ ──── done ────► │       ✅ Added filter, 4 tests   │
│              │                 │       ❓ Ship it?                │
│  continues   │ ◄─── reply ──── │       > you: yes, add retry too  │
└──────────────┘                 └──────────────────────────────────┘
```

One session ↔ one Teams thread. No ids to type, no `@mentions` needed in replies — the
thread *is* the addressing, so two tasks running at once can never be confused.

> **New here?** [docs/getting-started.md](docs/getting-started.md) — the five-minute setup.
>
> **Full functionality reference:** [docs/reference.md](docs/reference.md) — every host,
> every timing, what a reply may contain, and the known gaps.
>
> **Something not working?** [docs/diagnosing-a-problem.md](docs/diagnosing-a-problem.md) —
> where the logs are, how to read them, and what to send.
>
> **Open defects:** [docs/known-issues.md](docs/known-issues.md) — found by live testing,
> with the evidence, not yet fixed.
>
> **How it works inside:** [docs/architecture.md](docs/architecture.md) — layers, routing,
> design decisions, and every configuration option in one place.

---

## Requirements

- **VS Code 1.95+** with GitHub Copilot Chat
- **[Agency CLI](https://aka.ms/agency)** — run `agency --version` to check
- A Microsoft work account with Teams
- **Windows** — the only platform it has been run on. There is no Windows-specific code and
  no `os` restriction in the manifest, so macOS and Linux ought to work, but neither has
  been tested. See [known gaps](docs/reference.md#known-gaps).

**No app registration. No admin consent. No Power Automate. No tunnel.** The bridge talks
to Teams through the Agency Teams MCP, which is already approved in the tenant, so there is
nothing to get signed off.

## Install

```powershell
git clone <this-repo> copilot-teams-bridge
cd copilot-teams-bridge
npm install
npm run compile
npm run package
code --install-extension copilot-teams-bridge-0.1.0.vsix
```

Reload VS Code, then run **`Teams Bridge: Set Up`** from the Command Palette. It lists your
teams and channels, saves your choice, installs the Copilot instructions, and posts a test
message so you can confirm it works.

That is the whole setup — usually under two minutes. If you need to do it by hand, or want
to know where the team and channel ids come from, see the
**[setup guide](docs/setup-guide.md)**.

## Make Copilot use it automatically

**Set Up** does this for you — it installs `teams-bridge.instructions.md` into your VS Code
user instructions folder, which is what tells the model to call the tool. Reload VS Code
afterwards.

To add it to a single repo instead, copy
[`assets/teams-bridge.instructions.md`](assets/teams-bridge.instructions.md) to
`.github/instructions/` there.

Prefer to drive it yourself? Run **`Teams Bridge: Start a Session`**, or reference the tool
in chat with `#teams`.

**Copilot-mode chats need none of this.** A chat backed by the Copilot CLI agent host is
announced automatically from VS Code's own session index, so it posts its own thread whether
or not the model calls the tool, and replies are delivered back into that tab. Added in
1.1.0.

For a restrictive custom agent, allow both `copilotTeamsBridge_notify` and
`copilot-teams-bridge/*` so either host can expose its bridge surface. The installed
instructions select exactly one for each session: prefer the extension tool when callable,
otherwise use MCP `teams_notify`, and never switch tools automatically after the first
successful update.

## How it behaves

| Event | In Teams |
|---|---|
| Session starts | New thread, subject `⏳ Copilot · <your task>`, **you are @mentioned** so it hits your activity feed |
| Progress / completion | A reply in that same thread |
| You reply in the thread | Delivered to Copilot as a **continuation** of that task |
| Copilot is blocked | Thread says it is waiting; your reply unblocks the same turn |

**Reporting completion does not end the session.** The thread stays open, and a reply picks
the work back up rather than starting something new.

### How long will it wait for me?

Two different waits, and they are easy to confuse:

| | `waitForReply` (Copilot is blocked) | Passive listening (turn finished) |
|---|---|---|
| What Copilot is doing | Paused mid-turn, waiting on you | Nothing; the turn ended |
| How long | `waitForReplyTimeoutSeconds` — **2 h** default and hard maximum in VS Code; the MCP server waits in **150 s** windows and chains them, because MCP hosts abandon longer calls | `sessionIdleMinutes` — **2 h** default in VS Code, **4 h** on the MCP server, **no maximum** |
| Your reply | Resumes the **same turn**, keeping full context | Arrives as a **new turn in the same chat**, keeping its history. CLI and external MCP clients instead hold it until the agent next checks |
| Needs VS Code open | Yes | Yes |

The 2-hour cap on `waitForReply` exists because a blocked turn holds a Copilot request
open. Passive listening has no cap — set `sessionIdleMinutes` to a week if that suits you.

[**How waiting works, per host**](docs/how-waiting-works.md) walks through each flow and
every timing end to end.

**The real constraint is neither of these: nothing is polled while VS Code is closed.** A
reply sent overnight is picked up when you next open VS Code, provided the session has not
expired in the meantime.

### Session lifecycle

```
start ──► active ──► (quiet for 12h) ──► expired ──► extend ──► active …
            ▲                              │
            └──── your reply, or ──────────┘
                  new work reported
```

The window is a **sliding** one: it counts from the last activity, not from when the
session started. Every reply you send and every update Copilot posts resets it, so an
active conversation never expires. When `sessionIdleMinutes` (**2 hours** by default in
VS Code; the MCP server uses **4 hours**) passes with no activity at all:

1. A notice is posted in the thread: *"replies here are no longer being read"*.
2. The thread genuinely stops being polled, so the notice is honest.
3. Run **Teams Bridge: Extend a Session** in VS Code to revive it; the thread confirms
   *"This session is active again"*.

Two exceptions keep a session alive: Copilot actively blocked on `waitForReply`, and any
new work reported to the thread.

Reply `/close` or `/done` to end a session deliberately, or `/stop` to abandon the work.

### Slash commands in a reply

| Command | Effect |
|---|---|
| `/stop`, `/cancel` | Tell Copilot to abandon the task |
| `/close`, `/done` | Close the session; stops watching that thread |
| `/status` | Ask Copilot to report where it is |

Quoted text, `@mentions`, images and formatting are stripped before the instruction reaches
Copilot.

## Commands

| Command | Purpose |
|---|---|
| **Teams Bridge: Set Up** | Pick your team and channel, verify the connection |
| **Teams Bridge: Start a Session** | Open a thread for a task manually |
| Teams Bridge: Send Test Notification | Confirm the round trip |
| Teams Bridge: Start / Stop Listening | Control reply polling |
| Teams Bridge: Check Teams for Replies Now | Force a poll |
| **Teams Bridge: Extend a Session** | Revive an expired session so it listens again |
| **Teams Bridge: Rename a Session** | Rename a session and rewrite its Teams opening message |
| Teams Bridge: Show Sessions | List active sessions |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `teamId` / `channelId` | — | Set by **Set Up**; see the [setup guide](docs/setup-guide.md) to find them by hand |
| `transport` | `agency` | `agency` for Teams, `file` for offline testing |
| `agency.command` | `agency` | Change only if the CLI is not on your PATH |
| `pollIntervalSeconds` | `10` | How often threads are checked for replies |
| `waitForReplyTimeoutSeconds` | `7200` | How long `waitForReply` blocks in VS Code (the MCP server waits in 150s windows, because MCP hosts abandon longer calls) |
| `autoSubmitReplies` | `true` | Submit replies automatically vs. pre-fill the chat box |
| `autoStart` | `true` | Start listening on activation |
| `sessionIdleMinutes` | `120` | Idle time before a session expires and warns you (2 hours; the MCP server uses 4) |

## Also available as an MCP server

The same engine runs as a **Model Context Protocol** server, so Claude Desktop, Cursor and
Copilot CLI can use it too — see [docs/mcp-server.md](docs/mcp-server.md).

In VS Code this needs no setup: the extension registers the server itself, launching it
from its own installed folder. If you configured it by hand in an earlier version, remove
the entry from `%APPDATA%\Code\User\mcp.json` — two copies share one session store and can
swallow each other's replies. The extension warns you once if it spots one.

In the MCP form a reply returns as the *tool result*, so the agent's turn genuinely
continues. The VS Code extension has to open a new chat request, because VS Code exposes no
API to inject a turn into an existing session.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `agency was not found` | Install the [Agency CLI](https://aka.ms/agency) and reopen VS Code |
| No thread appears | Check your instructions tell the model to call the tool at start, or run **Start a Session** |
| Replies do not arrive | **Check Teams for Replies Now**, then read the *Copilot Teams Bridge* output channel |
| Wrong channel | Re-run **Teams Bridge: Set Up** |

**Anything else:** [docs/diagnosing-a-problem.md](docs/diagnosing-a-problem.md) walks through
reading the log, decoding the one-line delivery trace, and what to include in a report.

For a command-line check of the whole path:

```powershell
node out/src/cli/demo.js doctor --team <id> --channel <id>
```

## How it works

| Piece | Responsibility |
|---|---|
| `src/core/bridge.ts` | Session ↔ thread registry, polling, de-duplication, blocking waiters |
| `src/core/transports/agencyTeamsTransport.ts` | Teams via the Agency MCP |
| `src/core/messageFormat.ts` | Renders notifications; sanitises replies to plain instructions |
| `src/mcp/` | The MCP server form |
| `src/vscode/` | Extension, notify tool, chat injection, setup wizard |

`src/core` never imports `vscode`, so the routing logic is unit-tested in plain Node.

### Where messages go

There is **no webhook**. Each user runs **Set Up** once, which writes `teamId` and
`channelId` into *their* VS Code settings. Posting uses the Agency Teams MCP with that
user's own Microsoft identity, so two people running this extension post to their own
channels with no shared secret and nothing to hand round.

### How Copilot knows to use it

**Set Up** installs `teams-bridge.instructions.md` into your VS Code user instructions
folder. That file tells the model to call the tool at the start of a task, when blocked,
and when finished. Without it the tool is registered but never invoked, because a language
model only calls a tool it has been told to use.

This is guidance, not enforcement — the model decides. To force it, reference `#teams` in
your prompt or run **Teams Bridge: Start a Session**.

### What gets polled

Only threads belonging to **your own sessions**. `Bridge.poll()` walks the session registry
and calls `ListChannelMessageReplies` for each active thread's root message id. The channel
itself is never scanned, so other people's threads in a shared channel are invisible to
your bridge. A session stops being polled once it is closed or has been idle for
`sessionIdleMinutes`.

### Where the mapping lives

| Form | Location |
|---|---|
| VS Code extension | `globalState` under `copilotTeamsBridge.sessions` |
| MCP server / CLI | `~/.copilot-teams-bridge/sessions.json` |

Each record holds the session key and title, the Teams thread id, a watermark of the last
reply consumed, and recently seen reply ids for de-duplication. It survives restarts, so a
reply sent overnight is still routed to the right session.

## Testing

```powershell
npm run compile
npm test
```

## License

MIT




