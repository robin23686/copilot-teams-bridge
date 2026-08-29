# Delivering Teams replies to `copilot` CLI sessions

**Status:** design only — nothing implemented. No behaviour has changed on this branch.
**Branch:** `feature/cli-session-reply-delivery`

---

## The gap

Three harnesses can start a session. Only two can receive a reply:

| Harness | Reply delivery today |
|---|---|
| `vscode-sidebar` | Delivered into the chat, submitted as a turn |
| `vscode-agent-mcp` | Same — the extension reads the thread on the MCP server's behalf |
| `cli-runtime` | **Held in a queue.** Reaches the agent only if it happens to call `teams_check_replies` again |

`DELIVERABLE_HARNESSES` in `src/application/services/harness.ts` lists only the first two,
so a CLI session's thread carries a footer saying the reply is queued rather than
inviting one.

That footer is honest, but the outcome is poor: a CLI turn normally ends right after
`teams_notify`, so "the next time it checks" is usually **never**. The reply sits in
`sessions.json` until the session expires, and nothing tells the user.

---

## What was proven, not assumed

Everything below was verified on this machine before the design was written.

### 1. A CLI session identifies itself in the environment

Running a prompt that dumps its own environment:

```
COPILOT_AGENT_SESSION_ID=a9e68183-1fcb-49ab-a252-edbadc5403f4
COPILOT_CLI=1
COPILOT_CLI_BINARY_VERSION=1.0.82-1
```

An MCP server spawned by the CLI **inherits these**. So the bridge can know exactly which
CLI session it is serving — no correlation heuristics, no guessing from `cwd` and
timestamps. This is the same *identity at source* principle already used for
`COPILOT_TEAMS_BRIDGE_HARNESS`.

### 2. That id is a real, resumable handle

`~/.copilot/session-store.db` holds the session:

```
('a9e68183-1fcb-49ab-a252-edbadc5403f4', 'github', 'C:\code\copilot-teams-bridge', '2026-08-29T17:03:03.734Z')
```

### 3. Resuming delivers a new turn **with full context**

```powershell
copilot --session-id a9e68183-… --no-remote --no-ask-user -s --allow-all-tools \
        -p "What environment variable name did you report in your previous message?"
```

Answered `COPILOT_AGENT_SESSION_ID` — from the previous turn. Context was retained.

Turn count went **1 → 2**, and `select count(*) from sessions where id=?` stayed **1**:
the turn was appended in place, not forked into a new session.

**This is the delivery mechanism.** It is the CLI's equivalent of revealing a chat and
submitting into it.

---

## Why the proposed "agent keeps checking" approach cannot work

The suggestion was to have the agent register a command to keep checking its thread until
the session expires. It does not hold, for a structural reason:

- **An MCP server is spawned per session and dies with the turn.** It has no life of its
  own in which to poll.
- **Nothing in MCP lets a server wake an agent that is not calling it.** This is a protocol
  limit, not an implementation gap.
- Therefore "keep checking" can only mean *the agent chains tool calls while its turn is
  still alive*. That is exactly what `waitForReply` + `teams_check_replies` already does,
  and it only works while the agent has chosen to wait.

Covering two hours that way would need roughly **48 chained 150-second calls**, each a real
model round-trip. It burns credits and context, the model may simply stop, and
`--max-autopilot-continues` (default **5**) would cut it off long before. The moment the
turn ends — which is the normal case, right after `teams_notify` — polling stops regardless.

**Conclusion:** the agent cannot keep itself alive. Something outside the turn has to do the
delivering. That something already exists: the extension's `AgentReplyRelay`, which is
alive whenever VS Code is, and which already reads CLI threads today. It just has nowhere
to put the result — until now.

---

## Proposed design

### A. Capture the CLI session id (small, safe, useful on its own)

`src/hosts/mcp/harnessEnv.ts` already reads `COPILOT_TEAMS_BRIDGE_HARNESS`. Extend it to
read `COPILOT_AGENT_SESSION_ID` and `COPILOT_CLI`, and stamp the result onto the session
record as a new `cliSessionId` field, with `capturedBy: 'mcp-ingest'` and
`confidence: 'exact'`.

Valuable even if nothing else ships: it makes CLI sessions diagnosable, and it is the
prerequisite for everything below.

### B. A `CliRuntimeAdapter` that resumes the session

A new `HarnessAdapter` with `harness = 'cli-runtime'`:

- `canDeliver` — true only when a `cliSessionId` is recorded **and** the feature is enabled.
- `deliver` — spawns `copilot --session-id <id> -p <marked reply>` and treats a zero exit as
  delivered.

The reply keeps the existing marker so the audit trail is unchanged:

```
[Teams reply · session "<title>" · from <name>] <text>
```

`cli-runtime` then joins `DELIVERABLE_HARNESSES`. The structural invariant test added in
`test/sidebarAdapterRegression.test.ts` already asserts every deliverable harness has a
registered adapter, so it will hold this honest.

### C. Report the outcome back to Teams

Nobody is watching a terminal, so a resumed run that produces output the user never sees is
half a feature. The spawn should capture stdout (`-s` gives just the agent response) and
post it into the same thread as a normal notification.

Without this the user sends an instruction and hears nothing — the exact failure the bridge
exists to prevent.

### D. Expiry parity

Independently of delivery, a CLI session that goes quiet should post the same **Paused**
notice a sidebar session does. This is issue #3 in `docs/known-issues.md` — agent-store
sessions are expiring silently — and CLI sessions share that store, so one fix serves both.

---

## The risk that decides the default

**A Teams reply would become an unattended agent run with `--allow-all-tools`.**

Non-interactive mode *requires* that flag: there is no middle setting. And the bridge does
not filter replies by author — it reads every message in the thread that it did not post
itself. So:

> Anyone who can post in that Teams channel could cause an autonomous agent run, with full
> tool and file permissions, on the machine running the bridge.

Today the blast radius is bounded because a reply becomes **text in a chat the user is
sitting in front of**. Resuming a CLI session removes the human from the loop entirely.

That is a different trust boundary, and it is why this cannot simply be switched on.

**Therefore:**

- `copilotTeamsBridge.resumeCliSessions` defaults to **`false`**. Enabling it is an explicit
  statement that the channel is trusted.
- The setting description must say plainly what it permits.
- Consider, before shipping: restricting delivery to replies authored by the signed-in user
  (the transport already resolves them for @mentions), and a per-session confirmation for
  the first resume.

---

## Other risks

| Risk | Mitigation |
|---|---|
| The original CLI is still running interactively on that id | Check `updated_at` in `session-store.db`; skip if it moved recently, or refuse while a live process holds the session |
| `copilot` not on PATH, or unauthenticated | `canDeliver` returns false; the reply stays queued and the footer stays honest — never a silent drop |
| A resumed run hangs | Spawn with a timeout; on expiry report `failed`, which the existing retry/`unroutable` path already handles |
| Cost — every reply is a real agent run | Off by default; document it |
| Session id recorded but the store row is gone | Treat a non-zero exit as `failed` and fall back to holding |

---

## What ships in what order

1. **A** — capture `cliSessionId`. No behaviour change, immediately useful.
2. **D** — expiry parity, so a quiet CLI session says so. Fixes a live defect.
3. **B + C** behind `resumeCliSessions`, default off, with the security note in the setting
   description.

Each step is independently valuable and independently revertible. Nothing in steps 1–2 can
regress existing delivery, because neither adds a harness to `DELIVERABLE_HARNESSES`.

---

## Verification this design must satisfy

Live testing has repeatedly caught what unit tests missed, so:

- Structural invariant: every harness in `DELIVERABLE_HARNESSES` has a registered adapter
  (already enforced).
- A `cli-runtime` session with no `cliSessionId` must **not** be reported deliverable.
- With `resumeCliSessions` off, `cli-runtime` behaviour must be byte-identical to today —
  the regression guard that matters most.
- End-to-end, on real hardware: start a CLI session, let its turn end, reply in Teams,
  confirm a new turn appears in `session-store.db` for that id and the response is posted
  back to the thread.
