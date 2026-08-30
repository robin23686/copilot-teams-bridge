# Plan: Report a Problem

## The problem with reporting a problem

`docs/diagnosing-a-problem.md` §7 asks a user to assemble a report by hand: find the newest
log folder among one-per-launch timestamped directories, extract the `[route]` line, name
the surface, record two version numbers, and remember to check all of it for anything they
would rather not publish. Every one of those steps is a place the report gets abandoned, and
the steps most often skipped — the surface and the `[route]` line — are the two that decide
whether the report can be answered at all.

The information is already inside the extension. It should collect itself.

## What is being built

A **`Teams Bridge: Report a Problem`** command that interviews the user for the part only
they know, attaches the part only the extension knows, shows them the whole thing before
anything leaves the machine, and opens a labelled GitHub issue.

### 1. The interview

A four-step wizard, each step cancellable, nothing sent until the end:

| Step | Asked as | Required |
|---|---|---|
| Title | input box | yes |
| What happened, and what you expected | input box | yes |
| Steps to reproduce | multi-line, one per line | no |
| Area | quick pick — Teams messages / replies into Copilot / sessions and threads / setup / other | yes |

Area drives the label, which is what makes triage sortable later.

### 2. The evidence

Collected without asking, because the user should not have to know these exist:

- extension version, VS Code version, platform, and the configured transport;
- which notification hosts are actually callable, so the "tool is disabled" class of
  problem is answered by the report itself rather than by a round trip;
- how each live session would be routed right now (`describeRouting`), which is the
  pre-emptive form of the `[route]` line;
- the tail of the newest `Copilot Teams Bridge.log`, with `[route]` lines kept in
  preference to everything else when the budget is tight;
- which state files exist and how large they are — not their contents.

### 3. Redaction, then consent

Redaction is not optional and is applied before the report is ever rendered:

| Redacted | Becomes |
|---|---|
| Home directory | `~` |
| OS username | `<user>` |
| Email addresses | `<email>` |
| Teams team/channel ids | `<teamId>` / `<channelId>` |
| Chat session ids | first 8 characters, then `…` |
| Session titles | kept only if the user opts in |

Session titles are the one genuinely user-owned string in the payload, so they are opt-in
rather than opt-out.

The rendered markdown is then opened **in an editor** and a modal asks for consent. Nothing
is submitted from a wizard the user cannot read the end of.

### 4. Submission

In order, first that works:

1. `gh issue create` — handles a long body and labels in one call.
2. Browser fallback to a prefilled `issues/new` URL, with the body trimmed to a URL-safe
   budget and a note pointing at the saved file for the rest.

Either way the full report is written to
`<globalStorage>/problem-reports/report-<timestamp>.md` first, so a failed submission never
loses the work the user just did.

## Making the issues machine-triageable

The body carries `<!-- copilot-teams-bridge:report v1 -->` and a fenced `report-meta` block
of `key: value` pairs. Both are parsed back out by the same domain module that wrote them,
which is what makes the contract testable in both directions rather than asserted in one.

Labels: `auto-report` (the identifier automation keys on), `needs-triage`, and one
`area:*` label from the interview.

`.github/workflows/triage-problem-report.yml` runs on `issues: [opened]`, executes
`src/hosts/actions/triageIssue.ts` against the event payload, and applies the labels and a
first-pass comment the classifier produces. The classifier is deliberately in the domain
layer: it is a pure function from report to verdict, so its rules are unit-tested rather
than discovered in Actions logs. Handing off to a coding agent is left documented and
switched off — the point of this change is that the evidence arrives, not that it is acted
on automatically.

## Files

| File | Why |
|---|---|
| `src/domain/problemReport.ts` | build, redact, render, parse, classify — all pure |
| `src/hosts/vscode/problemReport.ts` | wizard, collection, consent, submission |
| `src/hosts/actions/triageIssue.ts` | the workflow's entry point |
| `src/hosts/vscode/extension.ts`, `package.json` | register the command |
| `.github/ISSUE_TEMPLATE/*`, `.github/workflows/*` | template and triage |
| `test/problemReport.test.ts` | both directions of the contract |
| `docs/reporting-a-problem.md` | what the command does and what it sends |

## Deliberately not in scope

- Attaching whole log files. A tail with the routing lines kept answers the question; a
  full log is a privacy liability nobody reads.
- Auto-submitting without consent, in any form.
- Letting the triage workflow write code or close issues.
