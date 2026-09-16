# Hackathon submission pack

Everything needed to register the project: title, descriptions at three lengths, the
talking points, and the demo assets.

- `how-it-works.png` / `.svg` — the one-slide explanation of the idea
- `architecture.png` / `.svg` — how it is built
- `demo-script.md` — 90-second video script and the screenshot shot list
- `media/copilot-teams-bridge-concept.mp4` — ready-to-submit animated and narrated concept demo
- `media/*.png` — six polished 1080p product mockups using fictional data and actual
  Teams, VS Code, and Copilot icons

### Best assets to submit

1. `media/01-hero.png` — lead image
2. `media/copilot-teams-bridge-concept.mp4` — animated demo with narration and UI sound cues
3. `media/06-actual-extension.png` — faithful view of the real extension surface
4. `media/05-parallel-sessions.png` — the differentiating one-session/one-thread model

---

## Title

**Copilot Teams Bridge — supervise your coding agent from Teams**

Alternatives, if the form wants something punchier:

| Title | Angle |
|---|---|
| Copilot Teams Bridge | Plain, descriptive — safest |
| Don't babysit your agent | The pain |
| Your agent now has your number | The hook |
| Ship from the bus stop | The outcome |

---

## One-liner (≈20 words)

Every Copilot session gets its own Teams thread, so you can unblock your coding agent
from your phone.

---

## Short description (≈60 words — typical registration field)

Agentic coding sessions run for ten or twenty minutes, then stop — either finished, or
blocked on a one-word decision only you can make. Copilot Teams Bridge gives every
Copilot session its own Microsoft Teams thread. Copilot posts there when it starts,
stalls, or finishes. You reply from your phone, and your answer lands back in that exact
VS Code session as the agent's next instruction.

---

## Full description

### The problem

Agentic coding changed how long a turn lasts. Copilot now goes away and works for ten,
twenty, sometimes forty minutes. Two things follow, and both waste your time:

1. **You cannot leave.** The interesting moment — "done" or "I'm stuck" — arrives at an
   unpredictable time, and the only place it is visible is a VS Code window. So you sit
   and watch a progress spinner, or you tab away and lose the thread.
2. **Agents stall on trivia.** The blocker is rarely deep. It is "which of these two
   names?", "is this in scope?", "ship it or add a retry first?" — five seconds of your
   attention. But if you are in a meeting, the agent sits idle for an hour waiting for
   it.

The result is that a tool designed to run unattended still has to be attended.

### The solution

Copilot Teams Bridge makes the agent reachable where you already are.

When a session starts, the bridge opens a Microsoft Teams thread and @mentions you. As
the agent works it posts progress; when it is blocked it posts the question; when it
finishes it posts the result and the files it touched. You reply in that thread — from
your phone, in a meeting, on the bus — and the reply is delivered back into the
originating VS Code chat session as the agent's next instruction. Work resumes.

**One session, one thread.** That is the whole addressing scheme. You never type a
session id, never @mention the bot, never copy-paste a correlation token — you just
reply in the thread, and the thread itself says which session you meant. Five sessions
can run in parallel and none of them can be confused with another.

### Why it is not as easy as it sounds

Most of the work is in the unglamorous parts, which is also where the interesting design
is:

- **Replies must not arrive twice, or late, or in the wrong session.** State is durable
  across window reloads and restarts, with a per-session watermark plus a
  recently-seen-id set.
- **A session that goes quiet has to be handled honestly.** When one idles out, the
  thread is told so, and replies typed after that point are deliberately discarded rather
  than delivered an hour later with no context.
- **Several hosts can be watching the same thread** — the extension, an MCP server, a CLI
  agent. A precedence policy elects exactly one to post, so you never get the same update
  three times.
- **Untrusted input.** A Teams message is data, never an instruction. Text arriving from
  a thread is never allowed to act as a prompt injection vector.

### Why it can actually be adopted

**No app registration. No admin consent. No Power Automate. No tunnel.**

The bridge talks to Teams through the Agency Teams MCP, which is already approved in the
tenant. There is nothing to get signed off, which is usually what kills an integration
like this before it ships. Install is `npm run package` plus one command in the palette,
and setup is under two minutes.

### How it is built

TypeScript, hexagonal architecture. The application core owns session lifecycle, reply
routing, notification precedence and durable state, and it knows nothing about VS Code or
about Teams. Around it:

- **Three hosts** — a VS Code extension, an MCP server any agent can call
  (`teams_notify`, `teams_check_replies`), and a CLI host with an experimental mode built
  on the Copilot SDK for fully headless sessions.
- **Two transports** — the Agency Teams MCP for real threads, and a file transport that
  runs the entire loop offline so the demo never depends on a tenant being reachable.

That separation is what makes it testable: **489 unit tests**, all fast, no network.

### Status

Working and in daily use. Includes a self-service **Report a Problem** command that
collects logs and opens a labelled GitHub issue, so defects found in real use come back
with evidence attached.

---

## Talking points, if asked

**"Isn't this just notifications?"**
Notifications are one-way. The return path is the point — a reply becomes the agent's
next instruction, in the right session, without you typing an id.

**"Why Teams and not email or Slack?"**
Because it is where the approval conversation already happens, it is already on your
phone, and threads give addressing for free. The transport is an interface; another
backend is a new adapter, not a rewrite.

**"What is the risk?"**
Anything arriving from Teams is treated as untrusted data, never as an instruction. The
bridge never marks anything read on the user's behalf, and never posts to another person
without explicit approval of that exact message.

**"What next?"**
Approve-or-redirect buttons in the thread instead of free text, and letting a reply
retarget a session that has already moved on.
