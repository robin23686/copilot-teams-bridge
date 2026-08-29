# Getting started — what you actually have to do

Five minutes, once. Everything after step 4 is optional.

---

## Before you start

- **VS Code 1.95+** with GitHub Copilot Chat
- **Agency CLI** — check with `agency --version`. If that fails, install from https://aka.ms/agency
- A Microsoft work account that can post in the Teams channel you want to use

No app registration, no admin consent, no tunnel, nothing exposed to the internet.

---

## Step 1 — Pick a Teams channel

Use a channel where being tagged repeatedly will not annoy anyone. Most people create a
private channel for themselves, or use a personal team with one member.

> Chat threads (1:1 or group chats) do **not** work — it must be a **channel** in a team.

---

## Step 2 — Install the extension

```powershell
code --install-extension copilot-teams-bridge-0.1.0.vsix
```

Then **reload the window** (`Ctrl+Shift+P` → *Developer: Reload Window*).

---

## Step 3 — Point it at your channel

`Ctrl+Shift+P` → **Teams Bridge: Set Up**. It signs in through the Agency CLI, lists your
teams and channels, and writes the settings for you.

<details>
<summary>If the wizard cannot reach Teams</summary>

Open the channel in Teams → **⋯ → Get link to channel**. The URL contains both ids:

- `channelId` — the `19:...@thread.tacv2` part
- `teamId` — the `groupId=` query parameter

The link is URL-encoded: turn `%3a` into `:` and `%40` into `@`. Then set
`copilotTeamsBridge.teamId` and `copilotTeamsBridge.channelId` in your settings.
</details>

---

## Step 4 — Prove it works

`Ctrl+Shift+P` → **Teams Bridge: Send Test Notification**.

A message should appear in the channel, tagging you. If it does not, see
[Troubleshooting](#troubleshooting).

**You are done.** Copilot can now reach you in Teams.

---

## Step 5 — Nothing, unless you use a custom agent

A model only calls a tool it has been told about, so the bridge ships an instructions file
and installs it for you — into both the Copilot Chat folder and the agent/CLI folder,
because they read different ones. Setup writes it, and every launch re-checks it and
refreshes it when the build ships newer guidance.

To read what Copilot is being told:

```powershell
code "$env:APPDATA\Code\User\prompts\teams-bridge.instructions.md"
```

**The one case that still needs you:** a custom agent with a `tools:` allowlist must include
the bridge, or it cannot call the tool whatever the instructions say:

```yaml
tools: [read, search, execute, copilot-teams-bridge/*]
```

---

## Using it day to day

### Starting

Just work normally. When a Copilot session starts, a Teams thread opens and tags you.

This happens **automatically**, whether or not the model decides to call the tool: the
bridge watches the chat transcripts VS Code already writes. Short prompts are skipped, so
a quick question does not create a thread.

| Setting | Default | Effect |
|---|---|---|
| `announceSessions` | `true` | Open a thread when a session starts |
| `announceMinPromptLength` | `30` | Shortest prompt worth announcing |

To start one deliberately: **Teams Bridge: Start a Session**.

One Copilot session ↔ one Teams thread. You never type an id — the thread *is* the
addressing, so two tasks running at once cannot be confused.

### Where the updates show up

**Both in this chat and in Teams.** If you are sitting in VS Code you still get the full
update in the chat — the Teams post is an extra copy for when you walk away, not a
redirection. The Teams version may be shorter because it is read on a phone.

### Replying — either place works

You can answer **in Teams** or **in the VS Code chat**, whichever is to hand:

- **In Teams** — reply in the thread. No `@mention` needed. It is delivered back to VS Code.
- **In VS Code** — just type in the chat as normal.

Copilot posts its update and then hands the turn back, so the chat stays usable. You are
never stuck having to reach for your phone to answer a question about the editor in front
of you.

| Reply | What happens |
|---|---|
| Ordinary text | Becomes the next instruction |
| `/status` | Copilot reports where it has got to |
| `/ping` | Confirms the bridge is alive |
| `/stop` `/cancel` `/close` `/done` | **Ends the session** |
| Text **with** a screenshot | The text arrives; the image is dropped |
| A screenshot **on its own** | **Nothing arrives** — see below |

> **`/done` ends the session.** It reads like "I have finished typing", but it is a synonym
> for `/stop`. If you mean "carry on", use plain words.

> **Never send an image on its own.** It is discarded silently — Copilot is never told you
> replied. Always include a sentence with it. Image support is not built yet.

### Running several tasks at once

Replies are routed to the task they belong to:

- **Agent and CLI sessions** — each agent asks for its own session, so it only ever receives
  its own replies. Another task’s reply is left waiting for that task.
- **The VS Code sidebar** — the bridge remembers which chat started the task and brings it
  to the front before delivering, so the reply lands in the right conversation.

If the sidebar cannot identify the chat (older VS Code builds), it falls back to the focused
chat — and with more than one task running it leaves the reply **unsent in the chat input**
so you can check it first. Override with `copilotTeamsBridge.replyDelivery`.

### When your reply is picked up

You get a short **"Got it — working on this."** in the thread as soon as the instruction
reaches the agent, so you are not left wondering whether it arrived.

- **Copilot is waiting for you** — it arrives within about 10 seconds and work continues.
- **Copilot is mid-task** — it is delivered the next time it checks. Nothing is lost, but
  it will not interrupt work already in flight.
- **The turn has finished** — in the sidebar it opens a new chat request automatically. In
  an agent session it is held until the agent next checks.

Full detail: [how-waiting-works.md](how-waiting-works.md).

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Nothing posts to Teams | Sessions are announced automatically; check `announceSessions` is on and your prompt was longer than `announceMinPromptLength`. Look for `Watching for new Copilot sessions` in the **Copilot Teams Bridge** output. |
| `agency was not found` | Agency CLI missing or not on PATH. Install it, then reload the window. |
| Wizard lists no teams | Agency CLI not signed in. Run `agency --version`, complete sign-in, retry. |
| Replies never arrive | Check the **Copilot Teams Bridge** output channel. Confirm you replied *in the thread*, not as a new channel post. |
| A reply to an old thread did nothing | Threads are watched for 24 h after they expire; replying within that resumes the session. Past that, start a new session or use **Extend a Session**. |
| An image-only reply did nothing | Expected — not supported yet. Resend with text. |
| A reply appeared in the wrong chat | The bridge reveals the chat that started the task, recovering it from the chat transcript for agent sessions that record none. If it cannot be identified, the reply falls back to the focused chat and, with several tasks running, is left unsent for you to move. |
| The same reply kept arriving every few seconds | Fixed in the current build. The MCP server and the extension share one session file, and the server used to restore replies the extension had just delivered. Update and reload; if it happens on an old build, close the chat that spawned the server. |
| Tools vanished mid-session | The MCP server restarted. Start a new chat session; a session's toolset is fixed once established. |
| Warning about a duplicate `mcp.json` entry | Remove the bridge entry from `%APPDATA%\Code\User\mcp.json` and reload. Two copies share one store and can swallow replies. |

Check the plumbing without Teams:

```powershell
node out/src/cli/demo.js doctor --team <teamId> --channel <channelId>
```

---

## What next

- [reference.md](reference.md) — every feature, host, timing and known gap
- [architecture.md](architecture.md) — how it works inside, and every setting explained
- [how-waiting-works.md](how-waiting-works.md) — how long it waits and why
- [setup-guide.md](setup-guide.md) — the long-form version of this page
