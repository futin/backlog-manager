# /ui-verify — CodeRabbit review on the Jira views

Plan: `docs/superpowers/plans/2026-11-13-coderabbit-review.md` (Task 10). Spec: `docs/superpowers/specs/2026-11-13-coderabbit-review-design.md`.
Mocks: `docs/superpowers/specs/2026-11-13-coderabbit-review-mockups/`. Verdict: **PASS after fixes** — three defects found, all fixed in `fix(jira): match the
review mocks`; five deviations, each justified below.

## How it was run

- The branch's own Vite (`WEB_PORT=5187`, client from this worktree) proxying to the running stack's API on 4322, which still serves `main`'s server. Started
  and killed by recorded pid.
- Playwright MCP failed to connect, so a headless Chromium script drove it, from an already-cached `playwright` package (the skill's one fallback). Light
  theme (`daylight`), 1440 × 1000 and 600 × 1000 (the app folds at 700 px).
- Fixtures: the stack's real `GET /api/gitlab` answer, routed through `page.route`. Each project view gets two candidate `repos`, and the open MRs of one
  ticket get a `review` per state (none, reviewing, open, clean, stale, failed). The final pass leaves every other MR WITHOUT a `review` field, as the old
  API sends it, to prove the client-side default.
- Baseline: the same scenarios against `main`'s client (the stack's own port 5177), for each finding that might predate the branch.

## Inventory

| View | Mock | Opened by | Data | States drawn |
| ---- | ---- | --------- | ---- | ------------ |
| Detail · Delivery track, Review step | `state-{none,reviewing,open,clean,stale}.png` | Jira › Board, open the ticket | lead MR with `review` | all six incl. failed |
| Detail · CodeRabbit row + button | `opt-b-open.png`, `opt-b-none.png` | same | same, plus `repos`, agents on | open, none, stale |
| Card · MR chip (variant X) | `card-x.png` | Jira › Board | open findings | open |
| List · fifth compact cell, `Review open` filter | `list.png` | Jira › Board › List | open findings | open |

The plan cites the mocks per task; no "plan cited no mocks" finding.

## Geometry (overflow check, after fixes)

- Detail, every state at 1440 and `open` at 600: no overflow line except `detail-failed`'s `jira-dlv-review-text 505>495` — the sentence ellipsises by
  design so the button keeps its width; before the fix there was no way to read the rest (defect 2), now its `title` is the full sentence.
- List at 1440: `jira-issues-scroll 1376>1150` (the table's `min-width: 1376px` under a 1150 px main; identical on `main`, deliberate), the Summary and Status
  cells' ellipses (identical on `main`), and `jira-issues-dlv-word 36>0` on the one row with `not merged` and `+1 MR` (deviation 4).
- List at 600: the same, inside `.jira-issues-scroll`; the page itself does not scroll sideways.

## Region by region

**Detail, open (`opt-b-open.png`)**

- Head (`Delivery !15958 ↗ repo → target`, polled age): match.
- Track, five steps, words `11d · 11d · pipeline passed · 2 open · 1 major · —`: match.
- Review dot: **deviation 1** — the mock draws a `!` in the amber dot; live draws the plain amber dot.
- CodeRabbit row: hairline above, amber sentence tint filling the left, ink `Fix review` with the play glyph at the right: match.
- `Also:` line below its own hairline: match (the fixture gives `!15959` open findings too, so it reads `2 to fix` in amber, as spec §5.3 says it must).

**Detail, none (`opt-b-none.png`)** — every region matches: grey `not reviewed` step, grey `CodeRabbit · not reviewed yet`, `Request review`.

**Detail, reviewing (`state-reviewing.png`)** — match: dark grey dot, `reviewing… 4m`, no row.

**Detail, stale (`state-stale.png`)** — track matches (`3 commits since review`, wrapping under the step as in the mock). **Deviation 2**: live draws the
CodeRabbit row and `Request review` under the track; the mock has no row.

**Detail, clean / failed** — clean: `reviewed`-tone step, no row. Failed: the step's `title` carries the `not refreshed since <age>` suffix and the row
sentence ends in it; that sentence was the overflow above.

**Detail, open at 600** — five steps, the row and `Fix review` all inside the dialog; no overflow.

**Card (`card-x.png`)** — chip reads `!15958 · 2 to fix` in amber: match. **Deviation 3**: live also draws `not merged` and the Run split wraps to its own
line; the mock's card has neither.

**List (`list.png`)** — fifth compact cell, marks `on, on, green, amber, off`: match. Filter row `All · Has MR · Pipeline failing · Done, not merged · Review
open`: match. **Deviation 4**: on the one row that also carries `not merged` and `+1 MR`, the word `2 to fix` is squeezed to zero width; the mock shows it.

## Defects (fixed)

1. **A `GET /api/gitlab` answer without `review` crashed the whole Jira section.** `reviewState` dereferences `review`; the stack's API (one release older)
   sends none, so `MrChip` → `deliveryLook` → `reviewMark` threw `Cannot read properties of undefined (reading 'capped')` and the section's boundary
   replaced the board. Fix: `useGitlab` fills a missing `review` with `null` and missing project `repos` with `[]` at the fetch boundary — the values a
   current API sends for "nothing read" and "no candidate". Test: `test/gitlab-context.test.tsx`. Re-measured with the shim removed from the harness.
2. **The CodeRabbit row's sentence ellipsised with no title** (`detail-failed`, 505 > 495). Fix: the sentence is its own `title`. Test:
   `test/jira-delivery-pane.test.tsx` (`open:` case).
3. **`ReviewRow`'s header comment claimed an absent row mounts no poller** — false, the hook runs before the early returns. Comment corrected.

Not a defect: the first pass showed `detail-stale` with no button. A second pass showed `Request review` — the first had measured before
`/api/agents/status` answered, and the row hides the button until it does (spec §5.2, `board.md`: no dead control flashes on load).

## Deviations (kept)

1. **No `!` in the Review dot.** Spec §5.1: the step "uses the existing `jira-dlv-step` markup and `data-mark` tones… nothing else in the track changes", and
   `DeliveryTrack`'s `dotGlyph` draws a glyph only on a verdict (tick, cross) — amber and grey are words. The spec overrides the mock.
2. **Stale draws the CodeRabbit row.** `state-stale.png` predates the picked option B; spec §5.2 gives stale a sentence and `Request review`.
3. **Card `not merged` + wrapped Run.** Pre-existing: `main`'s card for the same ticket draws `!15958 · ✓ pipeline` plus `not merged` and wraps Run the same
   way. The mock's fixture simply had no Done-not-merged ticket.
4. **List word squeezed on a crowded row.** Pre-existing design: the Delivery cell's word ellipsises first so the link, `not merged` and `+N MR` keep their
   width (`JiraIssueList.tsx`, `DeliveryCell`). On `main` the same row's word (`pipeline passed`) is already squeezed to 12 px; the fifth dot takes the last
   12. The review state still reads on that row from the amber fifth dot, the cell's `title`, and the `Review open` filter. Spec §5.3's note that variant X
   avoids the overflow holds for the mock's one-MR row, not for a row that also carries `not merged` and `+1 MR`. Cost if wrong: a wider Delivery column.
5. **Sideways table scroll.** `.jira-issues-table`'s `min-width: 1376px` predates the branch; identical on `main`.

## Screenshots

In the session scratchpad (`uiv/shots/`, baseline in `uiv/base/`): `detail-{none,reviewing,open,clean,stale,failed}.jpg`, `detail-{open,none}-col.jpg`,
`detail-open-narrow.jpg`, `card-open.jpg`, `list-open.jpg`, `list-open-narrow.jpg`. Harness: `uiv/uiv.cjs <playwright dir> <base url> <out dir> [scenarios]`.
