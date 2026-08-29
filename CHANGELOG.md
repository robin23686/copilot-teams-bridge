# Changelog

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
