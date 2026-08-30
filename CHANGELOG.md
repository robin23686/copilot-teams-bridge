# Changelog

## Unreleased

- Custom-agent guidance now allows both bridge host surfaces but requires selecting exactly
  one notification tool per session. The extension tool is preferred when callable; MCP is
  the fallback only when it is unavailable. Agents are told not to switch tools mid-session,
  which could create a second Teams thread.

## 1.1.0

Adds support for VS Code **Copilot mode** chats, and fixes two defects that could leave a
thread silently unwatched.

### Copilot mode is now a first-class surface

A Copilot-mode chat (`agent-host-copilotcli:`) was invisible to the bridge: it writes no
transcript, so nothing announced it and nothing could deliver into it. Replies were held
forever.

- **Announced automatically.** A new watcher reads VS Code's own session index, so a
  Copilot-mode chat posts its own Teams thread without the agent having to call the notify
  tool. Chats that already existed are seeded at start-up, so enabling this does not post a
  thread for every conversation in your history.
- **Replies delivered into it**, through the same reveal-and-submit route the sidebar uses.
- **It refuses to guess.** A session is matched only when exactly one Copilot-mode chat
  shares the working folder and was mid-request at the notify. Two candidates means the
  reply is held, not assigned to the likelier one.
- **Delivery is confirmed** from the title of the tab in front, with the session's request
  timing as a fallback.

### Fixes

- **The pause notice is no longer lost.** Expiring a session is a local write; announcing it
  is a network call, and they happened in one pass. A machine waking from sleep expired its
  sessions while the Teams connection was still down, and the notice was dropped for good —
  leaving a thread unwatched while its last message still invited a reply. Announcing is now
  retried until it lands. *(Two of three sessions were silently retired this way.)*
- **A Copilot-mode resource is no longer corrupted.** `agent-host-copilotcli:/<uuid>` has a
  single slash, so a normaliser keyed on `://` treated it as a bare chat id and encoded it
  into a resource addressing nothing.
- **A background watcher no longer outlives its own disposal**, which kept the extension
  host process alive.

### Not shipped

**Resuming a `copilot` CLI session to deliver a reply.** Built and tested, but withheld:
`copilot --session-id` addresses a *finished* session while a live one shares the same id,
so a reply could be written into a conversation another process is still holding. See
[docs/known-issues.md](docs/known-issues.md#5-resuming-a-cli-session-can-write-into-one-that-is-still-running).
The CLI session id is now captured, which is the groundwork for the fix.

Copilot-mode support covers the same need better in practice: it delivers into the chat tab
you are looking at rather than a headless process you cannot see.

---

## 1.0.0

First public release.

Copilot Teams Bridge mirrors each VS Code Copilot chat into its own Microsoft Teams
thread, and routes your replies from Teams back into the chat they came from — so you can
follow a long-running agent session from your phone and steer it without returning to your
desk.

### What works

- **One Teams thread per chat.** A thread is claimed per chat session, matched by chat
  first and key second, so the same conversation never splits across two threads.
- **Replies routed back into the originating chat.** A reply is written into the exact chat
  that raised it and submitted as a turn, not merely queued.
- **Proof of delivery.** The bridge waits for the reply to appear in the chat transcript
  before reporting success, and keeps waiting while the chat is still working rather than
  failing on a fixed deadline.
- **Honest failure.** When a reply cannot be routed it is reported as such, in the thread,
  rather than being silently dropped.
- **Idle sessions pause explicitly.** A session quiet for `sessionIdleMinutes` (default
  120) posts a notice saying the thread is no longer read, so a later message is never lost
  without explanation. Typing in the chat, or **Teams Bridge: Extend a Session**, revives it
  and posts a confirmation.
- **Blocking waits.** `waitForReply` holds a turn open for up to two hours; passive
  listening has no cap.
- **Three hosts.** The VS Code sidebar, VS Code agent sessions over MCP, and the Copilot
  CLI — each identified at source rather than guessed from its shape.
- **Delegated agents report to their parent.** A spawned sub-agent cannot post to Teams
  directly, because nobody could reply to such a thread.

### Requirements

- VS Code 1.104 or later
- A Microsoft work account with Teams, and a channel you can post in
- The Agency Teams MCP, which is already approved in the tenant — no app registration, no
  admin consent, no tunnel

### Known gaps

See [docs/known-issues.md](docs/known-issues.md). The notable ones: a transient network
drop is currently misread as a lapsed Teams session, timers do not survive machine sleep,
and an expired agent session has no reliable route back. None loses a delivered reply, but
all three can make the bridge stop listening earlier than it should.

Nothing is polled while VS Code is closed.
