---
id: ref-1
title: Run drawer prints a verification tail on passing rows too
created: 2026-08-31
kind: chore
tags: client, orchestrator
promoted-to: task-7, task-8
updated: 2026-09-01T07:20:15Z
groom-elapsed: 160
---

## What exists today

`client/src/components/board/RunDrawer.tsx:225` renders every verification row's
`tail` unconditionally:

```tsx
<span className={verify.ok ? '…-verify-ok' : '…-verify-bad'}>{verify.ok ? 'ok' : 'failed'}</span>
<span className="run-drawer-item-verify-tail">{verify.tail}</span>
```

`ok` decides the label's colour and nothing else. `client/src/styles.css:754` is the
tail's only rule — `color: var(--ink3)` — so there is no max-height, no scroll
container, and no clamp of any kind.

The data behind it is doing exactly what it was built to do.
`runVerifyCommand` (`skills/backlog-orchestrate/tools/orchestrate.mjs`) captures the
last 20 lines and at most 8 KiB of every command's combined output, pass or fail, and
its comment is explicit that the caps exist so `run.json` "stays a state file rather
than a log". `shared/types.ts:301` states the intent: the tail is "what a human
actually needs to tell a flaky test from a real regression without re-running
anything."

Nothing here is malfunctioning. The tool stores a tail for every row on purpose; the
drawer just never asks whether this particular row has anything worth showing.

## Why it should change

Observed on run-20260831-211011 (task-3), the first real orchestrator run — three
green rows, sixty lines of output, on a screen whose job is to tell you what needs a
look.

- **A passing row's tail has no reader.** The tail is a diagnostic, and there is
  nothing to diagnose on a command that exited `0`. Its whole stated purpose — telling
  a flake from a regression — only applies to a red row.
- **It buries the row that matters.** A three-command baseline renders sixty lines. The
  one red row, when there is one, sits sandwiched between two walls of passing output,
  which is the opposite of what the colour-coded `ok`/`failed` label is trying to do.
- **It misinforms.** `pnpm run build` ends its normal, successful output with
  `The CJS build of Vite's Node API is deprecated`. That warning now renders directly
  beneath a green `ok`, and it reads as a problem on a check that passed.
- **It pushes ATTENTION off-screen.** With no max-height, the tails set the drawer's
  height. The attention list — parked items, exhausted fix loops, unanswered questions,
  the entire reason a human opens this drawer unattended — is below them.

The cost is paid on every successful run, which is the case this board should be
quietest about.

## Rough shape

Client-only; the tool and the stored shape stay exactly as they are, since a tail on a
green row is still worth *having* (it is proof the command really ran) — just not worth
showing unprompted.

- Gate the tail on `verify.ok` in `RunDrawer.tsx`: collapsed behind a disclosure when
  the row passed, expanded by default when it failed. A `<details>` with the row's
  `cmd` as its `<summary>` is probably enough and needs no state.
- Give the tail a `max-height` and `overflow-y: auto` in `styles.css` regardless of
  which side of the gate it is on, so twenty long lines can never set the drawer's
  height again. The 8 KiB char cap already bounds the data; nothing yet bounds the box.
- Worth deciding during groom: whether a green tail collapses or is dropped from the
  render entirely. Collapsing keeps the proof-of-execution reading available; dropping
  is simpler and the same information is one `status --json` away.

`test/` has no coverage of the tail's rendering today — the new behaviour wants a case
for each side of the gate, and one asserting a failed row is not collapsed.
