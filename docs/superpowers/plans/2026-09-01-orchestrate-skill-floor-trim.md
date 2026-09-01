# Trim the orchestrator's context floor

**Status:** approved 2026-09-01. Bounded change — no spec document; this plan is
the whole written record.

**Note on this plan's form:** it specifies *behaviour* and *exact test cases*,
never literal implementation code. Every size target below is **soft**. The one
failure mode this change has is compressing away a rule that encodes a failure
that already happened, and a hard byte budget is how that happens. When a target
and a rule disagree, the rule wins and the target moves.

## Why

Measured from two real orchestrator main sessions (`18a9bcbe`, `a279f098`) and
three headless `backlog-execute` sessions, all on 2026-09-01:

| Session | floor (turn 1) | end | turns | cache-read total |
|---|---|---|---|---|
| orchestrator main `18a9bcbe` | 101,267 | 236,079 | 270 | 41,192,602 |
| orchestrator main `a279f098` | 68,493 | 182,140 | 180 | 22,838,920 |
| headless execute (bug-3 / bug-4 / task-6) | 50,503 / 50,671 / 51,905 | — | — | — |

The bill is `turns × context`, so a fixed floor is paid on every turn. For
`18a9bcbe`: average context 152k, of which **101k is floor — 66% of the entire
run's token cost is re-reading the same bytes.**

Floor decomposition for that session:

| Block | tokens | × 270 turns | share |
|---|---|---|---|
| bedrock (system prompt, built-in tool schemas, CLAUDE.md, skill descriptions) | ~47.8k | 12.9M | 31% |
| **`backlog-orchestrate/SKILL.md` injection** | **~15k** | **4.0M** | **10%** |
| interactive-terminal overhead (MCP servers, hooks) | ~18k | 4.9M | 12% |
| other floor | ~20k | 5.4M | 13% |
| per-item growth | avg 51k | 13.8M | 34% |

Two numbers to keep in view. The skill body's injection is **60,168 chars**,
measured directly at line 6 of `18a9bcbe`'s transcript — **5.6× the size of
`backlog-execute`'s 10,736**. And bedrock (31%) is unreachable from this repo:
the dashboard's argv (`../claude-agents-dashboard/server/lib/spawn.ts:215`)
carries no `--tools` or `--strict-mcp-config`, so trimming it is a cross-repo
change and explicitly **out of scope here**.

## What changes

### 1. Progressive-disclosure split of `skills/backlog-orchestrate/SKILL.md`

Today the file is one 1333-line body, every byte of it resident for every turn
of every run. Most of it is load-bearing on every run. Two parts are not:

- **The recovery path** (`--resume`, `--abort`, `reconcile` and its four
  verdicts) is read by an interrupted run only. A clean run pays for it 270
  times and never reads it once.
- **Long-form rationale** — the empirical backstories that explain *why* a rule
  is what it is without changing *what you type*. Example: the bug-2 narrative
  behind the worktree-cwd refusal, the measurements behind `--verbose`, the
  history behind the reviewer's report contract.

Both move to `skills/backlog-orchestrate/references/`, read on demand:

- `references/recovery.md` — the whole of §10's `--resume` and `--abort`,
  verbatim. §10's "Finishing" subsection **stays in the body**: it is the
  common path, not the rare one.
- `references/rationale.md` — the moved backstories.

**Move, never delete.** Every rule that loses its story to a reference keeps a
one-line statement of the rule itself in the body. A reader who never opens a
reference must still be told what to do and what not to do; what they lose is
only the account of how the rule was learned.

The body's §10 gains a stub that is an instruction, not a cross-reference:
resuming or aborting a run **begins** with reading `references/recovery.md` in
full, before any other command.

Soft target: ~15k → ~8k tokens. Recovered on every turn of every run
(~2M cache-read tokens per 270-turn run, ~5% of the bill), and it compounds if
the per-item-child-session idea is built later, since each child pays the
smaller floor.

### 2. Write down which start path a run should use

Interactive-terminal sessions floor at 68.5k / 69.0k (two measured); headless
`claude -p` sessions floor at 50.5k / 50.7k / 51.9k (three measured). The
~18k gap is MCP servers and hooks that an interactive terminal connects and a
headless session does not.

The dashboard spawns `claude -p` (`spawn.ts:215`), so a board-started run is
headless by construction and a hand-typed `/backlog-orchestrate` is not. Both
runs measured here were hand-typed.

**State the projection honestly:** no board-started *orchestrate* run exists in
the transcripts yet, so the ~18k saving for that specific path is projected from
the execute-session floors, not measured. The guidance says to prefer the board
and to measure the next board-started run to confirm.

Placement: one short note in the skill's §2, and one line in `CLAUDE.md` beside
the orchestrate entry. Keep both to a few lines — this change exists to shrink
the body, and paying 500 tokens to save 18k is still the right trade, but only
at that ratio.

## What does not change

- Every command, flag, exit code and gate in §1–§9. This is a re-layout of
  prose, not a change to the loop.
- `orchestrate.mjs` — untouched. No tool behaviour changes.
- The server, the client, the run file, the registry.
- `PUBLISHED_PATHS` and the marketplace `sparsePaths` both already name
  `skills`, and `sparsePaths` is `['.claude-plugin', 'skills']` for this
  marketplace — a new `skills/backlog-orchestrate/references/` directory
  publishes with no list edit. (Confirmed by reading
  `~/.claude/plugins/known_marketplaces.json`; note it does *not* name
  `agents`, which is the pre-existing gap `CLAUDE.md` already documents and
  which this change does not touch.)

## Tests

All new cases go in `skills/backlog-orchestrate/tools/orchestrate.test.mjs`
beside the existing `SKILL_MD` assertions, and run under node's test runner via
`pnpm run test:skills`.

**Existing cases that must still pass unchanged** — they are the reason the
split is safe, and none of them may be edited to accommodate it:

- `both of SKILL.md's headless dispatch lines carry --permission-mode auto` —
  expects exactly **2** lines containing `exec claude -p` in the body. Step 4's
  dispatch and step 5's `--resume` retry both stay in the body; §10's recovery
  text *refers* to them ("step 5's retry line unchanged") but contains no
  `exec claude -p` line of its own. If the moved text would carry a third
  dispatch line into `references/`, the move is wrong — the body is where a
  launchable command belongs.
- `SKILL.md keeps merge --abort under the conflict branch only` — exactly 1
  fenced `merge --abort`, and the body still contains
  `would be overwritten by merge`.
- `step 9 probes the main tree for paths the branch also touches`.
- `step 9 documents resolving on the branch side before parking`.
- `step 8's verify launcher carries its paths in named env variables`.
- `every step that runs a headless session checks its transcript for denials
  before committing` — parses `## ` headings out of the body and requires
  sections titled exactly `5. Inspect what the session left behind` and
  `7. Review` to contain `orchestrate.mjs" denials --jsonl`. Section titles must
  survive the split byte-for-byte.
- The two whole-tree sweeps (`--dangerously-skip-permissions`, positional
  parameters in fenced blocks) walk `skills/` recursively, so they will now scan
  `references/` too. Both must stay green — which means the moved prose may
  *name* those things but no fenced block in a reference may use them.

**New cases:**

1. **`the body's recovery stub points at references/recovery.md`** — the body
   contains the literal string `references/recovery.md`, and that file exists on
   disk. Guards the failure where the section is moved and the pointer is not,
   leaving an unattended run with no instruction at the one moment it is
   already in trouble.

2. **`references/recovery.md keeps all four reconcile verdicts`** — the file
   contains `resume-session`, `redispatch-after-stop`, `inspect` and `park`.
   Reconcile prints one of exactly four, and a recovery doc missing one strands
   a run on the case it dropped.

3. **`the resume path still bills the session rather than abandoning it`** —
   `references/recovery.md` states that a plain `stop` is used and `--abandon`
   is not. This is the ruling that deliberately contradicts `backlog-groom`'s
   opposite rule for an identical-looking marker; it is exactly the kind of
   surprising rule a re-layout loses.

4. **`the body keeps the rules whose stories moved out`** — the body still
   contains each of: `git revert -m 1`, `--no-ff`, `reset --hard` (as the thing
   never to do), and the subshell form `( cd ` for the worktree-scoped
   `backlog.mjs` calls. One assertion per string with a message naming the rule,
   so a failure says which rule was lost rather than "string not found".

5. **`references/ files are reachable from the body`** — every file in
   `skills/backlog-orchestrate/references/` is named at least once in
   `SKILL.md`. An unreferenced reference is a file no session will ever read.

No size-budget test. Report the before/after byte count in the completion note
instead — a byte assertion is precisely the mechanism that would later delete a
rule to stay green.

## Verification

1. `pnpm run test:skills` green, including the five new cases.
2. `pnpm test` green (`test/orchestrator-start.test.ts` and
   `test/agents-prompt.test.ts` mention SKILL.md only in comments, but the suite
   runs regardless).
3. Report measured before/after size of the body in bytes and estimated tokens.
4. **Deferred to the next run, not claimed now:** the floor of the next
   orchestrator session, read from its transcript's first assistant turn.
   Target ≤ 80k for a hand-typed run; ≤ 65k for a board-started one. This change
   is not "verified working" until that number exists — say so rather than
   implying the projection is a result.

## Publishing

Editing `skills/` changes nothing until it is committed, pushed, and
`pnpm run plugin:sync` runs — the installer reads the pushed HEAD, never the
working tree. Ask before committing or pushing; do not sync as part of
implementation.
