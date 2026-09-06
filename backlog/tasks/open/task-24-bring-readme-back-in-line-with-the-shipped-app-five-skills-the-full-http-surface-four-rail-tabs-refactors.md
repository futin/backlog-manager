---
id: task-24
title: "Bring README back in line with the shipped app: five skills, the full HTTP surface, four rail tabs, refactors"
created: 2026-09-06
tags: docs, audit-2026-09-06
---

## Goal

The README describes an app that no longer exists. Four separate **Important** findings of
the 2026-09-06 audit are all drift in this one file, and they are filed together because
they are one editing pass — four items would be four worktrees rewriting the same file.

Docs was the audit's weakest dimension by a clear margin, and this is why.

## Plan

Four drifts, each verified at source. Fix all four in one pass over `README.md`.

**1. The fifth skill is invisible (`README.md:3`, `:123-126`).** The README says the plugin
homes "four backlog skills" and the Install section lists the same four. `grep -ci orchestr
README.md` is `0` across all 262 lines — the Architecture section even says "skills/ — the
four published skills". Meanwhile CLAUDE.md:3 documents five, `skills/backlog-orchestrate/SKILL.md`
is 1,629 lines, and the shipped code carries `server/src/orchestrator/` plus ~18 client
run/orchestrator files. The repo's largest subsystem — its own CLI, its own server module, its
own run archive, and the only code here that commits or merges — is absent from the front
door. Add it to the count, the Install list, and the Architecture line, and give it enough
prose that a reader knows what it does.

**2. The HTTP surface is documented at one third (`README.md:184-189`).** The Architecture
section lists `server/src/agents/` as exactly three routes — status, plan, dispatch — and never
mentions `server/src/orchestrator/` at all. `agents.controller.ts` declares nine
(`:33`, `:48`, `:66`, `:137` orchestrate, `:240` resume, `:292` pause, `:313` watchdog, `:413`
watchdog/config, `:453` merge-check) and `orchestrator.controller.ts:22,56,77` adds `runs`,
`archive`, `archive/run`. The section enumerates routes exhaustively for every other module and
carries no scope disclaimer, so a reader reasonably treats it as complete — and reasons about
half the surface when configuring a proxy, picking a port, or reviewing security.

**3. The side rail lost a tab (`README.md:190`).** It reads "a side rail (Board / Archive /
Settings, a plain section switch)". `client/src/components/SideRail.tsx:19-22` defines four:
`board`, `runs`, `archive`, `settings`. Everything behind Runs — run history, stage timings,
the watchdog monitor — is undocumented.

**4. The store-format table contradicts the same page (`README.md:27-32`).** The table lists
bugs, ideas, tasks, out-of-scope and omits `refactors`, while `README.md:12` fifteen lines
earlier names refactoring as one of the board's four columns and `:200`, `:210` describe
refactors. `SECTIONS` at `skills/backlog/tools/backlog.mjs:30` defines `refactors: 'ref'` and
`backlog/refactors/` exists on disk. Add the row with its `ref` prefix.

Two notes on scope. Deriving any of these counts at build time is **out of scope** — that is a
separate idea, and this item is the repair. And CLAUDE.md is the accurate document throughout;
where the two disagree, CLAUDE.md is right and the README follows it, not the reverse.

While in the file, three Minor findings from the same audit sit in the same paragraphs and are
cheap to fold in — take them if they stay one-liners, and say so in the outcome either way:
`README.md:197` claims every Settings value is "all per-device, in `localStorage`, never sent
to the server" (the Orchestrator watchdog group writes four knobs to the server);
`README.md:77` says "Everything lives in `.env`; `.env.example` documents each key", false for
two live server-read overrides; and `.claude-plugin/plugin.json:3`'s marketplace description
advertises "(capture, groom, execute, board)", so orchestrate is missing from the one string
users see before installing.

## Test cases

No unit tests — this is prose. Verify by grep, and record each result:

- `grep -ci orchestr README.md` is non-zero, and the skill count reads five in both the
  opening description and the Install section.
- Every route in `agents.controller.ts` and `orchestrator.controller.ts` appears in the
  Architecture section; cross-check by listing the controllers' decorators against the README
  text rather than by eye.
- The side rail sentence names four tabs matching `SideRail.tsx:19-22`.
- The store-format table has a `refactors` row with prefix `ref`, and no longer contradicts
  `README.md:12`.
- No claim in the README is left that CLAUDE.md contradicts in the sections touched.

## Done when

```
pnpm run typecheck
```

- All four drifts closed and each verified by the grep named above, with results in the
  outcome.
- The three Minor items are either fixed or explicitly listed as deferred.
