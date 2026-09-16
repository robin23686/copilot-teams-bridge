# AI-style concept media

Fictional, submission-safe product mockups showing how Copilot Teams Bridge works. They
use no real tenant, colleague, repository, customer, or session data.

## Ready-to-use assets

| Asset | Purpose |
|---|---|
| `copilot-teams-bridge-concept.mp4` | Animated, narrated 1080p concept demo with UI sound cues |
| `01-hero.png` | Primary hero image: VS Code session connected to a Teams phone |
| `02-notify.png` | Copilot works while Teams tells the user where to follow it |
| `03-reply-anywhere.png` | The user unblocks Copilot from their phone |
| `04-resume.png` | The Teams reply returns to the originating VS Code session |
| `05-parallel-sessions.png` | One-session-to-one-thread routing for parallel work |
| `06-actual-extension.png` | Faithful VS Code mockup using real commands and statuses |

Every image is 1920x1080. Each PNG has an editable SVG beside it.

The video combines gentle camera motion, focus highlights, product-style transitions,
spoken narration, and subtle notification/send/resume sounds. Every key idea is still
expressed as on-screen copy, so it remains understandable when judges watch with sound off.

## Accuracy

The visuals are conceptual, but the product behavior is not invented:

- The command names in `06-actual-extension` come from `package.json`.
- The session picker mirrors `Teams Bridge: Show Sessions and Threads` in
  `src/hosts/vscode/extension.ts`.
- `working`, `needs-input`, and `completed` are statuses used by the bridge.
- The start, notify, reply, resume, and one-thread-per-session flow is implemented today.

The Teams, Visual Studio Code, and GitHub Copilot icons were copied from the products
installed on the development machine. Microsoft Teams, Visual Studio Code, GitHub, and
Copilot are trademarks of their respective owners; their icons are used here only to
identify the products in an explanatory concept mockup.

## Regenerating

`generate-scenes.js` writes the SVGs. PNG and MP4 rendering intentionally uses temporary
tools rather than adding runtime dependencies to the extension:

```powershell
$temp = Join-Path $env:TEMP bridge-media
New-Item -ItemType Directory -Force $temp | Out-Null
Push-Location $temp
npm init -y
npm install @resvg/resvg-js ffmpeg-static --no-audit --no-fund
Pop-Location

node .\generate-scenes.js
.\render-animated-demo.ps1
```

`render-animated-demo.ps1` uses the Windows `Microsoft Zira Desktop` voice and the temporary
`ffmpeg-static` installation. It animates the checked-in PNG scenes and produces the final
AAC + H.264 MP4. The checked-in PNGs and MP4 are the submission artifacts; regeneration is
optional.
