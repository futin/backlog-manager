# Review 2 — `docs/superpowers/specs/2026-10-16-release-versioning-design.md`

Reviewer: fresh subagent (Fable 5.1), 2026-10-16. Inputs: the spec, the parent spec and `docs/subsystems/releases.md` in `claude-agents-dashboard`,
release-kit `v1.1.0`'s `dist/` as installed in the dashboard's `node_modules`, this repo's code, rules files and tests, the GitHub repo settings
(`gh api repos/futin/backlog-manager`, read-only) and release-kit's remote tags. Review 1's seven Important findings were checked as resolved first.

## Verdict: APPROVE WITH FIXES

One contradiction between §API and §UI that a literal build turns into wrong route behaviour, two Important gaps (an incomplete list of homes for a
count a test pins, and an unstated memo rule for a failed read), and Minors. Nothing touches the rollout order or the decisions table.

## What checked out

- Starting state (L16–27): `ci.yml:21` calls `ci-node.yml@v1`; no rulesets (`gh api …/rulesets` → 0); merge, squash and rebase all enabled, squash title
  `COMMIT_OR_PR_TITLE`; no PR template; the only tag is the lightweight `backup/tracker-pre-rebase`; `package.json` 0.1.0, `plugin.json` 0.1.1; release-kit
  `v1` → the commit `v1.1.0` peels to; the root export is exactly `checkTitle, extractWhatsNew, formatTagMessage, isBreaking, nextVersion, parseTagMessage,
  parseVersion, readReleases, writeReleasesJson, runRelease` (`dist/cjs/index.js`). The first-parent count is 81 today (5 PR / 18 `Merge backlog/` / 58 other),
  two commits after the measurement, so 79 holds for the measured moment.
- R4 (L36): `dist/cjs/git.js:18` runs `execFile('git', …)` with `maxBuffer` only — no `timeout`.
- Parity details (L88–92): `--sort=-creatordate` with the JS re-sort by date desc then version desc (`git.js:33–47`); `describe --long` + `DESCRIBE_FILTER`
  byte-equal to L90 (`git.js:13`); `LONG_DESCRIBE` (`read-releases.js:11`); `DESCRIBE_FILTER`/`VERSION_TAG`/`GITHUB` are not in `index.d.ts` and the
  package's `exports` has only `"."`, so they cannot be deep-imported either.
- `readReleases` computes `current` only when `releases` is non-empty (`read-releases.js:46`) — consistent with L95's "no `v*` tags → empty shape".
- PR template quotes (L66–67) are all present in the dashboard's template (`.github/pull_request_template.md:3,6,56,85`); `extractWhatsNew` finds the heading
  by `l.trimEnd() === "## What's new"` after stripping comments (`conventional.js:64–65`).
- `prTitle` ranks `['feat','fix','perf','chore']` and floors at `chore(backlog)` (`orchestrate.mjs:6357–6386`); `prBody` opens with `## What's new`
  (`:6404`); a bug's §6 subject is `fix:` (`SKILL.md:769`). A `merge`-mode run on a tracker project pushes `<base>` after every merge (`SKILL.md:1249–1250`),
  so L48's "park at the push" is right.
- Test seam and memo (L86–87, L98–100): `BM_REGISTRY_FILE`/`BM_ORCH_HOME` are read inside functions, per call (`registry.service.ts:11`,
  `orchestrator.service.ts:24`); the dashboard's key is `rev-parse HEAD --git-common-dir` + two mtimes and a `null` key is read but not memoised
  (`server/lib/releases.ts:47–72`).
- Dependency (L101–102): `tsconfig.json` has `moduleResolution: "node"`; `dist/cjs/package.json` is `{"type":"commonjs"}` under a `require` condition; the
  `lookout-widgets.d.ts` shim pattern applies as written. release-kit is `"private": true`, which blocks publishing only — the dashboard already installs
  it from the same `github:` spec.
- Compose (L85): `.:/app` on the api service in `docker-compose.yml:156`, and `docker:run` overlays `docker-compose.run.yml` on it; `safe.directory '*'` at
  `Dockerfile:44`; the host's `~/Documents/custom-projects` is mounted at the same path, so even a linked worktree's `.git` file resolves in-container.
- UI facts: `backlog-manager.<kebab>` is the repo's `localStorage` key convention (`BoardView.tsx:39–44`, `runs-mode.ts:37`); the narrow breakpoint is
  700 px (`useNarrow.ts:22`); `lib/markdown.ts` exports `renderMarkdown`; `ui/Modal.tsx:49` and `ui/FormSheet.tsx:58` are the two shells calling the hook;
  `.claude/DESIGN.md` ends at §8.9, so §8.10 is free; `docs/subsystems/api.md` has a `## Modules` heading; `test/daylight-contrast.test.ts:66–76` discovers
  tint sites from `styles.css` itself, so badge tints written as `color-mix(in srgb, var(--X) N%, <surface>)` with a `color:` in the same rule are covered
  without a list edit (and any other form throws there, so it cannot slip past).
- Hard rules: `/api/releases` is under `/api`; the Host gate is global (`security.ts:4`); the route is read-only and spawns git through `runGit` only; the
  widened `paths:` keeps `test/claude-rules.test.ts`'s "every glob matches a tracked file" green once the module exists in the same PR; PR titles given
  (`ci(release): …`, `feat(releases): …`, `docs: …`) pass `ci / pr-title`.
- Rollout arithmetic: a `feat` PR at major 0 bumps the minor (parent spec L128), so step 3's run gives `v0.2.0` and PR C the next minor (L139).

## Critical

**C-1 — L95–96 vs L110 / L147–149 / L151: "a `runGit` timeout or failure → the empty shape" is stated for all four git reads at once, and that contradicts
both the parity requirement and the chip rule.** `readReleases` catches per call: `remote get-url origin` failing drops only `url` (`read-releases.js:12–20`),
`describe` failing gives `current: null` while `releases` stays (`:21–29`), and only the `for-each-ref` read failing produces the empty shape (`:48–50`).
Built as L95 reads, a tmpdir fixture with no `origin` remote — every fixture in L147–149 unless the test adds one — answers `{ current: null, releases: [] }`,
so "baseline + two releases → newest first" and the parity case (L151) fail, and L110's "absent when `current` is null … even when `releases` is non-empty
(a branch cut before the baseline)" describes a state the route can never produce. L96 then writes the same blanket meaning into `.claude/rules/items.md`'s
`runGit` bullet, whose whole point is to say what `null` means **to each** call site (`.claude/rules/items.md:70–72`). → Replace the blanket clause with the
per-read table, mirroring release-kit: `for-each-ref` → empty shape · `describe` → `current: null` · `remote get-url` → no `url` · the memo's `rev-parse` →
not memoised; and put those four in the items.md bullet rather than "the releases reads → the empty shape". Keep "not a checkout / git missing / no `v*` tags
→ empty shape" as the summary, since those make the first read fail.

## Important

**I-1 — L115–119: the dialog-count homes list omits the test that pins the count, and one doc.** `test/dialog-count-docs.test.ts:40–83` asserts
`/all five dialogs/` in the invariants entry, `/five dialogs/` in the board.md bullet, the five component names, and `/Five since Jira phase 2/` in the hook
header; `docs/subsystems/board.md:153` ("are the five dialogs on the escape stack") and `:404` also carry the count. The spec says "every home of that count
is updated in the same PR" and then enumerates five homes — none of these two. An implementer who edits the listed five to "six" turns that suite red, and
one who edits the suite but not board.md leaves the client doc wrong. → Add `test/dialog-count-docs.test.ts` (its regexes and `FIVE` list become six, with
the drawer's component name) and `docs/subsystems/board.md` to the list.

**I-2 — L98–100: the memo does not say what happens to a read that FAILED under a key git did produce.** Here, unlike the dashboard, a read can fail
independently of the key: `rev-parse HEAD --git-common-dir` answers in milliseconds while `for-each-ref` over the bind mount times out at 10 s — the #277
shape (`git-run.util.ts:7–11`). The dashboard's rule ("a key git cannot produce is never memoised") does not cover it, because `readReleases` never rejects
there is nothing to distinguish; here a `null` from `for-each-ref` is the empty shape, and if that promise is memoised under the valid key the chip
disappears until HEAD or a tag moves — potentially days. The repo's precedent is explicit the other way: `lastCommitDates`' "a failed read (timeout, not a repo)
is neither memoised nor kept pending, so the next call asks again" (`.claude/rules/items.md:54`). → State it: a `null` from any of the reads is answered but
not memoised (and not left as the shared in-flight promise), and add the test "timeout, then the fake git recovers → populated on the next request".

## Minor

- **L48–50 / L138: "the orchestrator-mode guidance" has no named home.** L49 says "the doc tells the user", L138 lists it as PR B content; `ci.md:51–52`
  already says it. Name the file(s) (ci.md §The ruleset and/or `docs/workflows/development.md`) so PR B's scope is fixed.
- **L71–72 / L130: PR A's merge method is unstated while the repo still allows rebase merges.** A rebase merge leaves no single "merge commit" to tag and
  makes "the PR that adds `release.yml` merges" a range of commits (each a "no PR for <sha>" warning). Say "squash-merged by hand" for PR A and PR B, as L133
  already does for step 3; and that the user `git pull`s before tagging so `v0.1.0` lands on the pushed sha.
- **L63 "byte-for-byte copy … header comment adapted"** is self-contradictory; say "a copy, differing only in the header comment".
- **L69 "the trimmed line"**: `extractWhatsNew` uses `trimEnd()` (`conventional.js:65`), so a heading with leading whitespace does not match. Say
  "column 0, trailing whitespace ignored".
- **L96–97: `docs/subsystems/invariants.md:3758–3760` also enumerates the `runGit` call sites** ("none of the five has a reason…"); the reasoning tier gets
  the new sites too, or the "five" there rots the way the dialog count did.
- **L116–117: a new `ui/Drawer.tsx` is a new primitive family.** `test/design-guards.test.ts:321–339` (guard 7) keeps a fixed `FAMILIES` list, each declared
  once inside the `ui primitives` block of `styles.css`; add `.ui-drawer` (or whatever the family is) to that list and the block, or the guard's "one home
  per primitive" rule silently stops covering the drawer. DESIGN.md §8.7's "Both shapes" sentence also needs the third shape, which L123 implies but does
  not say.
- **L36 / L101 "imported only for its pure helpers" vs L94 / L151**: the parity test imports `readReleases`. True of `server/src`, not of the repo; say so,
  since `test/git-run.test.ts`'s grep is scoped to `server/src` and this is why the import is allowed there.
- **L20 "56 direct pushes"**: three of them are `Merge branch 'main' of …` pull-merges, not pushes of a single commit; "56 without a PR" is the accurate label
  and makes the same point.
- **L123–124**: name the tint form the guard parses (`color-mix(in srgb, var(--X) N%, <surface>)` with `color:` in the same rule), since `tintSites()`
  (`daylight-contrast.test.ts:66–76`) throws on any other form — a good failure, but one the implementer should expect.
- **L153**: `test/dialog-escape.test.tsx:216–230` still says "three dialogs" (stale since Jira phase 2); when it is updated for the drawer, the describe name
  and comment should say six, not just gain a case.
