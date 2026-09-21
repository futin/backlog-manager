---
id: task-50
title: Tracker phase 5: backlog.mjs import moves a files project onto GitHub issues
created: 2026-09-21
from: idea-12
tags: tracker, github, migration, backlog-cli
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
