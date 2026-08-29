# Using the bridge as an MCP server

The bridge also runs as a **Model Context Protocol** server, so it is not tied to VS Code.
Claude Desktop, Cursor, Copilot CLI and VS Code can all post to Teams and block on your
reply using the same engine.

The MCP form has one real advantage: a reply comes back as the **tool result**, so the
agent's turn genuinely continues. The VS Code extension has to open a new chat request,
because VS Code exposes no API to inject a turn into an existing session.

## Tools

| Tool | Purpose |
|---|---|
| `teams_notify` | Post an update; optionally block until you reply |
| `teams_check_replies` | Fetch replies that arrived since the last check |
| `teams_list_sessions` | List sessions and their Teams threads |

`teams_check_replies` reports three distinct outcomes, and the difference matters:
replies found, nothing new, or **the thread could not be read**. The last returns an
error naming the reason, so a wedged connection is never mistaken for a silent user.

A reply that arrives while no `waitForReply` call is outstanding is held, not discarded,
so the next `teams_check_replies` still returns it.

### Waiting longer than the host allows

MCP hosts abandon a tool call that runs too long — VS Code gives up at about five minutes
and sends no progress token, so the server cannot ask for an extension. An over-long wait
is therefore *worse* than a short one: the bridge consumes the reply, the host discards
the response, and the user's message is gone.

So a wait is served in windows of `COPILOT_TEAMS_BRIDGE_WAIT_SECONDS` (default 150), and
a long wait is built from several: `teams_notify` with `waitForReply`, then
`teams_check_replies` with `waitSeconds` for as long as you want to keep listening.

If the host abandons a call anyway, the server honours `notifications/cancelled` and puts
any reply that call had already taken back on the queue, so the next check still sees it.

## Configuration

Everything comes from environment variables, so one binary suits every client.

| Variable | Meaning |
|---|---|
| `COPILOT_TEAMS_BRIDGE_TEAM` | Team (group) id owning the channel |
| `COPILOT_TEAMS_BRIDGE_CHANNEL` | Channel id, e.g. `19:...@thread.tacv2` |
| `COPILOT_TEAMS_BRIDGE_AGENCY` | Agency CLI command (default `agency`) |
| `COPILOT_TEAMS_BRIDGE_WAIT_SECONDS` | How long one wait window blocks (default 150) |
| `COPILOT_TEAMS_BRIDGE_POLL_SECONDS` | Reply poll interval (default 10) |
| `COPILOT_TEAMS_BRIDGE_HOME` | State directory (default `~/.copilot-teams-bridge`) |

Find your team and channel ids by opening the channel in Teams and choosing
**⋯ → Get link to channel**; the URL contains both. Or run
**Teams Bridge: Set Up** in VS Code and copy them from your settings.

### VS Code

Nothing to configure. Installing the extension registers this server with VS Code, which
launches it from the installed extension folder using the editor's own Node runtime and
passes your configured team and channel through. It appears in the MCP server list as
**Copilot Teams Bridge**.

Two consequences worth knowing:

- The server no longer depends on a source checkout. Earlier setups pointed `mcp.json` at
  `out\src\mcp\stdio.js` inside a working copy, so moving or cleaning that folder silently
  killed the bridge — the tools just stopped appearing.
- **If you followed those earlier instructions, delete the entry from
  `%APPDATA%\Code\User\mcp.json`.** Leaving it in place is worse than redundant: both copies
  poll the same channel and share one `sessions.json`, so whichever reads a reply first
  marks it seen and the other never delivers it. The extension warns you once on startup if
  it finds such an entry. Reload the window after removing it.

Changing the team or channel setting restarts the server, since it reads them from the
environment it was launched with.

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`, under `mcpServers`:

```json
{
  "mcpServers": {
    "copilot-teams-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\copilot-teams-bridge\\out\\src\\mcp\\stdio.js"],
      "env": {
        "COPILOT_TEAMS_BRIDGE_TEAM": "<team id>",
        "COPILOT_TEAMS_BRIDGE_CHANNEL": "<channel id>"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`, same shape as Claude Desktop but under `servers`.

## Verify

```powershell
node out/src/mcp/stdio.js
```

It prints `MCP server ready on stdio` to **stderr** and then waits. stdout carries protocol
frames only, which is why logging goes to stderr.

A healthy handshake looks like:

```
initialize  -> copilot-teams-bridge, proto 2024-11-05
tools/list  -> teams_notify, teams_check_replies, teams_list_sessions
tools/call  -> posted to the Teams channel
```

## Prompting the agent

```markdown
When you start a task, call `teams_notify` with status "progress" to open a Teams thread.
Call it again with "completed" and a summary when you finish, or "needs-input" with
waitForReply true when you are blocked — the reply returns as the tool result and is your
next instruction. Use one stable sessionKey per task.
```
