# Rail Pending Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every rail sub-page row can carry a live pending-count pill, and each section's top row shows the sum; first counts are GitHub › PRs, Runs ›
History and Jira › Sessions.

**Architecture:** One pure `client/src/lib/rail-counts.ts` builds `section → page → RailCount` from reads the shell already holds and sums a section for its
top row. `SideRail` calls it (adding the Jira input itself, since `JiraSessionsProvider` sits inside `AppShell`'s return), draws the top-row sum and hands
each `RailTree` its section's entries. `openPrCount` joins `needsYouCount` in `lib/pr-layouts.ts` so the PRs band and the pill share one sum.

**Tech Stack:** React 18 + TypeScript client, jest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-11-16-rail-pending-counts-design.md`

**Plan convention (override of the writing-plans template):** this plan gives behaviour, signatures, exact values and test cases, never literal
implementation code. The implementer writes the bodies and may disagree with the plan where the code says otherwise — say so in the task report. Any size
budget is soft.

## Global Constraints

- Pending counts are live, never "since you last looked"; no localStorage, no new poller, no server change.
- Zero draws no element, top row and sub-row alike.
- Tone: `warn` (amber) when the count includes something waiting on the reader, `neutral` (grey) when it is only a quantity; a top row is `warn` when any
  of its entries is.
- Copy (accessible names), exact:
  - PRs, none need you: `1 open PR` / `5 open PRs`
  - PRs, k need you: `1 open PR, 1 needs you`, `5 open PRs, 1 needs you`, `5 open PRs, 2 need you`
  - History: `1 live run` / `2 live runs`
  - Sessions: `1 session needs you` / `3 sessions need you`
  - Top row: its non-zero entries' labels joined by `; ` in tree order; one entry → exactly that label.
- Page keys: `github.prs`, `runs.runs` (History), `jira.sessions`.
- Every derivation has one home in `client/src/lib/`; every component cites its `.claude/DESIGN.md` subsection in a header comment (board.md).
- Comments explain why, at the repo's existing density. New prose wraps at 160 columns.
- Jest suites sit one level down in `test/<feature>/`.

## Review Focus

1. A PRs payload where some repos are `forbidden`/`not-found` — the pill must count only `splitReach`'s shown repos, equal to the band's `N` (Task 1 test).
2. PRs: open PRs exist but none need you — pill draws grey with `N open PRs`, not hidden and not amber (Task 2 and Task 3 tests).
3. Jira unreachable after a non-zero answer — the Sessions pill and the top-row sum keep the last count (`useJiraNeedsYou`'s rule), never a false zero (Task 3
   test).
4. Narrow width (< 700 px), where every tree stands open — top-row sum and sub-row pills both draw, and the Sessions sub pill is still a working button (Task
   3 test).
5. A click on a plain sub-row pill must still land on that page (pill passes clicks through via the existing `.rail-count:not(button)` rule) — the sub-row
   pill must reuse `.rail-count` inside a positioned wrapper, not a new class (Task 3 test pins the class and wrapper).

---

### Task 1: `openPrCount` — the one home of the PRs band's `N`

**Files:**
- Modify: `client/src/lib/pr-layouts.ts` (beside `needsYouCount`, ~line 170)
- Modify: `client/src/components/github/PullRequestsView.tsx:195-196` (the inline `shown.reduce`)
- Test: `test/github/pr-layouts-lib.test.ts` (new `describe('openPrCount')` beside `describe('needsYouCount')` at ~531)

**Interfaces:**
- Produces: `openPrCount(data: PullRequestsPayload | null): number` — sum of `total` over `splitReach(groupRepos(data.repos)).shown`; `null` → `0`.

- [ ] **Step 1: Write the failing tests**, reusing the `needsYouCount` describe's fixture builders:
  - `openPrCount(null)` is `0`.
  - Two readable repos with `total` 3 and 2 → `5`.
  - Same plus a `forbidden` repo with `total` 4 → still `5`; only a `forbidden` repo → `0`.
  - A truncated repo (`total` 7, 2 PRs listed) counts `7`.
- [ ] **Step 2: Run** `pnpm exec jest test/github/pr-layouts-lib.test.ts -t openPrCount` — expect FAIL (`openPrCount` is not exported).
- [ ] **Step 3: Implement** `openPrCount` with a doc comment saying it is the band's `N` and the rail's PRs count, so neither may compute it inline. Replace
  `PullRequestsView`'s `const open = shown.reduce(...)` with `openPrCount(data)`; keep `shown`/`hidden` as they are.
- [ ] **Step 4: Run** `pnpm exec jest test/github/pr-layouts-lib.test.ts test/github/prs-view.test.tsx`
  — expect PASS.
- [ ] **Step 5: Commit** `feat(client): openPrCount, one home for the open-PR sum`.

### Task 2: `lib/rail-counts.ts` — entries, tones, labels, the section sum

**Files:**
- Create: `client/src/lib/rail-counts.ts`
- Test: `test/ui/rail-counts-lib.test.ts`

**Interfaces:**
- Consumes: `openPrCount`, `needsYouCount` (PRs one, `lib/pr-layouts.ts`); `Section` from `lib/sections.ts`.
- Produces:
  - `type RailTone = 'warn' | 'neutral'`
  - `interface RailCount { n: number; tone: RailTone; label: string; onOpen?: () => void }`
  - `type SectionCounts = Partial<Record<string, RailCount>>`; `type RailCounts = Partial<Record<Section, SectionCounts>>`
  - `interface RailCountsInput { prs: PullRequestsPayload | null; liveRuns: number; jiraNeedsYou: number; openJiraNeedsYou?: () => void }`
  - `railCounts(input: RailCountsInput): RailCounts` — entries only for non-zero counts; a section with none is absent.
  - `sectionTotal(entries: SectionCounts | undefined, order: readonly string[]): RailCount | null` — `null` when no non-zero entry; `n` the sum; `tone`
    `warn` if any entry is; `label` the entries' labels in `order` joined by `; `; `onOpen` the entry's own when exactly one entry is present, else absent.

- [ ] **Step 1: Write the failing tests** (`describe('railCounts')`, `describe('sectionTotal')`):
  - All inputs zero / `prs: null` → `{}`.
  - PRs with 5 open, 0 need you → `github.prs` = `{ n: 5, tone: 'neutral', label: '5 open PRs' }`; 1 open → `'1 open PR'`.
  - PRs with 5 open, 1 needs you → tone `warn`, label `'5 open PRs, 1 needs you'`; 2 need you → `'5 open PRs, 2 need you'`; 1 open 1 needs you →
    `'1 open PR, 1 needs you'`.
  - `liveRuns: 1` → `runs.runs` = `{ n: 1, tone: 'neutral', label: '1 live run' }`; `2` → `'2 live runs'`.
  - `jiraNeedsYou: 3` with `openJiraNeedsYou: fn` → `jira.sessions` = `{ n: 3, tone: 'warn', label: '3 sessions need you', onOpen: fn }`; `1` →
    `'1 session needs you'`.
  - `sectionTotal(undefined, [...])` and `sectionTotal({}, [...])` → `null`.
  - Two entries `a` (2, neutral, `'A'`) and `b` (3, warn, `'B'`), order `['b', 'a']` → `{ n: 5, tone: 'warn', label: 'B; A' }` with no `onOpen`, even
    when both carry one.
  - One entry carrying `onOpen` → total carries that same function.
- [ ] **Step 2: Run** `pnpm exec jest test/ui/rail-counts-lib.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the module, header comment citing `.claude/DESIGN.md` §8.0 and the spec, saying why it is pure (testable without a rail) and why
  `onOpen` is an input rather than built here (the handler writes stores the rail owns).
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(client): rail-counts, per-page pending counts and the section sum`.

### Task 3: draw the counts in `SideRail` and `RailTree`, wire `App`

**Files:**
- Modify: `client/src/components/SideRail.tsx` (`Props.counts` at ~95, the Jira/GitHub/Runs count blocks at ~221-245, `RailTree` at ~360-410 and its five
  call sites)
- Modify: `client/src/App.tsx:364` (`counts={...}`), and drop the `needsYouCount` import at :24 if unused
- Modify: `client/src/styles.css` (`.rail-sublink` ~222 needs `width: 100%` once wrapped; nothing else new — reuse `.rail-group` and `.rail-count`)
- Test: `test/ui/rail.test.tsx` (rewrite `describe('the rail rows and footer')` count cases ~731-754; flip the Sessions case at ~668)

**Interfaces:**
- Consumes: `railCounts`, `sectionTotal`, `RailCount`, `SectionCounts` (Task 2).
- Produces: `SideRail`'s `counts?: { prs?: PullRequestsPayload | null; liveRuns?: number }` (replaces `{ github?: number; runs?: number }`); `App` passes
  `{ prs: prs.data, liveRuns: liveCount }`.

Behaviour:
- `SideRail` builds the map with `railCounts({ prs: counts?.prs ?? null, liveRuns: counts?.liveRuns ?? 0, jiraNeedsYou: useJiraNeedsYou(),
  openJiraNeedsYou })`, where `openJiraNeedsYou` is today's Jira badge click body (set page `sessions`, `setJiraListFilters({ chip: 'needs-you',
  allTickets: true })`, `onChange('jira')`, close menu).
- Top row: one render path for every section — `sectionTotal(map[id], <that section's page list>)`; with `onOpen` a `<button className="rail-count">`,
  otherwise a `<span className="rail-count" role="img">`; `aria-label` is the total's `label`; the pill is `<Pill tone={tone}>{n}</Pill>`. The three
  per-section blocks go.
- `RailTree` takes `counts?: SectionCounts`; each item becomes a `.rail-group` wrapper holding the sub-row button and, when the item has an entry, the same
  pill markup as the top row. Extract that pill markup into one small local component used by both, so the two cannot drift.
- Update the comments that describe the old counts (Props doc, the JSX comment above the count blocks) to the new rule.

- [ ] **Step 1: Rewrite/add the failing tests** in `test/ui/rail.test.tsx` (build PRs payloads with the same fixture shape `pr-layouts-lib.test.ts` uses):
  - GitHub top row with 3 open PRs, none needing you → a `neutral` pill `3`, named `3 open PRs`; with 1 needing you → `warn`, named `3 open PRs, 1 needs
    you`; `prs: null` → no pill.
  - GitHub open on `prs` page: the `GitHub pages` group's `PRs` row's wrapper holds a pill `3` with the same name; `Board`, `Archive`, `Settings` hold
    none.
  - Runs with `liveRuns: 2` → top-row neutral pill named `2 live runs`; open Runs tree → `History` row holds the same; `Watchdog`/`Ticks` none.
  - Replace the case at ~668: the open Jira tree's `Sessions` row holds a button named `1 session needs you`; clicking it sets page `sessions`, chip
    `needs-you`, `allTickets: true`; clicking the `Sessions` row itself still just sets the page.
  - Jira top-row badge cases (~519-680) keep passing unchanged where they assert name, click and the keep-last-count-while-unreachable behaviour.
  - Narrow (the `matchMedia` stub the file already uses at ~87): with Runs `liveRuns: 1`, the menu open, both the Runs top-row pill and the History sub pill
    draw.
  - A sub-row pill is a `.rail-count` inside a `.rail-group` (pins the click pass-through rule from the existing CSS test).
  - Zero everywhere → no `.rail-count` in the document.
- [ ] **Step 2: Run** `pnpm exec jest test/ui/rail.test.tsx` — expect the new cases to FAIL.
- [ ] **Step 3: Implement** per Behaviour above, and `App`'s new `counts` prop.
- [ ] **Step 4: Run** `pnpm exec jest test/ui/rail.test.tsx test/ui/rail-counts-lib.test.ts test/github/use-pull-requests.test.tsx
  test/orchestrator/orchestrator-hook.test.tsx test/ui/nav.test.tsx test/ui/shell-strip.test.tsx` and `pnpm run typecheck` — expect PASS. Before that,
  `grep -l` each symbol this task adds a caller of (`useJiraNeedsYou`, `railCounts`, `openPrCount`, `setJiraListFilters`) under `test/` and add every hit to
  the run.
- [ ] **Step 5: Commit** `feat(client): pending counts on rail sub-rows, summed on the top row`.

### Task 4: rewrite the docs the spec names

**Files:**
- Modify: `.claude/DESIGN.md` §8.0 **The counts** paragraph (~191-199)
- Modify: `.claude/rules/board.md` the poller bullet's "the rail counts PRs that need you on every page" (~170)
- Modify: `docs/superpowers/specs/2026-11-05-jira-sessions-page-design.md` C4 (~103): append one line that this spec supersedes "the Sessions tree entry
  carries no count"

- [ ] **Step 1:** Rewrite **The counts** to: per-page pills on sub-rows from `lib/rail-counts.ts`, the top row's sum, the tone rule in words, the copy table's
  forms, Jira's (and any `onOpen` entry's) pill as a real button while the rest are `role="img"` spans that let the click through, zero draws nothing,
  Jira keeps its last count while unreachable. Keep the placement sentences (`.rail-group`, 10 px in, centred). Name the new spec.
- [ ] **Step 2:** board.md: "the rail counts PRs that need you on every page" → "the rail counts open PRs on every page". C4 supersede line.
- [ ] **Step 3: Run** `grep -rn "PRs need you\|PRs that need you" .claude client/src docs/subsystems` — expect no hit that describes the rail (the PR
  page's own Needs-you level may stay). Run `pnpm exec jest test/guards` — expect PASS (some guards read DESIGN.md).
- [ ] **Step 4: Commit** `docs: rail pending counts in DESIGN.md and board rules`.

### Task 5: `/ui-verify`

- [ ] Invoke `/ui-verify` on the branch: no mock files exist (the user picked from text sketches in chat, spec "Decided with the user"); verify against the
  spec's sketch — GitHub `[5]` on the top row and on PRs, Runs `[2]` on the top row and History — with fixture or live data, at desktop and 375 px, in light
  theme. Check the sub-row pill sits inside the 28 px row without growing it, and a 3-digit count does not overlap the label. Fix defects on the branch.
