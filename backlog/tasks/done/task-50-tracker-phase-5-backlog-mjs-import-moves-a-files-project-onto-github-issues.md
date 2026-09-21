---
id: task-50
title: Tracker phase 5: backlog.mjs import moves a files project onto GitHub issues
created: 2026-09-21
from: idea-12
tags: tracker, github, migration, backlog-cli
updated: 2026-09-21T17:15:53Z
started: 2026-09-21T16:07:39Z
execute-elapsed: 4094
execute-tokens: 457778
---

## Goal

Phase 5 of the tracker-backed direction ([spec §8, revised 2026-09-21](../../../docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md)), the
spec's §13 visible result "the first project leaves files". `backlog.mjs import github [owner/repo] [--no-forms]` moves a files project's whole `backlog/`
store onto GitHub issues through the local API, one shot per project, resumably, and deletes the item files only once every issue exists and every
cross-link has been rewritten. The first real migration is guide-manager (18 items, one body over GitHub's 65,536-character cap, one item with counters),
run by hand after this merges and the plugin is synced — it is NOT part of this item.

Phases 1–4 are merged (task-43, task-45, task-46, task-47, task-48). The server changes not at all in this phase: every request `import` makes is one of the
seven existing write routes or an existing read, which is why the marker is written FIRST (the write routes refuse a `files` project) and the files are
deleted LAST.

## Plan

Groomed 2026-09-21 with the user present; every decision below is the user's ruling, recorded in spec §14 decisions 12–14. The implementation plan is
[docs/superpowers/plans/2026-09-21-tracker-phase5-import.md](../../../docs/superpowers/plans/2026-09-21-tracker-phase5-import.md): six tasks, each with its
test cases named exactly. **It gives behaviour and test cases, never literal code** — where the plan and your reading of the code disagree, the code wins,
and you record the disagreement in `## Outcome`. Read the plan's Global Constraints first; then spec §8.

Shape, in one screen:

1. **`skills/backlog/tools/import-lib.mjs`** (new, pure, imports nothing from `backlog.mjs`): `splitOutcome`, `renderImportFooter` / `parseImportFooter`,
   `blobLink`, `fitBody` (whole `##` segments from the top, then a `_Truncated. Full text: <SHA-pinned blob link>_` line; footer appended after it so it
   always survives), `rewriteOldIds` (`(?<![\w/-])(bug|task|idea|ref)-(\d+)(?![\w-])`, so paths and filenames stay), `importOrder`, `countersOf`,
   `IMPORT_BODY_CAP = 65000`. Tests in `import-lib.test.mjs` beside it — the `tools/` level, because the node runner's glob never reaches `tools/lib/`.
   NOT added to `backlog.test.mjs`'s `CLI_SOURCES`: it is a library, not an entry point.
2. **`import` command in `backlog.mjs`**, dispatched beside `connect`, files mode only. Nine refusals in order, nothing written by any of them: usage;
   no git; linked worktree; marker (`bad` / explicit `files` / `github` with no item files); no item files (use `connect`); repo from positional or origin;
   `backlog/` clean AND every item file tracked AND HEAD on some `origin/*` ref (the truncation link pins HEAD); every file parses and no OPEN item has
   `started:`; probe `GET /api/items` (exit `5`). Then marker + forms (unless `--no-forms`) + `registerBestEffort`.
3. **Pass 1**, open by `created` → done → out-of-scope: split `## Outcome` (done items only), fit cap, `POST create` (never `from`), then for items with any
   non-zero counter `POST claim` (`phase: execute`, `session: import-<stamp>`) + `POST release` (`reason: 'imported'`, counters) BEFORE `POST state done`
   (`claim` refuses a closed issue). `state done` is the ONLY `state` call: the server comments the Outcome and closes `completed`; an out-of-scope
   item is already closed `not_planned` by `create`. No `create` body carries `labels` — the label set is the closed eight, so `tags:` live in the
   footer only, and a refactor `kind:` other than `chore`/`debt` is refused in the preconditions. Any non-2xx is ONE stderr line
   `import stopped at <old id>: <error>`, a 429 appending ` — retry after <resetAt>`, then stop: no retry, no skip, no partial delete. Paced
   `BM_IMPORT_PACE_MS` (default 1000; tests set 0).
4. **Pass 2**: read every imported body back, `rewriteOldIds` with the map, `from:` → `_From #<n>._` (unmapped → `_From <id>._`), `POST body` with
   `ifUpdatedAt` from `GET /api/items` and no `runnerFix`, only when the body changed.
5. **Delete** item files (never `README.md`, never the marker) only after every pass-2 request answered 2xx; print `<old> → #<n>` lines and the
   `commit these files` list. Never commits.
6. **Resume**: marker `github` + item files → rebuild the map from `<!-- bm:imported from=<id> … -->` footers, skip those in pass 1, re-run `state done`
   for a footer-matched `done/` file whose issue is still open, pass 2 over everything.
7. **Prose**: SKILL.md `import` block (and `connect`'s "later phase" sentence), `docs/subsystems/skills.md`, README, one CLAUDE.md invariant bullet +
   `invariants.md` section, reword `connect`'s "not built yet" refusal to name `import`.

Not runner-fix: nothing under `skills/backlog-orchestrate/` changes.

## Test cases

Spec §12.4, expanded in the plan task by task. Node runner only (`pnpm run test:skills`), then `pnpm test` for the union.

- `import-lib.test.mjs`: 25 table cases — outcome split (first section, last section, absent, empty, `### Outcome` ignored); footer render/parse (tags
  present/absent, marker not readable line, footer at end of a body citing other ids); cap fit (exact cap unchanged, three 400-char sections at cap 900
  keep two, preamble alone over cap → trailer only, 70,000 chars under `IMPORT_BODY_CAP`); id rewrite (punctuation kept, `sub-task-1` / `idea-12-tracker…`
  / `backlog/tasks/open/task-1-foo.md` untouched, unknown id untouched, case-sensitive, inside a fence rewritten); order (status rank beats `created`,
  bugs before tasks on ties, numeric ids); counters (all-zero → `null`, absent keys `0`, non-integer throws naming the key).
- Refusals (`backlog.test.mjs`, each asserting no marker, files byte-identical, no request): usage, wrong tracker, linked worktree, explicit `files`
  marker, `github` marker with no files, no marker with no files, no origin, dirty `backlog/`, gitignored-untracked item, HEAD not on `origin/*` (names
  sha7), open item with `started:` (a done item's is ignored), `kind: cleanup` on a refactor (names id and value), malformed file, port 1 → exit `5`.
- Pass 1: probe first then `create`; order of `create` titles; request shapes (`runnerFix` only when set, no `from`, no `kind` when absent,
  `section: 'out-of-scope'`, exact footer); Outcome reaches `state.outcome` and not the body; sequence `create, claim, release, state` for the one item
  with counters and no `claim` for any other; cap case with the fixture's real sha and footer after trailer; stdout map lines; a 502 on the second
  `create` → `import stopped at bug-2`, marker present, files intact, no further request; a 429 `{error, resetAt}` on the first `create` → stderr
  `import stopped at task-1: <error> — retry after <resetAt>`, nothing deleted, no further request; exactly one `state` request in the run and none
  for the out-of-scope or open issues; `'labels' in body === false` for every `create`; source guard for `BM_IMPORT_PACE_MS` default `1000`.
- Pass 2: `bug-2` → `#5` in a body, fence rewritten, `ifUpdatedAt` equals the row's `updated`, `'runnerFix' in body === false`; `_From #4._` and
  `_From idea-9._`; no `POST body` when nothing changes; footer survives; deletion + `commitList(stdout)` exact list; a 409 → exit `1`, nothing deleted,
  stderr names the OLD id; no create/state/claim/release after pass 1.
- Resume: two footer-matched issues skipped (`resuming: 2 of 4`), the open done-item gets exactly one `state` and no `claim`; pass 2 rewrites into a
  pre-existing issue; marker byte-identical; `--no-forms` honoured; positional repo disagreeing with the marker refused; deletion still last.
- Prose pins: SKILL.md fence contains `import github [owner/repo] [--no-forms]`, no `later phase's job`; `backlog.mjs` has no `not built yet`; CLAUDE.md
  bullet contains `marker first` and `bm:imported`.

## Done when

- `pnpm test` green (both runners), the new suite counted by `test:skills`.
- `backlog.mjs import github` on a fixture files project produces, in order: marker + forms, one issue per item with footer and truncation line, a
  released synthetic claim only for items with counters, closes with Outcome as the comment, rewritten cross-links, deleted item files, a printed commit
  list — and never a commit.
- Every §8.1 refusal leaves the project byte-identical; any mid-run failure leaves files and marker in place; a re-run resumes from footers.
- `connect` names `import` instead of "not built yet"; SKILL.md, skills.md, README, CLAUDE.md and invariants.md carry the phase.
- `## Outcome` records every deviation from the plan and the id map format guide-manager's by-hand import will print.

## Outcome

2026-09-21. `backlog.mjs import github [owner/repo] [--no-forms]` is built, tested and documented, in the six tasks the plan names. The command writes
`backlog/source.json` and the issue forms first, creates one issue per item (open by `created`, then done, then out-of-scope, paced by `BM_IMPORT_PACE_MS`,
default 1000 ms), bills the four counters onto one synthetic `claim` + `release` before closing a done item, rewrites every cross-link in a second pass, and only
then deletes the item files and prints the list to commit. A re-run resumes from the `bm:imported` footers.

What landed, commit by commit: `b90cb00` (an unrelated fixture fix, below), `e6333c9` `import-lib.mjs` and its 25 table cases, `2290b75` the usage text and the
§8.1 refusals, `6f7d6d9` pass 1, then pass 2 plus the deletion, `96effab` the resume branch, `ab715ed` the prose. 63 new cases in
`skills/backlog/tools/backlog.test.mjs` and `import-lib.test.mjs` between them.

### Verification

`pnpm test`, run fresh at the end:

```
Test Suites: 1 failed, 128 passed, 129 total
Tests:       2 failed, 2117 passed, 2119 total
Snapshots:   0 total
Time:        87.14 s
ℹ tests 756
ℹ pass 756
ℹ fail 0
FAIL  jest
PASS  node --test (skills)
pnpm test: FAILED in jest.
```

**The node runner — every test this item added or touched — is 756/756 green.** The two jest failures are `test/supertest-bind.test.ts`'s two
platform-behaviour cases (`lets a wildcard listen(port) succeed on a port 127.0.0.1 already holds`, `routes the IPv4 dial to the squatter, not to the wildcard
listener`), both failing with `listen EADDRINUSE: address already in use :::<port>`. They are **pre-existing and environmental**, proved rather than asserted: a
worktree checked out at `b90cb00~1` — the commit before any of this item's work — fails the same two cases and passes the other six. This item changed no file
jest reads: `git diff --stat b90cb00~1..HEAD -- test/ server/ client/ shared/` is empty. This WSL2 kernel refuses a wildcard bind over a port `127.0.0.1`
already holds, which is the opposite of the platform hazard those two cases document; the three guards that enforce the convention (`listenLoopback` everywhere,
no bare `listen(0)`) all pass. Worth its own bug, filed by whoever picks it up — this session does not file items.

So the "Done when" bar of "`pnpm test` green (both runners)" is met for the node runner and for 2117 of 2119 jest tests, and the two that fail are refused by
the kernel this machine runs, not by this work. Recorded rather than smoothed over.

Contract sweep: 6 sites updated (`skills/backlog/SKILL.md`, `skills/backlog/tools/backlog.mjs`, `docs/subsystems/skills.md`, `README.md`, `CLAUDE.md`,
`docs/subsystems/invariants.md`)
Red proof: 6 tests went red with the change reverted

The sweep's full list: the old `connect` refusal sentence (`which is not built yet`) and its comment; SKILL.md's `(importing those is a later phase's job)`;
every doc that described the CLI's verbs without `import` (skills.md's CLI paragraph and verb table, README's tracker paragraph); and CLAUDE.md plus
invariants.md, which had no statement of the write order at all. Two sites were left standing on purpose: `backlog.mjs`'s two remaining `phase 5` comments name
the phase rather than claiming it is unbuilt, and `docs/subsystems/board.md`'s Trackers-card sentence describes a card this item did not change.

The red proof was two reverts in this session. Cutting the resume skip block out of `backlog.mjs` turned exactly the three resume cases red (`import resumes
from the bm:imported footers…`, `import repairs a done item whose close failed…`, `import's second pass patches issues an earlier run created`) and the file was
restored from a copy, never `git stash`. The three prose pins were written before the prose and failed on all three before the edits landed. Tasks 1–4 were each
written test-first in the same way, their reds observed before the implementation step that cleared them.

### The id map format guide-manager's by-hand import will print

One line per item as it goes, then the count, then the paths to commit:

```
task-1 → #4 (truncated)
bug-2 → #5
task-3 → #6
oos-5 → #7
imported 18 item(s) into github futin/guide-manager

commit these files — the marker does nothing until the machine running the board has pulled it:
backlog/source.json
.github/ISSUE_TEMPLATE/bug.yml
…
backlog/tasks/open/task-1-one.md
…
```

` (truncated)` appears only on an item whose body was cut at the cap. A resumed run prints `resuming: <k> of <total> item(s) already imported` as its first line
and `<id> → #<n> (already imported)` for each item it skipped. A failure prints one stderr line, `import stopped at <old id>: <error>`, with
` — retry after <resetAt>` appended on a 429 — the OLD id, because the operator's copy of the store is still files at that point.

### Deviations from the plan

- **`gitImportState` uses `git ls-files -- backlog` and set subtraction, not `git ls-files --error-unmatch` per file.** Same fact — which item files git does
  not track — in one child process and with an exact list, rather than scraping stderr from one process per file.
- **An item's id comes from its FILENAME** (`^([a-z]+-\d+)-`), falling back to the frontmatter and then the relative path. That is how `locateItem` already
  resolves an id, so an id the rest of the CLI would answer to is the id the import maps.
- **`rewriteOldIds`'s prefix alternation is `bug|task|idea|ref`, per spec §8.4, so an `oos-<n>` cross-link is never rewritten.** Spec-conformant and left as
  written; worth knowing before somebody reports it as a miss.
- **One unrelated red was fixed to get a clean baseline** (`b90cb00`, committed on its own): `orchestrate.test.mjs`'s submodule fixture ran a bare `git init`,
  which leaves a repository on `master` on this machine, and `init` then refused with `--base must be an existing local branch`. The fixture now pins
  `git init -q -b main`.
- **The resume's one repair deliberately does not re-bill counters**, which the plan specifies and the invariants section now explains: a second `claim` +
  `release` would double a permanent record of somebody's work.
