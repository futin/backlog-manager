---
id: task-24
title: "Bring README back in line with the shipped app: five skills, the full HTTP surface, four rail tabs, refactors"
created: 2026-09-06
tags: docs, audit-2026-09-06
updated: 2026-09-07T03:40:19Z
started: 2026-09-07T03:26:52Z
execute-elapsed: 807
execute-tokens: 78664
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

## Outcome

2026-09-07 — all four drifts closed in one pass over `README.md`, plus all three
Minor items. `.claude-plugin/plugin.json` was the only file touched outside the
README.

**1. The fifth skill.** Opening paragraph now reads "five backlog skills" and
names `/backlog-orchestrate`; a new paragraph after the columns sentence says
what it does (per-item worktree, headless `/backlog-execute`, commit → review →
verify → merge, branch mode leaving `main` untouched, `run.json` outside the
repo). The Install section lists all five plus the `backlog-reviewer` agent, and
the Architecture `skills/` bullet reads "the five published skills" and names
both single-writer CLIs. An `agents/` bullet and an `agents/` row in the repo
layout table were added beside it, since the reviewer only exists post-install
because `PUBLISHED_PATHS` names that directory.

**2. The HTTP surface.** The `server/src/agents/` bullet now enumerates all nine
of its routes and a new `server/src/orchestrator/` bullet the three read-only
run-state ones. Cross-checked mechanically rather than by eye: a script parses
every `@Controller`/`@Get`/`@Post` decorator under `server/src` and asserts each
resulting `VERB /api/...` string appears in the Architecture section with
whitespace collapsed —

```
routes declared: 16  missing from README Architecture: 0 []
```

The ASCII diagram gained the orchestrator half (`backlog-orchestrate` →
`orchestrate.mjs` → `~/.backlog-manager/orchestrator/`, with the server's edge
to it marked read-only).

**3. The side rail.** Now "Board / Runs / Archive / Settings", matching
`SideRail.tsx`'s four `TABS` ids (`board`, `runs`, `archive`, `settings`, read
back out of the file to confirm), and Runs is described: stat tiles, the range
control, the day-grouped history, the stage-track detail pane, and Watchdog
mode. Board's bullet also gained the Orchestrate control and the run strip,
which were undocumented for the same reason.

**4. The store-format table.** `| refactors | ref | open -> done |` added
between tasks and out-of-scope, matching `SECTIONS` in `backlog.mjs:30`, so the
table no longer contradicts `README.md:13`'s four columns. A closing sentence
was added saying ideas and refactors are the two sections nothing executes —
each waits to be promoted into a task.

**The three Minor items: all three fixed, none deferred.**

- The Settings claim is now scoped: the per-device list ends "never sent to the
  server", then names the Orchestrator watchdog group as "the one place Settings
  does write to the server: four knobs that live in `settings/watchdog.json`".
- `Everything lives in .env` reworded to except the last two rows, and
  `BM_ORCH_HOME` and `BM_ORCH_CONTROL_HOME` added to the Configuration table
  with "Not in `.env.example`" stated on each. Those two are the whole gap:
  `grep -rhoE 'BM_[A-Z_]+' server/src` returns nine keys, and those are the two
  `.env.example` does not carry.
- `.claude-plugin/plugin.json:3` now advertises "(capture, groom, execute,
  orchestrate, board)". `.claude-plugin/marketplace.json` was left alone — its
  description carries no skill list to be missing from.

Three claims outside the four drifts but inside the paragraphs they live in were
corrected, because CLAUDE.md contradicted them: the staleness prose named two
rungs of the three-rung `updated ?? lastCommit ?? created` precedence and no
longer does (and now states that an in-progress item and one a live run holds
both outrank the arithmetic); "the board writes nothing" became "writes no item
file" in two places, since the board does write watchdog config and a pause
request; and the `shared/agent.ts` bullet no longer reads as an exhaustive list
of two functions. Deriving any of these counts at build time stayed out of
scope, as the plan directed.

Verification. `pnpm run typecheck` is the item's own gate and is clean; the full
suite was run because a docs change still has to leave both runners green:

```
$ pnpm run typecheck
$ tsc --noEmit

$ pnpm test
Test Suites: 80 passed, 80 total
Tests:       1516 passed, 1516 total
Time:        53.237 s
# tests 415
# pass 415
# fail 0
────────────────────────────────────────────────────────────
PASS  jest
PASS  node --test (skills)

pnpm test: both runners passed.

$ pnpm run build
✓ built in 1.45s

$ grep -ci orchestr README.md
27
```
