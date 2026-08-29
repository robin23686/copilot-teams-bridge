# Known issues

Open defects found by live testing but not yet fixed. Each entry records the evidence, so
the investigation does not have to be repeated before the fix is written.

Nothing here has been changed in code. These are follow-ups.

---

## 1. A network drop is misread as a lapsed Agency session

**Severity:** high — it destroys a healthy Teams connection.

`isStaleSessionError` in `src/infrastructure/transports/agencyTeamsTransport.ts` decides
whether to respawn the Teams MCP subprocess:

```ts
if (error instanceof AgencyCallError && error.code === SESSION_NOT_FOUND) return true;
const message = error instanceof Error ? error.message : String(error);
return /session (not found|expired|has expired)/i.test(message);
```

`SESSION_NOT_FOUND` is `-32001`. The Agency proxy **overloads that code**: it returns
`-32001` both for a genuinely lapsed upstream session *and* for a transport failure:

```
{"code":-32001,"message":"Remote connection error: Remote connection error after 4 attempts"}
```

The message-text check would have rejected that string, but the code check runs first and
wins, so the subprocess is torn down for a fault a retry would have survived.

**Evidence — 2026-08-29 04:55:** the machine suspended (Kernel-Power 187 at 04:54:54,
event 42 "entering sleep" at 04:55:00). The in-flight `ListChannelMessageReplies` then
failed four times with `is_connect=true is_timeout=false` — no route to host, not a slow
server — and the bridge logged *"Agency session lapsed during ListChannelMessageReplies;
restarting the Teams MCP subprocess."*

Anything that briefly removes the network hits this: sleep, VPN reconnect, Wi-Fi change.

**Fix direction:** require the code *and* a session-shaped message, or classify
`is_connect=true` as retriable-without-respawn.

---

## 2. Nothing re-primes the transport after the machine resumes

**Severity:** high — it silently costs the first poll cycle after a wake, which is exactly
when a reply is most likely to be waiting.

`request()` arms a 120 s timer per JSON-RPC call. Timers do not advance across suspend, so
a timer armed before sleep fires the instant the machine wakes, regardless of how long the
call has really had.

**Evidence:** the `initialize` sent at 04:55:35 (during issue #1's respawn) rejected at
**09:02:21** with *"Timed out waiting for initialize"* — over four hours later, after a
clock jump from `~11:5x UTC` to `16:01:44 UTC`. Two thread reads failed on that dead
transport before a new subprocess became ready at 09:02:24.

Worse, the **expiry sweep ran at 09:02:21.578, inside that dead window** — after the reads
had failed and before Teams was reachable again. Session 1's pause notice only got out
because posting lazily spawns a fresh child.

**Fix direction:** detect resume (`vscode.window.onDidChangeWindowState`, or a
monotonic-vs-wall-clock jump check), reconnect and re-poll *before* sweeping for expiry.

---

## 3. Agent sessions expire with no log line and no Teams notice

**Severity:** high — this is the failure mode the expiry notice exists to prevent.

There are two stores. The extension's memento holds sidebar sessions; `sessions.json`
holds agent sessions and is owned by `AgentReplyRelay`. Both expire independently, and
both stop reading an expired thread.

On 2026-08-29 all three morning sessions ended up expired, but only one was announced:

| Session | Store | `expiredAt` | Log line | Teams "Paused" notice |
|---|---|---|---|---|
| Fingle Notification Fix Session 1 | memento | 16:02:21.5Z | yes | **yes** |
| Single notification fix Session 2 | `sessions.json` | 16:02:17.056Z | no | **no** |
| Session 3 — new local-mode test | `sessions.json` | 16:02:17.056Z | no | **no** |

`AgentReplyRelay.expireIdleSessions` should log *"Agent session … expired after going
quiet"* and call `deps.onExpired`. Neither happened, yet `expiredAt` was persisted — and
it was written ~4 s *before* the extension's first log line of the session, while the
transport was still dead (issue #2).

Because `expiredGraceHours` defaults to `0`, `collect()` skips expired sessions entirely.
So those two threads are no longer read **and** were never told so: their last message
still carries a footer inviting a reply. A reply there is discarded in silence.

Not yet root-caused. Candidates: the `notified` guard suppressing the notice, or the
`onExpired` post failing against the dead transport and being swallowed by the
`catch` that only logs a warning.

**Fix direction:** root-cause the missing notice first; consider making the pause notice
durable (retry on the next healthy poll) so a transport failure cannot swallow it.

---

## 4. An expired agent session cannot be revived by any user action

**Severity:** high — the thread is dead with no way back, and nothing says so.

Reviving a session clears `expiredAt` in **both** stores. Neither route reaches an
agent-only session whose key is not chat-shaped:

- **Typing in the chat.** The watcher calls `touch(sessionKey)` with the chat-derived key
  (`chat-<uuid>`). `AgentReplyRelay.matches` compares only `session.key`, and
  `chatSessionResourceFromKey(session.key)` — it never consults the stored
  `session.chatSessionResource`. A session keyed `single-notification-fix-session-2`
  therefore matches nothing.
- **Teams Bridge: Extend a Session.** The picker is built from
  `Bridge.listExpiredSessions()`, which reads the memento. As `postExpiryNotice` already
  notes, relay session ids *never enter the memento*, so these sessions are not offered.

**Evidence — `sessions.json` after the 2026-08-29 expiry:**

| Session | `key` | `chatSessionResource` |
|---|---|---|
| Single notification fix Session 2 | `single-notification-fix-session-2` | `null` |
| Session 3 — new local-mode test | `copilot-bridge-local-session-3` | `null` |

Both had their chat identified at delivery time — the log shows *"belongs to chat
2ed9a15a…"* and *"belongs to chat a553b006…"* — but the resource was never persisted, so
after expiry there is nothing left to match on.

Combined with issue #3 (no pause notice), these threads still invite a reply, silently
discard it, and offer no way to bring the session back.

**Fix direction:** persist `chatSessionResource` when the chat is identified, and have
`matches` consult it; and/or include relay sessions in the extend picker.

---

## Cross-cutting note

Issues #1, #2 and #3 chained together in a single event: sleep triggered a false respawn,
the frozen timer left the transport dead on wake, and the expiry sweep ran inside that
window and lost two of three notices. Fixing #1 and #2 makes #3 much rarer, but #3 still
needs its own fix — a notice that cannot be delivered must not be silently dropped.

Issue #4 is independent of the suspend, and is the one that leaves a thread permanently
unusable. #3 and #4 together are the worst combination the bridge can produce: a thread
that still invites replies, ignores them, and cannot be revived.
