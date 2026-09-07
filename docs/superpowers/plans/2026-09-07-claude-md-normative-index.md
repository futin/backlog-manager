# CLAUDE.md → normative index: disposition plan

Date: 2026-09-07. Bounded docs change; no code, no tests, no skill prose touched.

## Why

`CLAUDE.md` is 1098 lines / 77 KB / ~11.7k words (≈16k tokens), auto-loaded into every
interactive session and every turn of every headless `backlog-execute` / reviewer session
this repo's orchestrator spawns. 990 of those lines are the **Invariants** section.
`docs/overview.md` already declares CLAUDE.md's register as "the normative index: one line
per rule" and names `docs/subsystems/invariants.md` as the home of the reasoning — but only
3 of 56 invariant bullets point there, ~30 carry 15–54 lines of rationale that the long-form
section already holds, and ~10 long bullets have **no** long-form section anywhere, so they
cannot be cut, only moved.

Claude Code's own docs: target CLAUDE.md under 200 lines, "longer files consume more context
and reduce adherence"; `@imports` are eager (no saving); `.claude/rules/*.md` with `paths:`
loads only when a matching file is read, but that is undocumented for subagents and
`claude -p` — exactly this repo's headless consumers — so it is a follow-up spike, not part
of this change.

## The rule for every bullet

Stays in CLAUDE.md — the **normative** content:
- the bold lead (the rule itself);
- every prohibition ("never", "do not", "deliberately not", "must");
- the name of the single implementation (file / function / endpoint) the rule pins;
- contract numbers: exit codes, HTTP codes, defaults, the one freshness constant.

Moves to `docs/subsystems/invariants.md` — the **why**:
- failure history (bug/task numbers, dates, measurements, "this happened on 2026-09-06");
- rejected alternatives and why they were rejected;
- mechanism narrative (how the pieces fit), analogies to sibling rules;
- the "a later reader must not re-decide" explanations (the imperative stays, the reason moves).

Each trimmed bullet ends in `Long form: [invariants.md#<anchor>](docs/subsystems/invariants.md#<anchor>)`
— anchored, because the docs-sync checker slugifies GitHub-style and verifies anchors
against headings, so a renamed heading fails the check instead of silently orphaning the link.

## No fact lost, checked two ways

Measured before moving: 0 of 276 CLAUDE.md sentences appear verbatim in invariants.md —
the long-form sections paraphrase, and some facts existed in CLAUDE.md alone. So the move
is semantic where a section exists and verbatim where none does (approved 2026-09-07):

- The nine bullets with no section are moved **verbatim** into new sections (paragraph
  breaks added, bold lead unbolded; one relative reference adjusted and recorded).
- For the ~30 bullets with an existing section, the sentences whose facts the section
  lacks are woven in verbatim; the rest are recorded in a ledger, keyed
  `bullet.sentence`, naming the section that states it (151 entries; the audit that
  ranked each sentence's long-word overlap with its section found no gap).

Two mechanical guards, run by a throwaway scratchpad script that is not committed:

1. **Token survival** — every backtick identifier, number, quoted string and bug/task id
   in every old sentence must still appear in new CLAUDE.md ∪ new invariants.md.
2. **Verbatim or ledgered** — every old sentence is either present verbatim in one of the
   two files or has a ledger entry naming where its content lives.

## Untouched, on purpose

- `## Commands`, `## Layout`, `## Conventions` — already the index register.
- `agents/backlog-reviewer.md` — already says "follow it into `docs/subsystems/invariants.md`
  when an entry points there"; after this every entry points there, same behaviour in kind.
- `skills/**` — publish boundary; `backlog-execute`'s contract sweep already covers `docs/`.
- `skills/backlog-orchestrate/references/rationale.md:318` cites `CLAUDE.md:227` — a record of a
  past sweep, left as history.
- docs-sync baselines on both docs stay at `bb20a03`: no source commit has landed since, no
  surviving sentence changes meaning, moved sentences carry the verification they already had
  (the same judgement 07169eb stated). Checker status must read identical before and after.

## Disposition table

`now` = lines in CLAUDE.md today; `after` = target; `target` = invariants.md section
(existing heading, or NEW).

| # | bullet | now | after | target |
|---|---|---|---|---|
| 1 | `skills/` is the plugin skill root | 2 | 2 | keep |
| 2 | `registry.json` has exactly one writer (bug-17, `linkedWorktreeInfo`) | 27 | 4 | NEW `## registry.json has exactly one writer, and a linked worktree registers its main tree` |
| 3 | run file: one writer, one reader | 20 | 3 | existing |
| 4 | sidecars archived beside the run file | 45 | 4 | existing `### A run's sidecars…` |
| 5 | board-started run visible before its run file (`StartingRunsService`) | 54 | 4 | NEW `## A board-started run is visible before its run file exists` |
| 6 | a starting entry blocks what a run file blocks (bug-21) | 30 | 3 | NEW `### …blocks what a run file blocks` (under 5) |
| 7 | Escape has one owner (bug-23) | 19 | 2 | NEW `## Escape has one owner` |
| 8 | item files read-only to server/client | 3 | 3 | keep |
| 9 | every route under `/api` | 2 | 2 | keep |
| 10 | item bodies via registry allowlist | 2 | 2 | keep |
| 11 | Groomed is derived | 4 | 4 | keep |
| 12 | Board-versus-Archive is derived (`isStale`/`leavesBoard`/`lastTouched`) | 32 | 4 | NEW `## Board-versus-Archive is derived, and "last touched" has three rungs` |
| 13 | middle rung comes from git (`lastCommit`) | 21 | 3 | NEW `### The middle rung comes from git` (under 12) |
| 14 | Orchestrate sheet `uncommitted` flag | 51 | 4 | existing (5 subsections) |
| 15 | `refactors/` is a peer section | 10 | 4 | NEW `## refactors/ is a peer section, not a facet on ideas` |
| 16 | `started:` / `phase:` lifecycle keys | 39 | 4 | existing |
| 17 | only `backlog-orchestrate` commits or merges | 8 | 3 | existing |
| 18 | merge mode is run-scoped | 18 | 3 | existing |
| 19 | `merged` not the only success exit | 16 | 3 | existing |
| 20 | tool refuses `stage <id> merged` under branch mode | 7 | 2 | existing (branched section) |
| 21 | question mode is run-scoped (task-19) | 36 | 4 | NEW `## Question mode is run-scoped, and only a headless run feels it` |
| 22 | classifier denial degrades to branch mode | 15 | 3 | existing |
| 23 | undo a merge with `git revert -m 1` | 11 | 2 | existing |
| 24 | `orchestrate.mjs` from project root, never a worktree | 14 | 3 | existing |
| 25 | `runner-fix:` hoisted | 32 | 3 | existing |
| 26 | editing `skills/` needs commit + push + sync | 5 | 2 | existing |
| 27 | `agents/` is part of the publish surface | 17 | 3 | existing |
| 28 | both processes bind `127.0.0.1` | 13 | 3 | existing |
| 29 | served build carries a CSP | 3 | 2 | existing |
| 30 | container mounts read-only on host paths | 2 | 2 | keep |
| 31 | pnpm only | 2 | 2 | keep |
| 32 | `pnpm test` is the union of both runners (task-22) | 26 | 3 | NEW `## pnpm test is the union of both runners` |
| 33 | `allowBuilds` lists esbuild | 2 | 2 | keep |
| 34 | `vite.config.ts` needs a client restart | 1 | 1 | keep |
| 35 | items move `open/` → `done/` | 1 | 1 | keep |
| 36 | dispatch derives the action | 17 | 4 | existing |
| 37 | orchestrate spawn prompt composed server-side | 30 | 4 | existing |
| 38 | browser never talks to the dashboard (bug-25) | 11 | 3 | existing |
| 39 | invisible project cannot be dispatched to | 3 | 2 | existing |
| 40 | environment block hides, per-item blocks disable (+ reverify, bug-13/16) | 47 | 4 | existing (+ toolbar subsection) |
| 41 | one run per project, checked twice | 22 | 3 | existing |
| 42 | pause request file, `paused` status, exit 6 | 30 | 4 | existing |
| 43 | resume serialized at three layers, exit 7 | 49 | 4 | existing |
| 44 | sweeper's prune keeps `paused` | 12 | 2 | existing (resume section) |
| 45 | watchdog spawns, never writes the run file | 11 | 2 | existing |
| 46 | crashed run renders as crashed (bug-29, `runStatusChip`) | 30 | 3 | NEW `### A crashed run renders as crashed, never as nothing` (under watchdog) |
| 47 | watchdog armed only while a run says `running` | 26 | 3 | existing `### Armed, idle, off` |
| 48 | `useOrchestratorRuns` polls while any run is `running` | 5 | 2 | existing |
| 49 | any spawn attempt starts grace; only success counts | 20 | 3 | existing `### Grace…` |
| 50 | hand resume offered exactly when watchdog stood down; `exhausted` derived | 29 | 3 | existing (two subsections) |
| 51 | every agents POST origin-guarded | 9 | 2 | existing |
| 52 | launch sheet pickers seed from Settings | 5 | 2 | existing |
| 53 | `linkBase` becomes an href | 3 | 2 | existing |
| 54 | queue wait is not work | 9 | 2 | existing |
| 55 | session cost per transcript, identity is the file name (task-27) | 26 | 3 | NEW `## A session's cost is recorded per transcript` |

Estimated: Invariants 990 → ~160 lines; CLAUDE.md ~1098 → ~270 lines. **Actual (commits
df008f8 and the cut that follows it):** Invariants 990 → 374 lines; CLAUDE.md 1098 → 482
lines, 77 KB → 33 KB; invariants.md 2079 → 2560 lines, nine new sections. The gap to the
estimate is the decision to keep every prohibition and one anchored link line per entry
rather than cut closer to the bone — the right side to err on for a file whose readers are
unattended sessions. The docs' <200-line target is not reachable without cutting
Layout/Conventions too, which is not proposed.

## Steps and verification

1. Checker before: `node ~/.claude/skills/docs-sync/tools/provenance.mjs --repo .` — record status.
2. **Commit 1 — move.** For each bullet: sentence-diff against its target section; append the
   sentences the section lacks, or create the NEW section. CLAUDE.md untouched. Checker: same
   status, 0 dead links/anchors.
3. **Commit 2 — cut.** Rewrite each bullet per the rule above, add the anchored `Long form:`
   link. Run both guards: token survival 0 lost, verbatim-or-ledgered 0 missing. Checker: same status, every
   new anchor resolves. `wc -l CLAUDE.md` ≈ 270.
4. No `pnpm test` — nothing under `test/`, `skills/`, `server/`, `client/`, `shared/` changes.

## Follow-up (not this change)

Spike: thin `.claude/rules/<area>.md` pointer files with `paths:` ("editing
`server/src/agents/**`? read invariants.md §…") — tool-triggered at the moment of relevance,
one copy of the prose kept. Before relying on it, probe whether a `claude -p` session and a
custom agent actually receive path-scoped rules; the docs do not say.
