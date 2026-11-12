# ui-verify — 2026-11-12-gitlab-connection

Verdict: **PASS** (one defect found and fixed on the branch; two concerns left for the reviewer).

The branch's client was served by its own Vite (port 5291, pid recorded and killed by that pid; its proxy aimed at a dead port, so nothing reached the user's
stack). Headless Chromium (cached playwright 1.63.0, chromium-1243 — Playwright MCP failed to connect) with every `/api/**` call fulfilled through
`page.route` from fixtures built on `shared/types.ts`; daylight theme unless stated. Harness, fixtures and screenshots:
`/private/tmp/claude-501/-Users-andrejajevtic-Documents-custom-projects-backlog-manager/bdec6ed6-7fb9-4452-82cd-0be334615ebc/scratchpad/ui-verify/`
(`harness.js`, `fixtures.js`, `scenarios.js`; every image named below lives there).

Where the spec (`specs/2026-11-12-gitlab-connection-design.md`), `.claude/DESIGN.md` or a design guard overrides a mock, the line says **deviation**, not defect.

## Inventory

| View | Mock | How opened | Data | States drawn |
| ---- | ---- | ---------- | ---- | ------------ |
| Settings › Shared › Sources, GitLab row | `2026-11-12-gitlab-connection-mockups/Settings.dc.html` | `?section=settings&settings=shared` | `GitlabStatus` per state | unconfigured, malformed site, checking, rejected (401), unreachable (redirect refused), idle (found other hosts), connected with 3 problems, rate-limited, failed fetch |
| Jira board band + cards (deck and shelves) | `…/Cards.dc.html` | `?section=jira`, page `board`, view `board` | 14 issues on TIMIFY/ANDR/PAY, 12 MRs (draft, failed, running, canceled, none, merged, closed, open-after-done, long repo + long target, two "also" MRs, sub-task inherit), 2 live sessions, long worktree branches | every §7 delivery look, `via` parent, `not merged`, unknown (capped project), not-on-site |
| Jira List with the Delivery column | `…/List.dc.html` | same, view `list` | same | every cell shape: track + word, `not merged`, `+2 MR`, `no MR`, `—`, empty |
| Jira Detail › Agent column › Delivery pane | `…/OptionC.dc.html` | deck title / shelf card click on 102, 103, 107, 108, 109, 111, 112, ANDR-7, PAY-5 | same | open/success, failed, merged, closed, open-after-done, inherited, known-no-MR, capped, none |

Mock screenshots: `mock-Settings.jpg`, `mock-Cards.jpg`, `mock-List.jpg`, `mock-OptionC.jpg`.

## Geometry (`scrollWidth > clientWidth` with `overflow-x` not visible, plus page scroll)

- Board 1440×1000 and 600: only `span.jira-card-crumb 284>245` (×2) and `span.jira-card-tree 387>317` — the card crumb's and tree line's deliberate
  ellipsis, not GitLab's. No page scroll.
- List 1440 (rail open): `.jira-issues-scroll` 1376>1150 — the table's own scroll box takes the Delivery column (spec §7.3's accepted horizontal scroll);
  the page does not scroll. 600: same box, no page scroll.
- Detail 1440 and 600, every key above: the board lines only; dialog inside the viewport; no page scroll.
- Sources, every state: none.

## Carried checks

- **`.jira-dlv` spacing.** Agent band ends y396, Delivery starts y410 (14); Delivery ends y650, History starts y664 (14); History label → list 14. The
  column's own `gap`, so the pane spaces like its siblings; the mock's ~16 is a mock rounding, not a defect.
- **Fit in the Agent column at 1440×1000.** Pane 642 px wide. With `checkout-service-with-a-very-long-repository-name` → `release/2026.11-hotfix-candidate-for-the-checkout-flow`
  the head wraps to three lines: `Delivery !4402 ↗`; `repo → target` (591 px); `polled 4m ago`, right-aligned. At 600 the target wraps to two lines, no page
  scroll. Short names stay on one line.
- **Glyph contrast (WCAG ≥3:1), every theme** — ink over fill:

  | Theme | `--on-accent`/`--red` | `--on-accent`/`--magenta` | `--on-fill`/progress | `--on-fill`/amber |
  | ----- | --------------------- | ------------------------- | -------------------- | ----------------- |
  | daylight | 6.00 | 6.18 | 8.55 | 5.27 |
  | midnight | 4.88 | 5.72 | 9.85 | 10.26 |
  | graphite | 5.19 | 6.18 | 9.06 | 8.71 |
  | amber | 5.68 | 8.33 | 12.17 | 10.98 |
  | nightshift | 5.66 | 6.61 | 11.31 | 11.57 |

  All pass. The grey Closed/Canceled dot carries no glyph.
- **Card MR chip ellipsises before `Run ▾` loses width.** `Run ▾` measured 93 px in every card at 1440, at 600, and with cards squeezed to 200 px
  (`live-chip-squeeze.jpg`); the marker row wraps and the chip carries `max-width: 100%; text-overflow: ellipsis`. Never overflowed.
- **List at 1440 with the rail open.** Scroll box 1150, table 1376 (1120 + Delivery 256). Columns: Session 140, Key 108, Summary 116, Type 100, Status 116,
  Delivery 256, Priority 116, Assignee 124, Sprint 76, Updated 60, Run 164. The min-width reasoning holds: without it Summary collapses first; with it the
  box scrolls and the page does not.
- **Band GitLab line on its own line.** `GitLab: 8 open · 1 failing · 1 merged · polled 5m ago` at y121 under the Jira sub-line at y103, `display: block`;
  counts match the fixture.
- **Sources row, every state** (`live-sources-*.jpg`):

  | State | Hint | Pill |
  | ----- | ---- | ---- |
  | unconfigured | `set BM_GITLAB_SITE and BM_GITLAB_TOKEN in .env and restart` | `not configured` |
  | malformed | `BM_GITLAB_SITE must be a hostname, like gitlab.example.com` | `not configured` |
  | checking | `gitlab.example.test` | `checking…` |
  | rejected | `… refused the token (401) — 401 Unauthorized` | `down` |
  | unreachable | `… did not answer — redirect refused (301)` | `down` |
  | idle | `ada · site`, `no mapped repository is on … — found github.com, gitlab.other.test` | `not polled yet` |
  | connected | `ada · site`, `3 repos mapped via Jira › Setup › Repositories`, then the 3 problem lines | `connected` |
  | rate-limited | the connected lines, then `rate limited — next read in 3m` | `late` |
  | failed fetch | `unavailable` | `unavailable` |

## Brief step-2 assertions at 1440

- No sideways page scroll on Board, List or Detail: **holds**.
- The List's own scroll box takes the Delivery column: **holds**.
- Chips ellipsise before `Run ▾`: **holds**.
- No `Review` / `CodeRabbit` step drawn anywhere: **holds**.
- No uppercase: **holds** for every GitLab surface. The only `text-transform: uppercase` on screen is the rail brand's `this machine`, a pre-existing ui-kit
  element outside this branch.

## Regions

Settings.dc.html (`live-sources-*.jpg`)
- Row shape, label, hint and pill: **match** in substance — the live row is the existing `SettingsRow`, words per spec §5.2.
- The mock's `new` tag, `· read_api` scope text and inline single-line row: **deviation** (spec §5.2 / §7.5).

Cards.dc.html (`live-board-1440.jpg`, `live-board-1440-full.jpg`, `live-board-600.jpg`, `live-chip-squeeze.jpg`)
- MR chip on the card (`!iid · glyph word`), tone per §7's table: **match**.
- Deck cards: chip on its own line under the crumb (`!4403 · ✕ pipeline failed`; `!410 · ◷ running` titled `via TIMIFY-110`): **match** to spec §7.2.
- Shelf cards: chip after the repo/worktree chip, before Run; `not merged` on 109: **match**.
- Band line: **deviation** — the mock puts toned counts at the header's right; spec puts plain text on its own line.
- Three status columns: **deviation** — live is the deck over shelves (spec §7.2).
- `· no MR` on the card: **deviation** — not drawn (spec).

List.dc.html (`live-list-1440.jpg`, `live-list-1440-scrolled.jpg`, `live-list-600.jpg`)
- Delivery column, mini track + word, `+N MR`, `no MR`, `—`, empty for not-on-site: **match**.
- Quick filter: **deviation** — the ui-kit `Segmented` on its own right-aligned row, not the mock's pills.
- Link colour: **deviation** — cyan per DESIGN tokens, not underlined green.
- Track: **deviation** — 4 dots, not the mock's 5 (no Review step, spec).

OptionC.dc.html (`live-detail-*.jpg`, `zoom-track-TIMIFY-103/107/108.jpg`)
- Pane head, track, labels, words, "also" MRs, `via TIMIFY-110` on 111, merged all-magenta with no Pipeline word on 107, grey `Closed` end on 108, no-MR
  sentence naming both repos on 112, capped sentence on ANDR-7, no pane on PAY-5: **match**.
- The mock's dashed Review step and 480 px column: **deviation** (spec).
- Track paint order: **defect, fixed** — each step's absolutely positioned rail (`right: 50%; width: 100%`) comes later in the tree than the previous step's
  dot, so it painted over that dot's right half: glyphs were cut, and the hollow not-reached ring showed the rail through it (visible on 103, 107, 108 in
  the zooms before the fix). Now `.jira-dlv-dot` takes `z-index: 1` and `.jira-dlv-track` takes `isolation: isolate`, so the lift stays inside the track
  and never rises over the List's sticky header (z 1) or a menu (z 20). Re-shot zooms show whole dots and empty rings. Pinned by a rule-level test in
  `test/jira-delivery-pane.test.tsx` (`delivery track paint order`), red on the old sheet and green on the new one.

## Concerns (not fixed)

- **List word squeezed by `not merged`.** On 109 the Delivery word ellipsises to `pipeline …` (84 > 59 px). It is the documented "word ellipsises first"
  rule and the cell carries a full `title`, but the worst case — a 5-digit iid, `pipeline canceled`, `not merged` and `+N MR` — leaves almost no word.
  A wider column or dropping `+N MR` under `not merged` would be a spec call, not a ui-verify fix.
- **Pre-existing uppercase.** The rail brand's `this machine` is ui-kit's own and outside this branch; noted only because the brief asks for no uppercase.

## Fixes made

- `client/src/styles.css` — `isolation: isolate` on `.jira-dlv-track`, `z-index: 1` on `.jira-dlv-dot`, with the why-comment.
- `test/jira-delivery-pane.test.tsx` — `delivery track paint order` (2 cases).
- No `.claude/DESIGN.md` change needed.

Checks run: `jest test/jira-delivery-pane.test.tsx test/jira-delivery-surfaces.test.tsx test/daylight-contrast.test.ts test/design-guards.test.ts
test/csp.test.ts` (5 suites, 79 tests green; `jira-delivery-surfaces` is the `grep -l jira-dlv-track test/` hit), `pnpm run typecheck` clean.
