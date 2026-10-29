# Final review — feat/source-sections (Plan A, rail reshape)

Range a470d9f..691e39a (15 commits; c8a6bcf is a merge of main and was not judged). Spec `docs/superpowers/specs/2026-10-29-source-sections-design.md`,
plan `docs/superpowers/plans/2026-10-29-source-sections-rail.md` Tasks 1–7.

Verification run on the head: `pnpm run typecheck` clean; `jest --runInBand` over claude-rules, csp, source-sections, rail, nav, sources-lib, source-page,
projects-context, sources-group, github-settings, settings-view, settings, board, archive, deep-link-app, jira-sections, section-boundary — 17 suites, 390
tests, all green.

## Strengths

- The derivations sit where the repo wants them. `lib/sources.ts` is pure and small (`sourceSectionOf`, `drawnSources`, `firstDrawn`, `settleSection`,
  `inSource`, `projectsIn`, `narrowToSource`), `lib/source-page.ts` holds the keys, guards and `resolveLegacySection`, and `hooks/useSourcePage.ts` is one
  factory rather than two hand copies of `useJiraPage`. The Task 5 fix round put the per-source narrowing in one function, so Board and Archive cannot drift.
- The hold-and-fall copies the Jira row's three-state rule: unknown holds, a present row draws, an absent row falls. The `provisional` flag answers the
  question the Jira rule never had to answer, whether a section was chosen or guessed. The rail never draws a source row on a guess
  (`SideRail.tsx` `drawn`), and RF1 is tested with the projects promise held unresolved.
- Legacy landings are handled carefully. The raw `landing` blob is read to tell a legacy `board` pin from a real `github` one, which `clampSettings` cannot
  do. The fix round's pin write-back closes the "clamped pin stored as a real GitHub pin" hole on the normal path.
- `SectionBoundary` and the rail-cursor pulse are keyed by view (section plus page). That is the right unit now that Board and Archive share a section.
- Hues are built from the whole registry, so a project keeps its colour across both source pages.
- The sync-off sentence moved byte-exact across the server literal, the client copy, `.env.example`, `tracker.md` and invariants. No stale copy of
  `Settings › Shared › Trackers` remains outside the spec and plan history.
- The headlines pass `claude-rules`. The new invariant entry explains its reasons properly, and all three new components cite DESIGN.md §8.6.

## Issues

### Critical

None.

### Important

**I1. Index errors from GitHub projects are sent to Files, and on a GitHub-only machine they vanish.** `client/src/lib/sources.ts:82-86`
(`narrowToSource`); the same claim appears in `docs/subsystems/invariants.md:3380-3381` and `docs/subsystems/board.md:635`.
`narrowToSource` keeps `index.errors` only when `source === 'files'`. Its comment says an index error "names no project, only a file", and that is wrong for
two kinds of error the server sends today:
- `github.source.ts:135`: `<project.path>: backlog/source.json names no valid "repo"`. That project's `/api/projects` source is `github` (`adapter.kind`,
  `items.service.ts`), so the rail files it under GitHub.
- `map-issue.ts:168`: `github:<owner/name>#<n>: N type labels (…) — using X`, a warning about a specific GitHub issue.

On a machine with Files and GitHub, these warnings show on Files › Board, about items that Files › Board does not show. Goal 1 and the first anti-goal say a
page shows only its own source. On a machine with only GitHub projects, the Files row is never drawn, so the warnings appear nowhere. Before this branch they
showed on the single Board. That is a regression in what the person is told about their issues. A GitHub project with an invalid repo, alone on a machine,
shows "nothing registered yet" and no warning at all. The Sources card, which reads `/api/trackers` and calls the same project `unsupported`, says its warnings
are on "the board".

Fix: attribute each error by its prefix in one `lib/sources.ts` function, with the error-routing test extended:
- an error that starts with a registered project's `path` goes to that project's source;
- an error that starts with `github:<repo>#` goes to the project carrying that repo;
- anything unattributable goes to Files.

Then correct the sentence in `invariants.md` and `board.md`. A structured `{ projectPath, message }` error from the server would be cleaner, but it is not
needed for this merge.

**I2. A source board with no items says "nothing registered yet" while that source's row exists.** `client/src/components/board/BoardView.tsx:735`,
`client/src/components/archive/ArchiveView.tsx:298`.
The empty state tests `all.length === 0`, and `all` is now the narrowed index. Before the split, this copy was reachable only when the whole machine had no
items. Now it shows on GitHub › Board for a newly connected repo with no open issues, and on Files › Board or Files › Archive for a files project whose store
is empty or missing. The rail draws that row only because a project of that source is registered, and the Sources card counts it as `1 project`, so the page
contradicts its own rail. It tells the person to register something they already registered. Task 5 deferred this as a minor. The split makes it a common
reading, so it should be fixed before merge.

Fix: `registered.length === 0 ? 'nothing registered yet' : 'no items yet'`, or name the source. `registered` is already the narrowed project list in both
views. Add one case per view.

### Minor

**M1. The loading shape is gated on `pending !== null && drawn === null`, so one commit renders the guessed view.** `client/src/App.tsx:360`.
In the render where the first answer arrives, `drawn` is non-null and `pending` is still set, so `main` renders GitHub › Board until the settle effect's
`change` runs. The effect is a passive `useEffect`, and for a fetch-driven update it can run after paint. In practice the lazy `BoardView` or `ArchiveView`
chunk has not loaded on a cold load, so Suspense shows the same `SectionLoading` and nothing visible flashes. Even so, the comment above the gate ("paints
nothing the projects answer could take back") is true only by accident, and the cost is a wasted chunk fetch. Fix: gate on `pending !== null` alone, since
the settle clears it in the same pass, or settle in a `useLayoutEffect`.

**M2. A legacy `Opens on` pin is settled only while `pending` lives, and navigation clears `pending`.** `client/src/App.tsx:205, 232`.
Pin settling is tied to the section's provisional mark. Three paths leave the legacy pin unsettled:
- a deep link, where `link.section` is set and `pending` is never created;
- a click before the first answer;
- a load whose projects read fails, followed by a click.

After any of these, the next `update()` writes the clamped `github` as a real pin. A Settings tree pick or any Settings change is enough. On a machine with
only files projects, that becomes the case the fix round exists to prevent: on every load a held GitHub row and board appear and then fall to Files.
Reaching this needs a legacy Board/Archive pin, a files-only machine, and one of the three paths on the first load after the upgrade, which is rare. Fix:
keep the pin's legacy flag in its own state that `change` does not clear, and rewrite the pin on the first non-null `drawn`.

**M3. `/api/trackers` and `/api/projects` disagree about a GitHub marker with an invalid repo.** `client/src/components/settings/SourcesGroup.tsx:42, 74`.
The Sources card counts and links from `/api/trackers`. That payload calls an invalid-repo GitHub marker `unsupported`, while `/api/projects`, and so the
rail, call it `github`. The card can count a project under Files while the rail draws it under GitHub, and it hides `GitHub › Settings ↗` while the GitHub
row is drawn. Both reads refresh on focus, so the counts otherwise agree. The divergence comes from the server, and `tracker.controller.ts:69-70` claims the
two agree. Fix: gate the link on `useProjectsContext().drawn?.github`, which is what the header comment promises: "drawn only while the section it opens is
drawn". The server disagreement can become a backlog item.

**M4. Two docs claims are inaccurate.**
- `docs/subsystems/invariants.md:3377` says `TrackersPayload.projects` "knows only tracker-backed projects and would leave Files with no answer at all".
  The payload carries every registered project, and the Sources card's Files row reads exactly that. The real reason for `ProjectsProvider` is the spec's:
  the provider is the shell's one answer, refreshed on mount and focus.
- The `narrowToSource` sentence is covered by I1.

**M5. The section key holds a guessed `github` before any answer.** `client/src/App.tsx:94` and `:263`.
`usePersistedState`'s mount effect writes `FALLBACK_SECTION` when no key exists. The Jira fall's `change(FALLBACK_SECTION)` writes it too. This is the ledger
item from Task 4; see the rulings.

**M6. Prose wider than 160 columns.** A dozen added lines run over by 1–16 characters (measured in characters, not bytes):
- `.claude/rules/board.md` ≈170;
- `App.tsx` 162/166 (JSX);
- `ArchiveView.tsx` 162;
- `BoardView.tsx` 161/162;
- `docs/subsystems/board.md` 170/173/185;
- `invariants.md` 234;
- `tracker-sync.controller.ts` 161;
- `shared/types.ts` 162 ×2.

Rewrap.

**M7. The pulse can come back after a page switch inside a source.** `client/src/App.tsx:183`.
Switching pages inside a source does not reset `pulse`. Coming back to a page can briefly show that page's last `working: true` until it reports again. The
rail cursor is the only effect. Fix if convenient: reset `pulse` when `view` changes.

## Rulings on the ledger minors

| Ledger item | Ruling |
| --- | --- |
| T2: ProjectsContext thrown-fetch / non-array branches untested | Acceptable (Minor). Both branches are one line and keep the last answer; tests (c)/(d) cover the same keep-last path through a 500. |
| T2: raw `ProjectsContext` exported | Acceptable. Three suites inject through it; `TrackersContext`/`JiraContext` follow the same pattern. |
| T4: loading shape gated on more than `pending !== null` | Minor, should fix (M1). Suspense hides it today, so it does not block merge, but the fix is one token and makes the comment true. |
| T4: `usePersistedState` + Jira fall write `github` while a guess | Acceptable (Minor, M5). It matters only when the projects read never answers in that session, and the next load self-heals after one held-row flicker. Optional fix: a plain `localStorage.setItem` writer instead of `usePersistedState`. |
| T4: stale `resolveSection` / "falls to Board" comments | Resolved at head. A grep over `client/`, `server/`, `shared/`, docs and rules finds none. |
| T4: pulse revival; key-by-view boundary untested | Acceptable (Minor, M7). Cosmetic; the boundary key is a one-expression change, with `view` covered indirectly by the page-render tests. |
| T4: legacy pin on a machine with no projects persists as an Opens-on Runs pin | Acceptable. The spec says "else the Fallback above — and writes the settled value back". A machine with nothing registered has no Board to pin. |
| T5: `projectKey()` untested | Acceptable. Trivial template; per-source persistence is exercised by the board/archive pick tests. |
| T5: no test of #391 plan-review filter on a GitHub board | Acceptable. `planReviewTally(all, …)` reads the narrowed `all`, so the source cut is the same one every other board test covers. |
| T5: `inSource` linear find | Acceptable. Registries are small; O(items × projects) is negligible here. |
| T5: GitHub project with no items reads "nothing registered yet" | **Must fix before merge (Important, I2).** |
| T5: index parse errors shown on Files only | **Must fix before merge (Important, I1).** The ledger's premise, "errors name no project", is false for GitHub errors, which are attributable and are lost on a GitHub-only machine. |
| T5: old bare `PROJECT_KEY` not migrated | Acceptable. The fail-open reads All projects on first visit, as documented in `view-keys.ts`. |
| T5 oos: hues comment line may exceed 160 cols | Minor, fold into M6. |
| T6: GithubSyncGroup failed-read/unavailable untested | Acceptable. Copied from the old `TrackersGroup` branches; the Sources card's equivalent is tested. |
| T6: `source === null` Files line untested | Acceptable (Minor). One literal line. |
| T7 ⚠️: board.md:26 code-span break | Acceptable. CommonMark allows a line ending inside a code span (rendered as a space), so it renders as `update({ settingsScope })`. Rewrap if touching it. |
| T7 ⚠️: DESIGN.md:394 stale two-column paragraph | Acceptable for this branch. That paragraph describes the Local split and `Claude Agents`, which were already stale before this branch. The Shared balance this branch changed is restated correctly at :396. |
| T7 ⚠️: GitHub link reads tracker counts, not `drawn` | Minor, should fix (M3). One-line gate change. |

## Declined to judge

- The GitHub › PRs page, PR routes, PR cache and the PR write invariant: Plan B, explicitly out of this branch.
- The token-permission docs for PR scopes (Contents/Pull requests write, GraphQL auto-merge): these belong to Plan B's write surface.
- The merge commit c8a6bcf's content from main (#391): instructed to judge only this branch's changes.
- The server-side disagreement between `/api/trackers` (`unsupported`) and `/api/projects` (`github`) for an invalid-repo marker: it predates this branch.
  Only its new client consequence is graded (M3).
- A real `files`/`github` Opens-on pin on a machine that no longer has that source flickers a held row on every load: this is the same behaviour as the
  established Jira pin precedent, which the spec adopts.
- The landing on Files rather than GitHub for an absent key on a machine with both sources: the spec's Fallback rule (`firstDrawn`, Files first) states it.
- Writing a legacy page into both page stores, so that Files later opens on Archive after a legacy `archive` settled on GitHub: the plan specifies it.
- DESIGN.md paragraphs written one line per paragraph: the file's existing convention (158 over-160 lines already at the base).
- The README env table's long rows: a table, which the width rule exempts.
- The visual quality of the GitHub branch icon and the Sources card layout: not verifiable without a rendered review. The DESIGN.md citations are present.
- The full `pnpm test` run: CI is the gate by project rule. Only the touched suites were run here.

## Assessment

**Ready to merge? With fixes.** Fix I1 (route GitHub index errors to GitHub) and I2 (empty-state copy on a source page with registered projects). Both are
small and local to `lib/sources.ts`, BoardView/ArchiveView and two doc sentences. M1 and M3 are one-line follow-ups worth folding into the same fix round.
