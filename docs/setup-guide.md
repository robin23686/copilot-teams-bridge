# Setup guide

Getting from a fresh machine to a working bridge. Two minutes if the wizard works, ten if
you do it by hand.

---

## Before you start

| Requirement | How to check |
|---|---|
| VS Code 1.95+ with Copilot Chat | **Help → About** in VS Code, or `code --version` in a terminal |
| Agency CLI | `agency --version` in a terminal — install from <https://aka.ms/agency> |
| A Teams channel you can post in | Create one in the Teams app, e.g. `CopilotSessions` |

Terminal commands below run in **PowerShell** on Windows or **Terminal** on macOS/Linux.
You can also use VS Code's built-in terminal: **View → Terminal**, or ``Ctrl+` ``.

**Which channel?** Anything you can post to works. A private channel in a team you own is a
good default — Copilot will post progress there, and only your own sessions are ever read.

No app registration, admin consent, webhook or tunnel is required.

---

## Option A — the wizard (recommended)

**1. Install the extension.**

Open a terminal — **PowerShell** on Windows, **Terminal** on macOS/Linux — and `cd` to the
folder containing the `.vsix` file:

```powershell
cd C:\path\to\copilot-teams-bridge
code --install-extension copilot-teams-bridge-0.1.0.vsix
```

> If `code` is not recognised, open VS Code, press `Ctrl+Shift+P`, run
> **Shell Command: Install 'code' command in PATH**, then reopen the terminal.
>
> You can also install without a terminal: in VS Code open the **Extensions** view
> (`Ctrl+Shift+X`) → **⋯** menu at the top → **Install from VSIX…** → pick the file.

**2. Reload VS Code.** `Ctrl+Shift+P` → **Developer: Reload Window**.

**3. Run the wizard.** `Ctrl+Shift+P` → type **Teams Bridge: Set Up** → Enter.

> `Ctrl+Shift+P` opens the Command Palette — the search box at the top of VS Code where
> commands are run. On macOS it is `Cmd+Shift+P`.

**4. Pick your team, then your channel** from the lists that appear.

**5.** It posts a test message and offers to reload. Accept.

The wizard also installs the Copilot instructions that make the agent use the tool
(see [Telling Copilot to use it](#telling-copilot-to-use-it)).

Check Teams — a *"Teams Bridge is connected"* message should be waiting.

---

## Option B — by hand

Use this if the wizard cannot reach Teams, or you want the ids for the MCP server or CI.

### Find your team and channel ids

**From the channel link (easiest)**

1. In Teams, hover the channel → **⋯ → Get link to channel** → **Copy**
2. You get something like:
   ```
   https://teams.microsoft.com/l/channel/19%3AaBcDeFgHiJkLmNoP%40thread.tacv2/YourChannel?groupId=00000000-1111-2222-3333-444444444444&tenantId=55555555-6666-7777-8888-999999999999
   ```
3. Read the two values out of it:

   | Setting | Where in the URL | Example |
   |---|---|---|
   | `channelId` | between `/channel/` and the next `/`, **URL-decoded** | `19:aBcDeFgHiJkLmNoP@thread.tacv2` |
   | `teamId` | the `groupId=` query parameter | `00000000-1111-2222-3333-444444444444` |

   **Decoding matters.** The link contains `%3A` and `%40`; the setting needs the real
   characters — `%3A` → `:` and `%40` → `@`. A channel id always looks like
   `19:<opaque>@thread.tacv2`.

**From the command line**

```powershell
agency mcp teams --transport stdio
```
then call `ListTeams` and `ListChannels`. The wizard does exactly this, so prefer Option A
unless you are scripting.

### Write the settings

**In the settings UI:** `Ctrl+,` (or **File → Preferences → Settings**), then type
*Teams Bridge* in the search box. Fill in **Team Id** and **Channel Id**.

**Or edit the file directly:** `Ctrl+Shift+P` → **Preferences: Open User Settings (JSON)**.
That opens `settings.json`; add the entries inside the existing outer braces:

```json
{
  "copilotTeamsBridge.transport": "agency",
  "copilotTeamsBridge.teamId": "00000000-1111-2222-3333-444444444444",
  "copilotTeamsBridge.channelId": "19:aBcDeFgHiJkLmNoP@thread.tacv2"
}
```

The file lives at:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Code\User\settings.json` |
| macOS | `~/Library/Application Support/Code/User/settings.json` |
| Linux | `~/.config/Code/User/settings.json` |

These are **per user**. Nothing is shared between people who install the extension — each
person points at their own channel and posts under their own Microsoft identity.

### Agent and CLI sessions (MCP)

Nothing to do. The extension publishes its MCP server to VS Code automatically, running it
from its own installed folder, so agent sessions get `teams_notify` without any `mcp.json`
editing and without depending on a source checkout staying where it is.

> **Upgrading from a hand-written entry?** Delete the bridge entry from
> `%APPDATA%\Code\User\mcp.json` and reload the window. Two copies of the server share one
> `sessions.json`; whichever reads a reply first marks it seen, so the other never delivers
> it and the reply is lost rather than duplicated. The extension warns you once if it finds
> such an entry.

### Verify

**In VS Code:** `Ctrl+Shift+P` → **Teams Bridge: Send Test Notification**.

**Or from a terminal**, in the folder where you cloned this repo:

```powershell
node out/src/cli/demo.js doctor --team <teamId> --channel <channelId>
```

Expected:
```
[ OK ] Team and channel configured
[ OK ] Can post to the channel
[ OK ] Can read replies
[ OK ] Session registry
All checks passed.
```

---

## Telling Copilot to use it

The extension registers a tool, but a language model only calls a tool it has been told to
use. Without instructions you get **silence**.

**Two hosts read two different folders.** A file installed in one is invisible to the
other, so Set Up writes to both:

| Host | Folder | Windows path |
|---|---|---|
| Copilot Chat sidebar | VS Code user prompts | `%APPDATA%\Code\User\prompts\` |
| Agent / CLI sessions | Copilot agent home | `%USERPROFILE%\.copilot\instructions\` |

On macOS the first is `~/Library/Application Support/Code/User/prompts/` and on Linux
`~/.config/Code/User/prompts/`; the second is `~/.copilot/instructions/` on both.

> **If a session posts nothing, check this first.** Installing to the prompts folder alone
> makes the sidebar work while agent and CLI sessions stay silent, because they never read
> that folder. Confirm the file exists in *both* paths above.

### Per-repo instead

To enable it only in one repository, copy
[`assets/teams-bridge.instructions.md`](../assets/teams-bridge.instructions.md) to that
repo's `.github/instructions/` folder and commit it. Everyone working in that repo then
gets the behaviour, while their own `teamId`/`channelId` stay personal.

### For a custom agent

If you use an agent definition (`.github/agents/*.agent.md` or an Agency agent) with a
`tools:` allowlist, explicitly allow the bridge MCP server:

```yaml
tools: [read, search, execute, copilot-teams-bridge/*]
```

This is required even when the user-level instructions are loaded. A restrictive custom
agent can see the deferred MCP server reminder while having neither the notify tool nor
`search_tool` available, making the instruction impossible to follow. Also add or retain
the Teams guidance in the agent body if it overrides user-level instructions.

### Verifying the model picked it up

Ask Copilot to do something small but real, such as *"add a docstring to X and update the
test"*. A thread should appear in Teams tagging you. If it does not:

- Reference the tool explicitly with `#teams` in your prompt
- Or run **Teams Bridge: Start a Session**
- Check the **Copilot Teams Bridge** output channel

This is guidance, not enforcement — the model decides. Small tasks are deliberately skipped.

---

## Sessions keep running after "completed"

Reporting completion does **not** end the session. The thread stays open, and a reply is
delivered as a continuation of the same task — Copilot picks the work back up rather than
starting over.

- A session is watched for `sessionIdleMinutes` after its last activity (default **7 days**),
  so a reply sent overnight or after a weekend still lands.
- Reply `/close` or `/done` in a thread to end a session deliberately.
- Reply `/stop` to tell Copilot to abandon the current work.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `agency was not found` | CLI missing or not on PATH | Install from <https://aka.ms/agency>, reopen VS Code |
| Wizard lists no teams | Agency CLI not signed in | Run `agency mcp teams --transport stdio` once and complete any prompt |
| `Set copilotTeamsBridge.teamId…` | Setup not run | Run **Teams Bridge: Set Up** |
| No thread on a new task | Model skipped the tool | Use `#teams`, or check the instructions file exists |
| Replies never arrive | Session idle-expired, or listener stopped | **Check Teams for Replies Now**; raise `sessionIdleMinutes` |
| `Session not found` in the log | The Agency subprocess's upstream session lapsed while idle | Handled automatically — the subprocess is restarted and the call retried once |
| Posts land in the wrong channel | Stale settings | Re-run **Teams Bridge: Set Up** |

If a thread genuinely cannot be read, the bridge now says so. `teams_check_replies`
returns an **error naming the reason** rather than "No new Teams replies", because a
broken read and an empty thread are otherwise indistinguishable — which once left real
replies sitting unread in Teams while the bridge reported it was working normally.

Replies that arrive when nothing is waiting for them are held rather than dropped, so a
message sent between tool calls is still delivered on the next check.

The **Copilot Teams Bridge** output channel logs every post, poll and routed reply.

---

## Uninstalling

```powershell
code --uninstall-extension personal.copilot-teams-bridge
```

Then remove, if you want a clean slate:

- the `copilotTeamsBridge.*` entries from `settings.json`
- `teams-bridge.instructions.md` from your user prompts folder
- `~/.copilot-teams-bridge/` (the CLI and MCP session registry)

Threads already posted stay in Teams; delete them there if you want.
