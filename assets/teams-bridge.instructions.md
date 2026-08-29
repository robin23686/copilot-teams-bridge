---
description: Keep the user updated on Microsoft Teams via the Copilot Teams Bridge.
applyTo: '**'
---

# Teams updates

You have a Teams bridge tool that posts to the user's Microsoft Teams channel. Use it so
they can follow the work from their phone and reply to steer it.

**The tool has a different name depending on where you are running. Use whichever one is
in your toolset:**

| Host | Tool name |
|---|---|
| VS Code Copilot Chat | `copilotTeamsBridge_notify` |
| Agent / CLI sessions | `teams_notify`, listed as `copilot-teams-bridge-teams_notify` |

Both take the same arguments.

**Before the first substantive step:**

1. If the notify tool is already callable, call it directly.
2. If it appears only in a deferred-tools reminder, call `search_tool` with a query such as
   `post a Teams bridge notification and wait for a reply`, then call the returned tool.
3. If a custom agent restricts tools, its frontmatter must include
   `copilot-teams-bridge/*`; otherwise neither direct invocation nor tool search can expose it.

Do not start repository, cloud, PR, work-item, or shell work before posting the start update.

If neither notify tool exists even after tool search, carry on with the task and mention
the missing bridge once at the end rather than stopping.

Call it at three points in every task that uses tools, accesses a repository or cloud
service, or takes more than a one-line conversational answer:

1. **When you start** — `status: "progress"`. This opens the Teams thread and tags the
   user. Do this before the first substantive step, not after.
2. **When you are blocked** and need a decision — `status: "needs-input"`, set `question`,
   then **end your turn**. The user answers in whichever place suits them and it reaches you.
3. **When you finish a piece of work** — `status: "completed"`, with a short summary and
   the files changed, in **both** the Teams post and your chat reply.

Leave `waitForReply` unset at all three points. See below for why blocking is the wrong
default.

## The session does not end when you report completion

`status: "completed"` means *this piece of work is done*, not *the conversation is over*.
The Teams thread stays open and the user often replies with the next thing to do.

**The user can answer in either place — so do not block.** After posting, end your turn
normally and leave `waitForReply` unset. A reply typed in **this chat** continues the
conversation natively; a reply posted in **Teams** is delivered here automatically. Both
routes reach you.

**Blocking breaks the chat route.** While `waitForReply` is waiting, the turn is frozen, so
the user cannot answer in the chat they are sitting in front of — the only way to reach you
is Teams. That is the wrong default for someone at their desk. Use it only when the user has
said they are stepping away and you need to keep the turn alive for them.

**If a wait is interrupted, the user answered here.** The host cancels the call when the
turn resumes, so read their latest chat message and treat that as the reply instead of
waiting on Teams again.

**A wait is a window, not a verdict.** When you do block, the tool returns after a couple of
minutes because the host abandons any tool call that runs much longer. Coming back empty
means *"nothing yet"*, never *"the user declined to answer"*. To carry on waiting, call
`teams_check_replies` with `waitSeconds` — do **not** post another notification just to
re-arm, or the user gets a duplicate message.

Nothing is lost if you do stop: a reply that arrives later is held and handed to you the
next time you check.

If a reply instead arrives after your turn ended, it is delivered prefixed with
`[Teams reply · session "<title>"]`. Treat it as a **continuation of that same task**:

- Keep the **same `sessionKey`** so every update stays in one Teams thread.
- Pick the work back up from where it left off; do not restart or re-plan from scratch.
- There is no limit to how many rounds a session can have.

Only stop when the user replies `/stop`, `/cancel`, `/close` or `/done`. The tool will tell
you when that happens.

## Rules

- **Teams is an extra audience, never a replacement for this chat.** Posting an update does
  not discharge your duty to answer where the user is. Give the full update and summary in
  your chat reply as well; a bare "posted to Teams" leaves someone sitting in VS Code
  watching their own work be sent somewhere else. The Teams summary may be shorter — it is
  read on a phone — but the chat answer must stand on its own.
- **Quote the Teams reply back to the user before acting on it.** On the MCP path a reply
  arrives as a *tool result*, which chat UIs collapse or hide, so the user cannot see the
  instruction they just sent — only you acting on something invisible, which looks like the
  reply was ignored. Start the next message with what came back, e.g.
  `> From Teams: "<their words>"`, then act on it.
- **Scope every `teams_check_replies` to your own session.** Pass the `sessionId` you were
  given, or your `sessionKey`. The server enforces this: on a shared MCP server, an
  unscoped call is rejected with a JSON-RPC error so another task's reply cannot be
  drained by mistake. `teams_list_sessions` similarly only shows sessions started by your
  own harness in your workspace.
- **Pass `sessionId` on every follow-up.** The first call returns a session id; quote it
  back on every later update about that task. It is exact, unlike a key you have to
  retype, and it guarantees the update lands in the right Teams thread.
- On the very first call, when no id exists yet, supply a stable `sessionKey` such as
  `"reserve-api-solutionarea"`. Only start a new key for genuinely unrelated work.
- Keep `summary` short and skimmable; it is usually read on a phone.
- List changed files in `files`.
- PR lists, work-item searches, repository inspection, diagnostics, and cloud lookups are
  tool-using tasks and MUST be announced even when no code change is required.
- Skip only genuinely conversational one-line answers that use no tools.
- If the tool reports that it is not configured, carry on with the task and mention it once
  at the end rather than stopping.
