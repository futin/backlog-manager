# Jira Mentions ↔ Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan states behaviour, signatures and exact test cases — never literal code** (user rule, overrides the writing-plans template's code blocks). Write
> the bodies yourself; if a stated signature or value looks wrong against the code, say so in your report rather than transcribing it.

**Goal:** Board cards, lane headers, List rows and the ticket strip mark tickets with open mentions and open the mention modal over the page; the Mentions
page and its modal open the ticket page.

**Architecture:** One `useJiraMentions` instance moves into a shell-level `JiraMentionsProvider` (gated on the Jira section being open); a
`MentionModalHost` composes `JiraMentionModal` from the contexts for both the Mentions page and `JiraView`; `JiraView` owns a `mentionOpen` slot exposed to
the board through a small open-context, so the marker needs no prop threading.

**Tech Stack:** React 18 + TypeScript (client), Jest + Testing Library (jsdom suites under `test/jira/`, `test/ui/`).

**Spec:** `docs/superpowers/specs/2026-11-24-jira-mentions-board-link-design.md` — read it in full before any task; section numbers below (§1–§4) are its.

## Global Constraints

- Client-only: no change to `shared/types.ts`, `server/`, the board's poll or any route.
- `useJiraMentions` is called in exactly ONE place after Task 2: `JiraMentionsProvider`.
- Marker words: label `@ N`; `title` and accessible name `1 mention waits for your answer` / `<n> mentions wait for your answer`.
- Mention → ticket control is worded `Open ticket page` everywhere (never `Open ticket`); the list row's icon chip uses glyph `document`.
- The mention modal never mounts over another modal (spec §4).
- Comments explain why, at the repo's density; every new component cites its `.claude/DESIGN.md` subsection in its header (`board.md`).
- Before reading or editing under `client/src/**`, `.claude/rules/board.md` applies; under `test/**`, `.claude/rules/tests.md`. Fixture dates relative
  (`test/helpers/dates.ts` or `Date.now()` offsets), never literals, for `created`/`updated` keys in `.test.tsx`.
- Commit after each task: `git add <paths>` then `git commit` (separate commands), message `feat(jira): …` / `docs(jira): …` ending
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run only the suites a task touches: `pnpm exec jest <paths>`; `pnpm run typecheck` at the end of every task.

## Review Focus

1. **Dismiss from the board clears the marker on the same render, with no extra GET** — the shared-payload promise. Test in Task 5.
2. **Keyboard / middle-click on the marker inside a card must not open Detail or the ticket page.** Test in Task 5.
3. **Leaving the Jira section stops reads; re-entering reads once at once and shows the old markers meanwhile.** Tests in Task 1 (hook) and Task 2
   (provider edge, and `App` making no mentions GET off the Jira section).
4. **The strip marker inside an open `JiraDetail` leaves exactly one dialog mounted.** Test in Task 5.
5. **A ticket with only dismissed mentions, or a payload with `polledAt: null`, draws no marker.** Test in Task 5.

---

### Task 1: `useJiraMentions` gains `enabled` and the status-newer trigger

**Files:**
- Modify: `client/src/hooks/useJiraMentions.ts` (the `useJiraMentions` signature, its mount effect, `useWindowFocus` call; header comment)
- Test: `test/jira/use-jira-mentions.test.tsx`

**Interfaces:**
- Produces: `useJiraMentions(opts?: { enabled?: boolean }): JiraMentionsState` — `enabled` defaults to `true` (existing callers/tests unchanged).

- [ ] **Step 1: Write failing tests** (reuse the file's `payload`, `res`, `fetchMock`, `JiraContext` tree; let `Probe` take `enabled` and a status
  `mentions.polledAt` from test-level variables):
  - `enabled: false` from mount → after advancing timers by `JIRA_STATUS_FLOOR_MS * 3`, `fetchMock` called 0 times; a window `focus` event → still 0.
  - mount enabled, first GET lands, then rerender with `enabled: false` → advancing past `polledAt + JIRA_MENTIONS_POLL_MS + TRACKER_FETCH_SLACK_MS`
    makes no further call, and `last.data` is still the first payload (kept, not cleared).
  - then rerender `enabled: true` → exactly one GET at once (before any timer advance).
  - status-newer trigger: mount enabled, GET answers `polledAt = iso(60_000)`; rerender with the status payload's `mentions.polledAt = iso(1_000)`
    (later) → exactly one additional GET; rerender again with the same status → no further GET; a status `mentions.polledAt` equal to or older than the
    payload's → no GET.
  - status-newer trigger while `enabled: false` → no GET.
  - a `dismiss` started while enabled whose POST answers after a rerender with `enabled: false` → the answer still lands in `data`, but advancing timers
    past its `polledAt + JIRA_MENTIONS_POLL_MS + TRACKER_FETCH_SLACK_MS` makes no GET (the answer does not re-arm the timer while disabled).
- [ ] **Step 2:** `pnpm exec jest test/jira/use-jira-mentions.test.tsx` — the new cases FAIL, the old ones pass.
- [ ] **Step 3: Implement.** While disabled: no reload on mount, no timer, focus is a no-op, state kept; the false → true edge calls `reload()` once; true →
  false clears the timer and retires in-flight reads (bump the sequence counter) so a late answer neither writes nor re-arms. Every place that arms the timer
  must respect the flag: the GET's success branch, its failure branch (`setTimeout(reload, JIRA_STATUS_FLOOR_MS)`, ~:107) and `landed` (~:132, a write's
  answer) — read the flag through a ref so the callbacks stay stable, and make `reload` itself a no-op while disabled. A write's answer still replaces
  `data` and still calls `reloadStatus`. The status-newer trigger is an
  effect on `status.data?.mentions?.polledAt` vs `state.data.polledAt` (parse both; only strictly later fires) calling the same `reload`. Update the header
  comment: the new input and trigger, and that the hook's one caller is the provider (Task 2).
- [ ] **Step 4:** same command — all pass. `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(jira): gate the mentions poll and follow a newer status stamp`.

### Task 2: `JiraMentionsProvider` in the shell; the Mentions page reads it

**Files:**
- Create: `client/src/hooks/JiraMentionsContext.tsx`
- Modify: `client/src/App.tsx:433` area (mount inside `JiraSessionsProvider`), `client/src/components/jira/JiraMentionsView.tsx` (header + the
  `useJiraMentions()` call at :71)
- Test: Create `test/jira/jira-mentions-provider.test.tsx`; Modify `test/jira/jira-mentions-page.test.tsx`, `test/jira/jira-mention-modal.test.tsx` (wrap
  their mounts in the provider wherever they mount `JiraMentionsView`)

**Interfaces:**
- Consumes: `useJiraMentions({ enabled })` (Task 1).
- Produces:
  - `JiraMentionsContext` (the exported context object, as `JiraSessionsContext.tsx` exports its own) — tests mount stub values through it.
  - `JiraMentionsProvider({ enabled, children }: { enabled: boolean; children: ReactNode })`
  - `useJiraMentionsContext(): JiraMentionsState` — default value: `data: null`, `loading: false`, `error: null`, `checking: false`, `reload`/`sweep` no-ops,
    every write resolving `{ ok: false, message: 'mentions unavailable' }`; never fetches.
  - `useMentionIndex(): ReadonlyMap<string, JiraMentionIssue>` — built with `useMemo` from `data.issues` only; EMPTY when `data` is null, unconfigured, or
    `polledAt` is null.

- [ ] **Step 1: Write failing tests** (`jira-mentions-provider.test.tsx`, jsdom):
  - two consumers under one provider (`enabled: true`) → `fetchMock` called once at mount; both read the same `data` object (`toBe`).
  - `enabled: false` → 0 calls; consumers read `data: null`.
  - provider rerendered `true` → `false` → `true` (first GET landed) → exactly 2 GETs in all, and while `false` the consumers still read the first payload.
  - a consumer with no provider → `data: null`, 0 calls; its `dismiss('PAY-1', ['1'])` resolves `{ ok: false }`.
  - `useMentionIndex`: payload with `issues` `[PAY-1 (2 mentions), PAY-2 (1)]` and `dismissed` `[PAY-3]` → map has keys `PAY-1`, `PAY-2` only, `get('PAY-1')
    .mentions.length === 2`; same payload with `polledAt: null` → size 0.
  - a source guard (same file, `fs.readFileSync` over `client/src/**/*.ts(x)`): `useJiraMentions(` appears in exactly one file outside
    `hooks/useJiraMentions.ts`, and it is `hooks/JiraMentionsContext.tsx`.
  - App level (add to `test/jira/jira-sections.test.tsx`, which already mounts `App` with Jira configured): with the section on Files (or GitHub), no
    request to `/api/jira/mentions` is made; switching to Jira makes exactly one.
- [ ] **Step 2:** `pnpm exec jest test/jira/jira-mentions-provider.test.tsx` — FAIL (module missing).
- [ ] **Step 3: Implement** the context file (`JiraSessionsContext.tsx`'s shape and header style), mount it in `App` with
  `enabled={jiraConfigured === true && section === 'jira'}`, switch `JiraMentionsView` to `useJiraMentionsContext()`, and rewrite its "One read per page
  mount" header paragraph to "one read for the section — the provider is the one caller".
- [ ] **Step 4:** `pnpm exec jest test/jira/jira-mentions-provider.test.tsx test/jira/jira-mentions-page.test.tsx test/jira/jira-mention-modal.test.tsx
  test/jira/use-jira-mentions.test.tsx test/ui/rail.test.tsx` — all pass (page suites wrapped in the provider). `grep -rl "useJiraMentions\|JiraMentionsView"
  test/` and `grep -rl "src/App'" test/` (every suite that mounts `App` now sees a mentions GET on the Jira section — today: shell-strip, deep-link-app,
  section-settle-race, nav, releases-app, source-sections, board-run-chip, jira-chip, jira-ticket-page, jira-sections) and add every hit to this run.
  `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(jira): one shared mentions poll for the Jira section`.

### Task 3: `warn` chip variant, `MentionMark`, and its words

**Files:**
- Modify: `client/src/components/ui/Chip.tsx` (`ChipVariant` gains `'warn'`; header names it), `client/src/styles.css` (one `.ui-chip-warn` rule, plus
  its `:hover:not(:disabled)`, beside `.ui-chip-danger` ~:4271), `client/src/lib/jira-mentions.ts`
- Create: `client/src/components/ui/MentionMark.tsx`
- Test: `test/ui/ui-chip.test.tsx`, `test/jira/jira-mentions-lib.test.ts`, Create `test/ui/ui-mention-mark.test.tsx`

**Interfaces:**
- Produces:
  - `mentionMarkText(n: number): { label: string; title: string }` in `lib/jira-mentions.ts`.
  - `MentionMark({ count, onOpen }: { count: number; onOpen: () => void })` — renders `null` for `count <= 0`; otherwise `Chip variant="warn" size={28}`
    with `label`, `title` and `aria-label` = `title`. Its wrapper stops `click`, `auxclick` and Enter/Space `keydown` propagation (`JiraCard`'s `Contained`
    pattern); the click calls `onOpen`.

- [ ] **Step 1: Write failing tests:**
  - lib: `mentionMarkText(1)` → `{ label: '@ 1', title: '1 mention waits for your answer' }`; `mentionMarkText(3)` → `{ label: '@ 3', title: '3 mentions
    wait for your answer' }`.
  - chip: `<Chip variant="warn">x</Chip>` has classes `ui-chip` and `ui-chip-warn`.
  - mark: `count={0}` renders nothing; `count={2}` renders a button named `2 mentions wait for your answer` with text `@ 2`; clicking it calls `onOpen` once
    and a parent `onClick` spy 0 times; middle-click (`auxclick`, button 1) → parent `onAuxClick` spy 0 times; Enter and Space `keyDown` → parent
    `onKeyDown` spy 0 times.
- [ ] **Step 2:** run the three suites — FAIL.
- [ ] **Step 3: Implement.** `.ui-chip-warn`: the warn pill's tint and `--amber-ink` word (read `.ui-pill` warn's rule for the exact colours) on the
  `.ui-chip` base. `MentionMark` header cites DESIGN.md §7 and §8.9.7.
- [ ] **Step 4:** run the three suites plus `test/guards/design-guards.test.ts` and `test/guards/daylight-contrast.test.ts` — pass. `grep -rl "Chip"
  test/guards` and add hits. `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(ui): warn chip variant and the mention mark`.

### Task 4: `MentionModalHost`, the open-context and the mark connector

**Files:**
- Create: `client/src/components/jira/MentionModalHost.tsx`, `client/src/components/jira/JiraMentionMarkFor.tsx`,
  `client/src/components/jira/MentionOpenContext.tsx` (the open-context's ONLY home — not `JiraView.tsx`, which would close an import cycle
  `JiraView → JiraBoardView → JiraLaneBoard → JiraCard → JiraMentionMarkFor → JiraView`)
- Modify: `client/src/components/jira/JiraMentionsView.tsx` (render the host instead of its inline `JiraMentionModal` wiring, :221 on; its own walk —
  `opened`, `lastAt`, `byTicket`, `mentionStepIndex` — stays). `JiraView.tsx` is Task 5's.
- Test: Create `test/jira/jira-mention-host.test.tsx`; existing `test/jira/jira-mentions-page.test.tsx` and `jira-mention-modal.test.tsx` must stay green.
  The `JiraView`-level cases (open from a card, the walk, Dismiss, the Detail swap) are Task 5's, once a real home draws the mark.

**Interfaces:**
- Consumes: `JiraMentionsContext`, `useJiraMentionsContext`, `useMentionIndex` (Task 2), `MentionMark` (Task 3), `useJiraSessionsContext`.
- Produces:
  - `MentionModalHost(props: { issue: JiraMentionIssue; mention: JiraMention; position: { at: number; of: number } | null; onPrev: (() => void) | null;
    onNext: (() => void) | null; onClose: () => void; onOpenPage: ((key: string) => void) | null })` — derives `state` (`open` if the key is in
    `data.issues`, `dismissed` if in `data.dismissed`, else `gone`), the live issue, repos, session link and every write from the contexts, exactly as
    `JiraMentionsView` does today. It ACCEPTS `onOpenPage` but does not forward it yet — `JiraMentionModal` has no such prop until Task 6, which wires it.
  - `MentionOpenContext` + `useOpenMention(): ((key: string) => void) | null` exported from `MentionOpenContext.tsx` — `null` outside a provider;
    `JiraView` provides it.
  - `JiraMentionMarkFor({ issueKey }: { issueKey: string })` — reads `useMentionIndex().get(issueKey)` and `useOpenMention()`; renders `MentionMark` with
    the entry's `mentions.length` when both exist, else `null`.

- [ ] **Step 1: Write failing tests** (`jira-mention-host.test.tsx`: `MentionModalHost` under a stub `JiraMentionsContext` value and the sessions
  context; mentions payload `issues: [PAY-1 (m2 newer, m1), PAY-4 (m9)]`, `dismissed: [PAY-3 (m5)]`):
  - host for `{ PAY-1, m2 }` with position `{ at: 1, of: 2 }` → one dialog showing `Mention 1 of 2` and m2's excerpt, the open footer (Dismiss present).
  - host for `{ PAY-3, m5 }` → the Dismissed footer (Restore present).
  - host for a key in neither list → the gone state, as `JiraMentionsView` draws it today.
  - context `data` swapped to a payload where PAY-1 moved to `dismissed` → on that render the host shows the Dismissed footer (live re-read, no remount).
  - `JiraMentionMarkFor issueKey="PAY-1"` under a `MentionOpenContext` spy → `@ 2`, click → spy called with `'PAY-1'`; `issueKey="PAY-4"` → `@ 1`;
    `"PAY-3"` → nothing; no `MentionOpenContext` provider → nothing.
  - the Mentions page still opens its modal from a row and walks rows in List order (existing page suites cover this; they must pass unchanged).
- [ ] **Step 2:** run the new suite — FAIL.
- [ ] **Step 3: Implement** the three files. Move `JiraMentionsView`'s modal wiring into the host without changing the page's walk; update
  `JiraMentionsView`'s walk paragraph (~:56-68: the modal is now drawn by `MentionModalHost`; the walk stays here).
- [ ] **Step 4:** `pnpm exec jest test/jira/jira-mention-host.test.tsx test/jira/jira-mentions-page.test.tsx test/jira/jira-mention-modal.test.tsx
  test/ui/ui-modal.test.tsx` — pass. `grep -rl "JiraMentionModal\|JiraMentionsView" test/` and add hits. `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(jira): a mention modal host and the mark connector`.

### Task 5: The marker's four homes and `JiraView`'s mention slot

**Files:**
- Modify: `client/src/components/jira/JiraView.tsx` (the mention slot, the opener provided through `MentionOpenContext`, the board walk, the Detail
  swap, header paragraphs), `client/src/components/jira/JiraCard.tsx` (in `.jira-card-head` after `.jira-card-key`, before the crumb), `JiraLaneHeader.tsx` (the
  `data-kind="board"` head, beside its key, ~:150), `JiraIssueList.tsx` (`IssueRow` and the board-header row: summary cell after the title, before
  `jira-issues-under`; NOT the `none`/`off` lane rows), `JiraTicketStrip.tsx` (a last `Cell label="Mentions"` after `Agent`, only when the key has an entry)
- Test: `test/jira/jira-board.test.tsx`, `test/jira/jira-list.test.tsx`, `test/jira/jira-ticket-body.test.tsx` (strip); Create
  `test/jira/jira-mention-board.test.tsx` (the `JiraView`-level cases)

**Interfaces:**
- Consumes: `JiraMentionsContext`, `useMentionIndex` (Task 2); `MentionModalHost`, `MentionOpenContext`, `JiraMentionMarkFor` (Task 4). Each home renders `<JiraMentionMarkFor issueKey={…} />` with its ticket's key (the strip's is `src.key`); the strip wraps it in its `Cell` only when the
  index has the key (read `useMentionIndex` there too, so an empty cell never draws).

- [ ] **Step 1: Write failing tests** (each suite wraps its mount in the mentions provider/context with a stubbed payload, plus an opener spy via
  `MentionOpenContext`):
  - card for PAY-1 (2 open mentions) → button `2 mentions wait for your answer` inside `.jira-card-head`; click → opener spy called with `'PAY-1'`, the
    card's `onOpen` spy 0 calls; Enter on the focused mark → `onOpen` 0 calls; middle-click → `onOpenPage` 0 calls.
  - card for PAY-2 (no entry) → no mark. Card for PAY-3 (only in `dismissed`) → no mark. Payload `polledAt: null` → no mark on PAY-1.
  - lane header for a parent PAY-10 with 1 mention → `1 mention waits for your answer` in the header; click → opener spy called with `'PAY-10'`.
  - List: a card row PAY-1 and the board-header row PAY-10 each draw the mark in the summary cell (head row: after the title, before the `FoldMark` chip);
    the `No parent` lane row draws none. Clicking PAY-1's mark → opener spy with `'PAY-1'` and the row's `onOpenIssue` spy 0 calls.
  - strip for PAY-1 → a `Mentions` cell holding `@ 2`, after the `Agent` cell; for PAY-2 → no `Mentions` cell.
  - `jira-mention-board.test.tsx`: mount `JiraView` on the Board page with stubbed fetches — board payload holding PAY-1, PAY-2 and PAY-4; mentions payload
    `issues: [PAY-1 (m2 newer, m1), PAY-4 (m9)]`, `dismissed: []`:
    - PAY-1's card mark → one dialog, `Mention 1 of 2`, m2's excerpt; Next → `Mention 2 of 2`, m1. Close; PAY-4's card mark → `Mention 1 of 1`, m9's
      excerpt (the opener honours its key).
    - Dismiss in PAY-1's dialog → the stubbed POST answers a payload with PAY-1 in `dismissed`; on that render PAY-1's `@ 2` mark is gone, PAY-4's `@ 1`
      stays, the dialog shows its Dismissed footer with no position, and the mentions GET count did not increase.
    - mentions payload refreshed with a third mention m3 (newest) on PAY-1 while the dialog shows m2 → position reads `Mention 2 of 3`.
    - open `JiraDetail` for PAY-1 (plain click on its card), then click the strip's mark inside it → exactly one element with `role="dialog"` is in the
      document, and it is the mention modal; Escape → zero dialogs.
    - switching the Jira page (e.g. to Sessions) clears the slot: no mention dialog.
- [ ] **Step 2:** run those suites — FAIL.
- [ ] **Step 3: Implement** the four placements, then `JiraView`: it holds `mentionOpen: { issue: JiraMentionIssue; mention: JiraMention } | null`,
  reset on page change with `walk` and `launch`, and provides `MentionOpenContext` around its pages and Detail. The opener for a key: look the key up in
  the index; if found, `setWalk([])` and set the slot to `{ issue, mention: issue.mentions[0] }` in the same handler. The board walk per spec §4: order =
  the live entry's `mentions` (newest first), position from the shown mention's `commentId` in it, no position/neighbours when absent. Render
  `MentionModalHost` after the Detail and before the launch sheet; its `onOpenPage` is Task 6's rule (pass `null` for now). Headers: `JiraView`'s
  paragraphs at ~:78 and ~:84-85 that name its modal slots — add the mention slot, the swap, why never stacked.
- [ ] **Step 4:** run the suites above plus `test/jira/jira-mention-host.test.tsx`, `test/jira/jira-strip-css.test.ts` and
  `test/guards/design-guards.test.ts`; `grep -rl
  "JiraCard\|JiraLaneHeader\|JiraIssueList\|JiraTicketStrip\|JiraView" test/` and add hits (include `test/jira/jira-detail.test.tsx` and
  `test/jira/jira-ticket-page.test.tsx`). `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(jira): mark tickets with open mentions on the board`.

### Task 6: `Open ticket page` from the Mentions page and the modal

**Files:**
- Modify: `client/src/components/jira/JiraMentionList.tsx` (icon chip before `Open in Jira` ~:160; Cmd/Ctrl/middle-click on the key button),
  `JiraMentionCards.tsx` (text chip before `Reply in Jira`), `JiraMentionModal.tsx` (remove the `noBoard` note ~:383; a text chip from `issue.key`
  outside `TicketFacts`, in every detail state), `JiraMentionsView.tsx` (takes `onOpenPage: (key: string) => void`), `MentionModalHost.tsx`, `JiraView.tsx`
- Test: `test/jira/jira-mentions-page.test.tsx`, `test/jira/jira-mention-modal.test.tsx`, `test/jira/jira-mention-board.test.tsx`

**Interfaces:**
- Consumes: `JiraView`'s existing `openPage(key)`; `MentionModalHost`'s `onOpenPage` (Task 4).
- Produces: `JiraMentionModal` prop `onOpenPage: (() => void) | null` (null draws no chip); `JiraMentionList`/`JiraMentionCards` prop
  `onOpenPage: (issue: JiraMentionIssue) => void`.

- [ ] **Step 1: Write failing tests:**
  - List row PAY-1: button named `Open ticket page` (title the same) sits before `Open in Jira` in the action cell and contains the `document` glyph; click →
    `onOpenPage` with PAY-1. Cmd-click, Ctrl-click and middle-click on the row's key → `onOpenPage`, and the mention modal does NOT open; a plain click
    still opens it. The modifier decision is `wantsPage` (`client/src/lib/open-intent.ts`), as `JiraCard` and `IssueRow` use it. A dismissed row (Show
    dismissed on) offers the chip too.
  - Cards: `Open ticket page` text chip before `Reply in Jira`; a dismissed card (Show dismissed on) offers it too.
  - Modal: `Open ticket page` present while the detail read is pending, after it fails, and once it is `ok`; the text `the board cannot open it` is absent;
    `· on none of your boards` still in the head for a `boards: []` ticket. Click → modal's `onClose` then `onOpenPage`.
  - Through `JiraView` on the Mentions page: clicking a row's `Open ticket page` → the page is `ticket`, the key store holds PAY-1, origin `mentions`.
  - Through `JiraView`: mention modal opened from the strip on the ticket page of PAY-1 → `Open ticket page` only closes (page stays, key unchanged); opened
    from a Board card → page `ticket`, origin `board`; from a `JiraDetail` opened on Sessions → origin `sessions`.
- [ ] **Step 2:** run the three suites — FAIL.
- [ ] **Step 3: Implement.** `JiraView` passes `openPage` to `JiraMentionsView`, and to the host: `null`-free function that closes the slot and either does
  nothing more (ticket page, same key) or calls `openPage(key)`. The host now forwards `onOpenPage` to `JiraMentionModal`. Headers: `JiraView`'s links
  paragraph and `JiraMentionsView`'s gain the Mentions → ticket-page link; `JiraMentionModal`'s loses the "board cannot open it" wording; `JiraMentionList`'s
  actions paragraph names the new chip.
- [ ] **Step 4:** run the three suites plus `test/jira/jira-ticket-page.test.tsx`, `test/jira/jira-ticket-store.test.tsx`, `test/jira/ticket-url.test.ts`;
  `grep -rl "openPage\|JiraMentionList\|JiraMentionCards" test/` and add hits. `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(jira): open the ticket page from a mention`.

### Task 7: Rules and docs

**Files:**
- Modify: `.claude/rules/board.md` (client-poller bullet: `useJiraMentions` called once, by `JiraMentionsProvider`, gated on the section, plus the
  status-newer trigger; the Jira-pages links bullet gains the Mentions row/card/modal `Open ticket page`; the mention modal's homes and never-stacked rule
  wherever `board.md` lists `Modal`'s composers), `.claude/DESIGN.md` (§7 the `warn` chip; §8.9.1 the mark on card, lane header and List rows; §8.9.7
  `Open ticket page` and the mark), `docs/subsystems/invariants.md` (the Escape-stack paragraph "It opens from the Mentions page and over nothing else"),
  `docs/subsystems/jira.md` (~:276 client paragraph: provider as the hook's caller), `docs/superpowers/specs/2026-11-16-jira-mentions-design.md` (one-line
  "Superseded in part by `2026-11-24-jira-mentions-board-link-design.md`" at its "board cannot open it" bullet)
- Test: `test/guards/claude-rules.test.ts`

- [ ] **Step 1:** edit each doc; new prose wraps at 160 columns; do not reflow untouched text.
- [ ] **Step 2:** `pnpm exec jest test/guards/claude-rules.test.ts test/guards/design-guards.test.ts test/guards/dialog-count-docs.test.ts` — pass
  (the last reads exactly the Escape passages edited here; the dialog count stays ten — no new dialog, the mention modal only gains a home).
- [ ] **Step 3:** commit `docs(jira): rules and design for the mentions ↔ board link`.

### Task 8: `/ui-verify`

- [ ] Run `/ui-verify` on the live board (no mocks — check against spec §2–§4 and DESIGN.md): a card, a lane header, a List card row and header row, the
  strip in `JiraDetail` and on the ticket page, each with a mark; the mention modal opened from each (one dialog only from Detail); `Open ticket page` from
  a Mentions row, card and modal landing on the ticket page with the right `←` label. Fix defects on the branch; record anything it could not reach (e.g.
  no live mentions) as unverified.
