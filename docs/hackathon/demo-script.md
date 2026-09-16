# Demo assets — video script and screenshot list

The two diagrams in this folder are ready to submit as-is. The live footage has to be
captured on your machine, because it shows your real Teams tenant and your real Copilot
session. This is the shot list and the narration so that takes about ten minutes.

> **Need a video without recording a real tenant?** Use
> `media/copilot-teams-bridge-concept.mp4`. It is a 26-second captioned 1080p concept
> video built from fictional product mockups, with actual Teams, VS Code, and Copilot
> icons. The rest of this guide is for an optional live demo that proves the integration.

---

## Before you record

```powershell
cd C:\code\copilot-teams-bridge
npm run compile
npm run package
code --install-extension (Get-ChildItem copilot-teams-bridge-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1).Name
```

Then:

1. **Command Palette → `Teams Bridge: Set Up`** — pick the team and channel. Use a
   channel with no confidential history in it; it will be on screen.
2. **`Teams Bridge: Send Test Notification`** — confirms the loop works before you are
   recording.
3. Set `copilotTeamsBridge.pollIntervalSeconds` to `5`. The default is slower and dead
   air is the enemy of a 90-second video.
4. Have Teams open on your phone, on that channel, screen unlocked.
5. Close any editor tab showing credentials, customer names or internal URLs.

**Offline-safe fallback.** If the tenant is slow or you would rather not show a real
channel, set `copilotTeamsBridge.transport` to `file` and
`copilotTeamsBridge.file.directory` to a scratch folder. The entire loop — post, reply,
resume — runs against files on disk, so you can demo the mechanism with zero network
dependency. Less impressive on camera, but it never fails.

---

## The 90-second video

Record the screen for the VS Code halves, and point your webcam or a second phone at the
handset for the Teams halves. Do not try to screen-mirror the phone; a real hand holding
a real phone is the whole emotional point of the demo.

| Time | Shot | Narration |
|---|---|---|
| 0:00–0:10 | VS Code, Copilot Chat open, you type a genuine request — something that will take a couple of minutes, e.g. *"Add a solutionArea filter to the reserve endpoint and cover it with tests."* | "Agentic coding means my agent now goes away for fifteen minutes. Which means I have to sit here and watch it." |
| 0:10–0:18 | Phone lights up. Teams thread with the @mention and the task title. | "Except now it opens a Teams thread and tags me. So I don't." |
| 0:18–0:26 | Stand up, walk away from the desk with the phone. | "I can go to a meeting." |
| 0:26–0:40 | Phone: the completion post arrives — what changed, files touched, and a question: *"Ship it, or add a retry first?"* | "It tells me when it's done. And when it's stuck, it asks — usually something that takes me five seconds to answer, and would otherwise have blocked it for an hour." |
| 0:40–0:52 | Thumb-type the reply in the thread: *"add the retry too, with backoff"*. Hold on the sent message. | "So I answer. No session id, no @mention, no copy-paste — the thread is the address." |
| 0:52–1:05 | Cut back to VS Code. The reply appears in the chat and Copilot continues working. | "And it lands back in the exact session that asked, as the agent's next instruction. It just carries on." |
| 1:05–1:18 | `Teams Bridge: Show Sessions and Threads` — several sessions, each with its own thread. | "One session, one thread. I can run five of these at once and they can't get confused, because the thread itself says which one I meant." |
| 1:18–1:30 | Terminal: `npm test` showing 489 passing. Then the closing line on screen. | "No app registration, no admin consent, no tunnel — it rides an MCP that's already approved in the tenant. Which is the difference between a demo and something people can actually install." |

**If you only have 30 seconds:** keep 0:00–0:10, 0:26–0:52 and 0:52–1:05. The loop —
asks, you answer from the phone, work resumes — is the entire idea. Everything else is
supporting evidence.

---

## Screenshots to capture

Five stills, in this order. Together they tell the story without any audio, which matters
because most judges skim.

| # | Shot | Why it earns its place |
|---|---|---|
| 1 | VS Code with the prompt just submitted, Copilot working | Establishes the starting point |
| 2 | **Phone: the Teams thread, @mention visible, task title as the thread topic** | The money shot — this is the one to lead with if only one is allowed |
| 3 | Phone: the completion post — result, files changed, and the question | Shows it is a conversation, not a notification |
| 4 | Phone: your typed reply in the thread | Shows the return path being used by a thumb, not a keyboard |
| 5 | VS Code: the reply in the chat and the agent resuming | Closes the loop — proves it actually went back to the right session |

Optional sixth, if the form allows it: `Teams Bridge: Show Sessions and Threads` with
several live sessions, which makes the one-session-one-thread claim concrete.

### Capture tips

- **Crop hard.** Full 4K screenshots of a VS Code window are unreadable as thumbnails.
  Crop to the chat panel.
- **Zoom the editor.** `Ctrl+=` two or three times before capturing, so text survives
  downscaling.
- **Check every pixel for confidential content** — repo names, customer names, ticket
  ids, colleague names in the Teams channel. These get published.
- Use a light theme if the submission page has a white background; a dark screenshot on
  white looks like a hole in the page.

---

## Suggested asset order in the submission

1. `how-it-works.png` — leads, because it explains the idea with no audio
2. Screenshot 2 (phone, thread with @mention) — proves it is real
3. The video
4. `architecture.png` — for judges who ask how it is built
