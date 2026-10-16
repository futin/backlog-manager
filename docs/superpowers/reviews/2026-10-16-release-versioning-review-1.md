# Review 1 — `docs/superpowers/plans/2026-10-16-release-versioning.md` against `docs/superpowers/specs/2026-10-16-release-versioning-design.md`

Reviewer: Fable 5.1 subagent, 2026-10-16. Read: the plan, the spec, the dashboard's `release.yml`, `pull_request_template.md`, `shared/types.ts`,
`docs/subsystems/releases.md`, `docs/workflows/ci.md` §Releases, `hooks/useReleases.ts`, `test/api-releases.test.ts`; release-kit v1.1.0's `dist/cjs/`
(`index.js`, `conventional.js`, `git.js`, `read-releases.js`, `release.js`) and its `package.json`; and in this repo every file the plan names (existence
checked by `ls`), plus `test/dialog-count-docs.test.ts`, `test/dialog-escape.test.tsx`, `test/claude-rules.test.ts` + `test/helpers/rule-tiers.ts`,
`test/design-guards.test.ts`, `test/daylight-contrast.test.ts`, `test/git-run.test.ts`, `test/nav.test.tsx`, `test/rail.test.tsx`, `jest.config.ts`,
`client/src/App.tsx`, `client/src/components/SideRail.tsx`, `client/src/styles.css` (rail block), `.claude/DESIGN.md` §8.7, `.claude/rules/items.md`,
`docs/subsystems/invariants.md` §3755–3766, `docs/subsystems/board.md` 150–158 / 402–406.

## Verdict

**APPROVE WITH FIXES.** No Critical finding. Five Important findings, all local edits to the plan text; the architecture, the test matrix and the
rollout are faithful to the spec and to release-kit's actual code.

## Coverage (checklist 1)

| Spec section / test case | Task |
| --- | --- |
| Part 1 — ruleset apply (user step), `pr`-mode guidance, publishing.md, ci.md §The ruleset, CLAUDE.md "Phase C" line, memory note | User checkpoint 3; Task 2 Steps 1–4 |
| Part 2 — `release.yml`, PR template (adapted, `## What's new` byte-equal, verified against `extractWhatsNew`), baseline tag, ci.md §Releases | Task 1 Steps 1–4; checkpoint 1 |
| Part 3 API — types, module, walk-up root, `BM_RELEASES_ROOT`, `for-each-ref` + re-sort, `describe --long` + filter, `parseTagMessage`, GitHub URL, per-read degradation, memo, items.md bullet + `paths:`, invariants count, dependency + `.d.ts` shim, CLAUDE.md Layout | Tasks 3, 4 |
| Part 3 UI — chip (last rail element / last menu row, `+N`, absent on `current: null`, dot + storage key), drawer (badges, Breaking, title strip, markdown notes, `PR #N`, baseline divider, 400 px / full screen), Escape via `ui/Drawer`, six-dialog homes, DESIGN.md §8.7 + §8.10, fetch on load + on open, `lib/releases.ts` homes, `docs/subsystems/releases.md`, overview/board/api docs | Tasks 5, 6, 7 |
| Rollout 1–6 | Task 1 → checkpoints 1–3 → Task 2 → Tasks 3–7 |
| Testing: no git dir / no tags / lightweight only / baseline+two newest-first / `ahead: 0` / `ahead: 1` after a commit / tag without moving HEAD / non-GitHub origin / timeout then populated / failing `describe` alone | Task 4 Step 1 (the `describe` case is the side-branch case: no reachable tag → `describe` exits non-zero → `current: null`) |
| Testing: parity with `readReleases` | Task 4 Step 1 |
| Testing: client lib cases | Task 5 Step 1 |
| Testing: drawer renders + Escape over another dialog | Task 6 Step 1 |
| Testing: workflows proved by real runs, plan records which | Task 1 Step 5, checkpoint 2, Task 7 Step 6 |
| Review Focus 1–5 | 1 → Task 4 linked-worktree case; 2 → Task 4 same-second case; 3 → Task 4 timeout/recovery; 4 → Task 5 throwing storage + `garbage`, Task 7 throwing storage; 5 → Task 6 dialog-escape case |

Spec requirements with **no test in any task**: "Fetch: once on load and again when the chip opens the drawer" (spec L127) — see I-5; the drawer's
"date" (spec L117) — Minor M-9.

## Important

**I-1 — plan L80 vs L90–91: landing PR B before checkpoint 3 makes ci.md lie.** L80 lets the session "resume at Task 2 … earlier, if they choose to land
PR B first", and the spec's Rollout (spec L149–150) allows steps 4–5 to swap. But Task 2 Step 2 (L90) unconditionally rewrites ci.md §The ruleset's state
line to `applied on <date the user gives>` and Step 4 (L95) writes "`main` is PR-only since <date>" into memory. In the swapped order the ruleset is not
applied when PR B merges (`docs/workflows/ci.md:49` currently reads "State on 2026-10-15: not applied, deliberately"). → Either forbid the swap in the
plan, or give Task 2 Step 2/4 both wordings: before the apply, the state line says the precondition is met (PR-mode run #N merged) and the apply is
pending; after it, `applied on <date>`. Say which one the session writes and what triggers the second edit.

**I-2 — plan L141: the `v0.2.0` fixture's title is ambiguous and one reading fails the expected `title`.** The plan says the tag is "from
`feat(releases): version chip (#12)`" and is written "with release-kit's `formatTagMessage`" (L135). `formatTagMessage` appends ` (#${r.pr})` itself
(`claude-agents-dashboard/node_modules/release-kit/dist/cjs/conventional.js:81`: `` `${r.title} (#${r.pr})\n\n…` ``), and `parseTagMessage` strips exactly
one trailing ` (#N)` (`conventional.js:87`). An implementer who passes the shown string as `title` produces the subject `feat(releases): version chip (#12)
(#12)` and the route answers `title: "feat(releases): version chip (#12)"`, not the expected `"feat(releases): version chip"`. → State the
`formatTagMessage` inputs explicitly: `{ title: 'feat(releases): version chip', type: 'feat', scope: 'releases', pr: 12, breaking: false, notes: '- Shows the
running version' }` and `{ title: 'fix(api)!: tighten', type: 'fix', scope: 'api', pr: 13, breaking: true, notes: '' }`; keep the "(#12)" only where the
subject is described.

**I-3 — plan L109: `node -e "require('release-kit').parseTagMessage"` prints nothing.** `node -e` evaluates without printing the expression's value;
only `-p` prints. The stated verification ("prints a function") cannot be observed as written. → `node -p "typeof require('release-kit').parseTagMessage"`
→ `function`.

**I-4 — plan L223–226: the "`AppShell`-level case" cannot live in `rail.test.tsx` as described, and its fetch mock is under-specified.** `rail.test.tsx`
renders `SideRail` alone (`test/rail.test.tsx:9`), `AppShell` is not exported (`client/src/App.tsx:74`, `function AppShell()`), and an App-level mount
pulls in the sections and the shell's Jira/tracker contexts: the precedent `test/nav.test.tsx` has to `jest.mock` `BoardView` and `SettingsView`
(`nav.test.tsx:38,56`) and route `fetch` by URL (`nav.test.tsx:123`) because a real `BoardView` brings "four fetches and a polling clock"
(`test/shell-strip.test.tsx:16`). A single `fetch` mock that answers the Task 4 fixture to every URL would feed `ReleasesResponse` bodies to
`/api/items`, `/api/jira`, `/api/trackers`. → Say the App-level cases render `<App />` with `nav.test.tsx`'s stubs and a URL-routed `fetch` whose
`/api/releases` branch answers the fixture, and put them in their own file (e.g. `test/releases-shell.test.tsx`) or in `nav.test.tsx`; keep the four
`SideRail`-prop cases in `rail.test.tsx`.

**I-5 — spec L127 ("again when the chip opens the drawer") has no test; plan L219 states the interface but L223–226 never asserts the refetch.** The
dot-clearing case ("click → drawer open, `localStorage` holds `0.2.1`") passes whether or not opening calls `refresh()`. The dashboard's hook refetches on
open (`claude-agents-dashboard/client/src/hooks/useReleases.ts:6–7`) and the spec adopts that. → Add to the App-level case: after the click, the
`/api/releases` branch of the `fetch` mock was called twice (once on mount, once on open), and a hook-level case: `useReleases()` fetches once on mount,
`refresh()` fetches again, a rejected fetch leaves `data` unchanged.

## Minor (file only)

- **M-1 plan L135–136 / L140.** "tags written with release-kit's `formatTagMessage`" cannot produce the baseline: `formatTagMessage` always emits
  `Release-Type: …` (`conventional.js:75`), and a message with trailers is not the baseline (`parseTagMessage`, `conventional.js:97`). L140 says "no
  trailers", so the implementer will work it out; say the baseline is `git tag -a v0.1.0 -m "Baseline — versioning starts here"` and only the two
  releases go through `formatTagMessage -F`.
- **M-2 plan L70.** The exact annotation is `no baseline tag — see Baseline` (`release.js:128`); "`no baseline tag`" is a substring, fine as a check,
  but quote the whole string if it is to be recorded.
- **M-3 plan L54.** ci.md's docs-sync `sources` is `.github/workflows` (`docs/workflows/ci.md:58`), which covers `release.yml` but not
  `.github/pull_request_template.md`, which Task 1 also creates and §Releases will describe. The dashboard's ci.md lists the template explicitly. Add it.
- **M-4 plan L58–59.** The dashboard header already reads `(docs/workflows/ci.md §Releases)` — the same relative path here — so "change only the header
  comment" may amount to the `design D3` pointer alone, and the `diff` may be empty. Not wrong; say so, so the step does not look half-done.
- **M-5 plan L85–86.** The memory file is under `~/.claude/projects/…`, outside the repo: it is a session edit, not part of PR B's diff. List it under a
  separate "outside the PR" line so the PR body does not claim it.
- **M-6 plan L92.** The same CLAUDE.md bullet (`CLAUDE.md:249–250`) also says "(it becomes the squash commit once squash-only merges are applied)" — stale
  after checkpoint 3 in the same way. Reword both halves. The bullet is tier one (`test/helpers/rule-tiers.ts:95–99`: every bullet from `## Invariants`
  on), so it stays ≤ 80 words; it is ~45 today.
- **M-7 plan L119 / L160.** The invariants sentence names five sites and the items.md bullet five (`resolveBaseBranch`'s two `runGit` calls count as one
  site in both: `server/src/items/base-branch.util.ts:46,49`); with the four releases meanings the count becomes nine. Say "five → nine" so the
  implementer does not count calls.
- **M-8 plan L192.** `test/dialog-count-docs.test.ts` also pins the hook comment's `Three of them now, not four`, `Five since Jira phase 2` and `six
  composers` (`dialog-count-docs.test.ts:79–82`). The plan's "five → six" must keep the first two as history (the file's own stated rule) and add a
  six-sentence pin. And `test/dialog-escape.test.tsx`'s "three dialogs" describe (`:230`) mounts three components directly; moving it to six means
  mounting `JiraIssueModal` and `JiraBoardSheet` too, with their fetch stubs — a larger edit than "stale three → six" suggests.
- **M-9 plan L199–202.** Spec L117 lists the date among the entry's parts; no drawer case pins it. Add "the entry shows its date" (any stable format).
- **M-10 plan L201.** "a `### Sub` note line → an `h3`" is not in the Task 4 fixture (notes `- Shows the running version`). Say the drawer data is the
  fixture with `0.2.0`'s notes extended by a `### Sub` line, so the two suites' fixtures are not read as disagreeing.
- **M-11 plan L126–132.** Spec L104–105: the memo "must not share code with the `uncommitted` read" is not restated; the service header (Step 3) is the
  natural home for that sentence.
- **M-12 plan L230–231.** The live check reads the `v0.1.0` tag through the worktree's common dir; it is present only if the main checkout has fetched
  it since checkpoint 1. Add `git fetch --tags` (in the main checkout, via the Terminal panel per the memory note) before the check.
- **M-13 plan L225.** `AppShell` is unexported; write `App` (`client/src/App.tsx:8` of `nav.test.tsx` imports `App`).

## Verified as correct (so the author need not re-check)

- Every Create path is absent and every Modify path exists (`ls` over all 40 names; `test/rail-bar-style.test.ts` is `.ts`, the plan's pattern matches).
- `runGit(args, { cwd })` and `__setGitTimeoutMs` exist (`server/src/git-run.util.ts:46,70`); `listenLoopback` (`test/helpers/app.ts:38`), `claimTmpRoot`
  (`test/helpers/tmp-root.ts:60`), `renderMarkdown` (`client/src/lib/markdown.ts:179`), `useDialogEscape`, `FAMILIES` (`test/design-guards.test.ts:322`),
  `tintSites` (`test/daylight-contrast.test.ts:134`, requires `background: color-mix(in srgb, var(--X) N%, var(--Y)|transparent)` — the plan's form).
- `jest.spyOn(gitRun, 'runGit')` has precedent (`test/uncommitted.test.ts:461`, `test/git-dates.test.ts:168`).
- release-kit v1.1.0: CJS `require` condition (`package.json#exports`), `dist/` is in the tag (20 files), root exports include `parseTagMessage`,
  `formatTagMessage`, `extractWhatsNew`, `readReleases`; `DESCRIBE_FILTER` is exactly the plan's L130 (`git.js:13`); `LONG_DESCRIBE` and the GitHub regex
  are in `dist/cjs/read-releases.js:10–11` as L128–130 say; `versionTags` re-sorts date desc then version desc (`git.js:47`); `readReleases` runs `describe`
  only when `releases` is non-empty (`read-releases.js:46`); `extractWhatsNew` strips HTML comments first, so the untouched template → `''` and the
  replaced placeholder → the line itself (L64–66 hold); warnings `no PR for <sha>` (`release.js:85`).
- `Release`/`ReleaseType`/`ReleasesResponse` field order and optionality match the dashboard (`claude-agents-dashboard/shared/types.ts:777–805`).
- DESIGN.md §8.7 opens "Both shapes are the dashboard's own" (`.claude/DESIGN.md:394`), so "three overlay shapes" is the right edit; board.md's two
  "five dialogs" mentions are at 153 and 404; invariants' "none of the five has a reason" is at 3761.
- `.rail` is moved by `transform` below 700 px (`client/src/styles.css:285`), so the dashboard's "render the drawer outside the rail" reason applies here.
- The `.claude/rules/items.md` `paths:` widening passes `claude-rules.test.ts` case 3 (the glob universe includes untracked files, so the new directory
  counts in the same commit).
- Interfaces: every name Task 6/7 consumes is produced earlier with the same spelling (`ReleasesResponse`, `ReleasesDrawer({ data, onClose })`,
  `dotState`, `readLastSeen`, `writeLastSeen`, `chipLabel`); no task depends on a later one.
- Plan conventions: behaviour and exact values only, no literal code; prose wrapped at 160; size targets soft — followed throughout.
