# Reporting a problem

**Command Palette → `Teams Bridge: Report a Problem`.**

It asks you four questions, attaches the evidence itself, shows you the result, and opens a
GitHub issue once you say so. Nothing is sent before you have read it.

---

## Why not just open an issue?

You can — [the issue tracker](https://github.com/robin23686/copilot-teams-bridge/issues) is
open. But a report that can be answered needs the `[route]` line, the surface the session
was running on, and both version numbers, and
[collecting those by hand](diagnosing-a-problem.md) means finding the newest of several
timestamped log folders first. Those are the parts most often missing, and they are the
parts the extension already knows.

Use the command. Fill the form in by hand only if the extension will not start at all.

---

## What it asks you

| Step | Question |
|---|---|
| 1 | One line describing the problem |
| 2 | What happened, and what you expected instead |
| 3 | Steps to reproduce — one per step, empty to finish (optional) |
| 4 | Which part is at fault: Teams messages, replies into Copilot, sessions and threads, setup, or something else |

Then one more: whether to **include session titles**. The default is to withhold them —
titles are your own words, and the rest of the report works without them.

Pressing `Esc` at step 1, 2 or 4 abandons the report. At step 3 it just stops adding steps.

## What it attaches

- Extension version, VS Code version, platform, Node version.
- The transport in use, whether a team and channel are configured, how many sessions are
  live, and whether the bridge is listening.
- **Which notification hosts are actually callable.** This one line answers the entire
  "the tool is disabled" class of problem without a round trip.
- **How replies would be routed right now** — the same output as
  `Teams Bridge: Show How Replies Will Be Routed`. Withheld if you withheld session titles.
- **The last 300 lines of this window's log**, with `[route]`, `[probe]`, error and warning
  lines kept in preference to routine polling when it has to choose.
- Which state files exist and how large they are. **Never their contents.**

## What it removes first

| Redacted | Becomes |
|---|---|
| Your home directory, in both plain and escaped spellings | `~` |
| Your OS username | `<user>` |
| Email addresses | `<email>` |
| Teams channel ids and the configured team/channel | `<channelId>`, `<configured-id>` |
| Chat identities and GUIDs | first 8 characters, then `…` |
| Session titles | removed unless you opted in |

Chat identities are shortened rather than deleted, so two different chats in one report stay
telling apart — which is usually the whole question.

Redaction happens when the report is built, not when it is sent, so an unredacted copy never
exists on disk or on screen.

## What happens next

1. The full report is written to
   `<globalStorage>/problem-reports/report-<timestamp>.md`. This happens **before** anything
   is submitted, so a failed or cancelled submission never loses what you just wrote.
2. It opens in an editor for you to read.
3. A modal asks whether to publish it. **Just keep the file** is a real answer — the saved
   copy is yours to send by any route you prefer.
4. If you agree, it files the issue with `gh` when the GitHub CLI is installed and signed
   in, and otherwise opens a prefilled issue in your browser. The browser form carries a
   trimmed body and points at the saved file for the rest.

---

## Labels, and what happens to the issue

Every report carries `auto-report` and `needs-triage`, plus one area label
(`area:teams-delivery`, `area:reply-routing`, `area:sessions`, `area:setup`,
`area:unsorted`).

A workflow then reads the report back out of the issue body and posts a first-pass comment:
the last delivery outcome, whether a notification host was uncallable, and whether anything
needed is missing — in which case it adds `needs-info`.

Two things it deliberately does not do: it never touches an issue without the
`<!-- copilot-teams-bridge:report v1 -->` marker, so hand-written issues are left entirely
alone; and it never changes code or closes anything. The point is that the evidence arrives
complete, not that it is acted on unsupervised.

The classification rules live in `src/domain/problemReport.ts` and are unit-tested, rather
than living in the workflow where they could only be exercised by filing a real issue.
