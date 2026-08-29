# Phase 2 — Start and control sessions from Teams

**Status:** Draft for review · **Owner:** robin23686 · **Depends on:** Phase 1 (shipped)

---

## 1. Goal

Today Teams is an *output* channel with a reply path: Copilot opens a thread, you answer,
work continues. Phase 2 makes Teams an **entry point** — you start new work from your phone,
choosing the engine, model, mode and reasoning effort, without touching your laptop.

### What "done" looks like

You post this in the channel:

```
/run
task: Add a solutionArea filter to the Reserve API and update the tests
repo: CE-EA-ATC-Services
model: claude-sonnet-4.5
mode: autopilot
effort: high
```

Within seconds the bridge replies in-thread with *"Started — session `abc123`"*, a Copilot
CLI session begins on your machine, and progress and completion arrive in that same thread.
Replies keep steering it, exactly as in Phase 1.

---

## 2. Why this is feasible

Verified against the installed CLI (`agency 2026.7.31.2`), not assumed:

| Capability you asked for | Flag that provides it |
|---|---|
| Model selection | `--model <model>` (`auto` lets Copilot choose) |
| Copilot / Agency mode | `--mode interactive\|plan\|autopilot`, `--autopilot` |
| Allow-all | `--allow-all` (= `--allow-all-tools --allow-all-paths --allow-all-urls`) |
| Reasoning capacity | `--effort none\|minimal\|low\|medium\|high\|xhigh\|max` |
| Session identity | `--session-id <id>`, `-n/--name`, `-r/--resume`, `--continue` |
| Non-interactive run | `-p/--prompt` with `--allow-all-tools` |
| Agent selection | `-a/--agent`, `--source personal\|repo\|organization\|company` |
| Bounded autonomy | `--max-autopilot-continues <count>` |

A stable `--session-id` is what lets a Teams thread map onto one resumable CLI session, so
follow-up replies continue the same conversation rather than starting fresh.

---

## 3. Scope

### In scope

1. **Command grammar** — a `/run` template parsed from a Teams message, with defaults.
2. **Channel listener** — a long-lived watcher for new *root* messages (Phase 1 only reads
   replies within known threads).
3. **Session launcher** — spawns `agency copilot` with the requested settings and streams
   progress back to the originating thread.
4. **Session control** — `/stop`, `/status`, `/resume` against a running session.
5. **Safety** — allowlisted repos, an approval step for `--allow-all`, and one-command
   kill.

### Explicitly out of scope

- Running work on a server or in CI. This drives *your* machine, which is the point.
- Starting sessions for other people from your channel.
- A Teams bot app registration. The MCP path keeps us free of that.

---

## 4. Design

### 4.1 Command grammar

Deliberately line-oriented and forgiving — it will be typed on a phone.

```
/run
task: <free text, may span lines>          (required)
repo: <alias or path>                      (optional, default: configured default repo)
model: <model id | auto>                   (optional, default: auto)
mode: interactive | plan | autopilot       (optional, default: interactive)
effort: none|minimal|low|medium|high|xhigh|max   (optional, default: medium)
allow: all | tools | none                  (optional, default: none)
agent: <agent name>                        (optional)
```

Shorthand for the common case, since most messages will be one line:

```
/run Add a solutionArea filter to the Reserve API
```

**Parsing rules**
- Keys are case-insensitive; unknown keys are reported rather than ignored, so a typo
  never silently changes behaviour.
- `task:` may be multi-line; everything after it that is not a recognised key belongs to it.
- Invalid enum values produce a reply listing the valid options.

### 4.2 New components

| Component | Responsibility |
|---|---|
| `core/commandParser.ts` | `/run` and control commands → a validated `SessionRequest`. Pure, no I/O. |
| `core/channelWatcher.ts` | Polls `ListChannelMessages` for new root messages, de-duplicated by id. |
| `core/sessionLauncher.ts` | Spawns `agency copilot`, tracks the process, streams output, enforces limits. |
| `core/repoRegistry.ts` | Maps a repo alias to an allowlisted absolute path. |
| `vscode/launcherHost.ts` | Runs the launcher inside the extension host, with a status-bar indicator. |

### 4.3 Flow

```
Teams root message
   │  /run task: … model: … mode: …
   ▼
channelWatcher (poll, 10s)
   ▼
commandParser ──► invalid ──► reply with the specific error and valid options
   │ valid
   ▼
repoRegistry ──► not allowlisted ──► reply refusing, list allowed repos
   │ allowed
   ▼
sessionLauncher: agency copilot --session-id <id> --model … --mode … --effort … -p "<task>"
   │
   ├── reply in-thread: "Started — session <id>"
   ├── stream milestones as thread replies
   └── on exit: post the summary
   ▼
Phase 1 takes over: your replies steer the session
```

### 4.4 Mapping a thread to a session

The root message id already identifies a Teams thread. Phase 2 derives the CLI session id
from it (`teams-<messageId>`), which means:

- A reply in that thread resumes **that** session with `--resume`.
- Several `/run` messages create genuinely separate sessions.
- Restarting VS Code loses no mapping, because the registry is persisted.

---

## 5. Safety

Remote code execution triggered by a chat message deserves real guardrails.

| Risk | Mitigation |
|---|---|
| Anyone in the channel starts work on your machine | Only messages from an allowlisted UPN (default: you) are executed. Everything else is ignored, with one reply explaining why. |
| `/run` pointed at an arbitrary path | Repos must be registered aliases; absolute paths are rejected unless explicitly enabled. |
| `--allow-all` misuse | Off by default. `allow: all` posts a confirmation the user must answer `/approve <id>` to, unless pre-approved in settings. |
| Runaway autopilot | `--max-autopilot-continues` capped by setting; wall-clock timeout; `/stop` kills the process tree. |
| Prompt injection from channel content | Only the `task:` field reaches the model; everything else is parsed into typed fields, never concatenated into the prompt. |
| Cost / token blowout | `effort` capped by a setting; `xhigh`/`max` require the same approval as `allow: all`. |

**Default posture: refuse and explain.** A misparsed command must never start work.

---

## 6. Work breakdown

| # | Task | Deliverable | Est. |
|---|---|---|---|
| 1 | Command grammar + parser | `commandParser.ts`, ~20 unit tests | S |
| 2 | Repo registry + allowlist | `repoRegistry.ts`, settings, tests | S |
| 3 | Channel watcher | `channelWatcher.ts`, de-dup, tests | M |
| 4 | Session launcher | `sessionLauncher.ts`, spawn/stream/kill, tests | M |
| 5 | Safety gates | Sender allowlist, approval flow, caps | M |
| 6 | Thread ↔ session registry | Extend the Phase 1 store, resume support | S |
| 7 | Control commands | `/stop`, `/status`, `/resume`, `/approve` | S |
| 8 | Extension host wiring | `launcherHost.ts`, status bar, commands | M |
| 9 | Live verification | Start from phone, steer, stop | M |
| 10 | Docs | README section, template reference, safety notes | S |

Order: 1 → 2 → 3 → 4 → 6 → 5 → 7 → 8 → 9 → 10. Parser and registry come first because
everything else depends on their shapes.

---

## 7. Settings to add

| Setting | Default | Purpose |
|---|---|---|
| `launcher.enabled` | `false` | **Off by default.** Opt in to remote execution. |
| `launcher.allowedSenders` | `[]` | UPNs permitted to start sessions; empty = only you |
| `launcher.repos` | `{}` | Alias → absolute path |
| `launcher.defaultRepo` | `""` | Used when `repo:` is omitted |
| `launcher.defaultModel` | `auto` | |
| `launcher.defaultMode` | `interactive` | |
| `launcher.maxEffort` | `high` | Above this needs approval |
| `launcher.allowAllRequiresApproval` | `true` | |
| `launcher.maxAutopilotContinues` | `5` | |
| `launcher.sessionTimeoutMinutes` | `60` | Wall clock, then terminate |

---

## 8. Open questions

1. **Where does the launcher run?** In the extension host (dies with VS Code) or as a
   detached daemon (survives, but is another thing to manage)? *Recommendation: extension
   host for the POC, daemon later if it proves useful.*
2. **How much output goes to Teams?** Everything is noisy on a phone; only start/finish may
   be too sparse. *Recommendation: milestones plus errors, with `/status` for detail.*
3. **Concurrency** — how many sessions at once? *Recommendation: cap at 3, queue beyond.*
4. **Should `/run` work in a DM** as well as the channel? DMs are more private but need
   `Chat.*` scopes, which are blocked in this tenant. *Recommendation: channel only.*

---

## 9. Success criteria

Phase 2 is done when, from a phone with the laptop untouched:

1. `/run` with model, mode and effort starts a session and confirms in-thread.
2. Progress and completion arrive in that thread.
3. A plain reply steers the running session.
4. `/stop` reliably terminates it.
5. A command from a non-allowlisted sender is refused and logged.
6. A malformed command produces a helpful error and starts nothing.
7. A fresh machine can enable this in under five minutes from the README.

---

## 10. Risks

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| Teams polling misses a message | Low | High | De-dup by id and re-scan a window on start-up |
| `agency copilot` flags change | Medium | Medium | Probe `--help` at startup; warn on unknown flags instead of failing |
| Long-running sessions outlive VS Code | High | Medium | Persist state; on restart, reconcile and report orphans |
| Users treat this as a hosted service | Medium | High | README states plainly that it drives *your* machine |
| Approval flow annoys, gets disabled | Medium | High | Make pre-approval per-repo so the safe path is also the convenient one |
