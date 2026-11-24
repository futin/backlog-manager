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

1. **Dismiss from the board clears the marker on the same render, with no extra GET** — the shared-payload promise. Test in Task 4.
2. **Keyboard / middle-click on the marker inside a card must not open Detail or the ticket page.** Test in Task 5.
3. **Leaving the Jira section stops reads; re-entering reads once at once and shows the old markers meanwhile.** Test in Task 2.
4. **The strip marker inside an open `JiraDetail` leaves exactly one dialog mounted.** Test in Task 4.
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
- [ ] **Step 2:** `pnpm exec jest test/jira/use-jira-mentions.test.tsx` — the new cases FAIL, the old ones pass.
- [ ] **Step 3: Implement.** While disabled: no reload on mount, no timer, focus is a no-op, state kept; the false → true edge calls `reload()` once; true →
  false clears the timer and retires in-flight reads (bump the sequence counter) so a late answer neither writes nor re-arms. The status-newer trigger is an
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
  - `JiraMentionsProvider({ enabled, children }: { enabled: boolean; children: ReactNode })`
  - `useJiraMentionsContext(): JiraMentionsState` — default value: `data: null`, `loading: false`, `error: null`, `checking: false`, `reload`/`sweep` no-ops,
    every write resolving `{ ok: false, message: 'mentions unavailable' }`; never fetches.
  - `useMentionIndex(): ReadonlyMap<string, JiraMentionIssue>` — built with `useMemo` from `data.issues` only; EMPTY when `data` is null, unconfigured, or
    `polledAt` is null.

- [ ] **Step 1: Write failing tests** (`jira-mentions-provider.test.tsx`, jsdom):
  - two consumers under one provider (`enabled: true`) → `fetchMock` called once at mount; both read the same `data` object (`toBe`).
  - `enabled: false` → 0 calls; consumers read `data: null`.
  - a consumer with no provider → `data: null`, 0 calls; its `dismiss('PAY-1', ['1'])` resolves `{ ok: false }`.
  - `useMentionIndex`: payload with `issues` `[PAY-1 (2 mentions), PAY-2 (1)]` and `dismissed` `[PAY-3]` → map has keys `PAY-1`, `PAY-2` only, `get('PAY-1')
    .mentions.length === 2`; same payload with `polledAt: null` → size 0.
  - a source guard (same file, `fs.readFileSync` over `client/src/**/*.ts(x)`): `useJiraMentions(` appears in exactly one file outside
    `hooks/useJiraMentions.ts`, and it is `hooks/JiraMentionsContext.tsx`.
- [ ] **Step 2:** `pnpm exec jest test/jira/jira-mentions-provider.test.tsx` — FAIL (module missing).
- [ ] **Step 3: Implement** the context file (`JiraSessionsContext.tsx`'s shape and header style), mount it in `App` with
  `enabled={jiraConfigured === true && section === 'jira'}`, switch `JiraMentionsView` to `useJiraMentionsContext()`, and rewrite its "One read per page
  mount" header paragraph to "one read for the section — the provider is the one caller".
- [ ] **Step 4:** `pnpm exec jest test/jira/jira-mentions-provider.test.tsx test/jira/jira-mentions-page.test.tsx test/jira/jira-mention-modal.test.tsx
  test/jira/use-jira-mentions.test.tsx test/ui/rail.test.tsx` — all pass (page suites wrapped in the provider). `grep -l "useJiraMentions\|JiraMentionsView"
  test/` and add any other hit to this run. `pnpm run typecheck`.
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
- [ ] **Step 4:** run the three suites plus `test/guards/design-guards.test.ts` and `test/guards/daylight-contrast.test.ts` — pass. `grep -l "Chip"
  test/guards` and add hits. `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(ui): warn chip variant and the mention mark`.

### Task 4: `MentionModalHost`, `JiraView`'s mention slot, and the board walk

**Files:**
- Create: `client/src/components/jira/MentionModalHost.tsx`, `client/src/components/jira/JiraMentionMarkFor.tsx`
- Modify: `client/src/components/jira/JiraMentionsView.tsx` (render the host instead of its inline `JiraMentionModal` wiring, :221 on; its own walk —
  `opened`, `lastAt`, `byTicket`, `mentionStepIndex` — stays), `client/src/components/jira/JiraView.tsx` (slot, open-context, header paragraph)
- Test: Create `test/jira/jira-mention-board.test.tsx`; existing `test/jira/jira-mentions-page.test.tsx` and `jira-mention-modal.test.tsx` must stay green

**Interfaces:**
- Consumes: `useJiraMentionsContext`, `useMentionIndex` (Task 2), `MentionMark` (Task 3), `useJiraSessionsContext`.
- Produces:
  - `MentionModalHost(props: { issue: JiraMentionIssue; mention: JiraMention; position: { at: number; of: number } | null; onPrev: (() => void) | null;
    onNext: (() => void) | null; onClose: () => void; onOpenPage: ((key: string) => void) | null })` — derives `state` (`open` if the key is in
    `data.issues`, `dismissed` if in `data.dismissed`, else `gone`), the live issue, repos, session link and every write from the contexts, exactly as
    `JiraMentionsView` does today, and passes `onOpenPage` through to the modal (Task 6 draws it).
  - `MentionOpenContext` + `useOpenMention(): ((key: string) => void) | null` exported from `JiraView.tsx` (or a sibling file) — `null` outside `JiraView`.
  - `JiraMentionMarkFor({ issueKey }: { issueKey: string })` — reads `useMentionIndex().get(issueKey)` and `useOpenMention()`; renders `MentionMark` with
    the entry's `mentions.length` when both exist, else `null`.

- [ ] **Step 1: Write failing tests** (`jira-mention-board.test.tsx`: mount `JiraView` on the Board page with stubbed fetches — board payload holding
  `PAY-1` and `PAY-2`; mentions payload `issues: [PAY-1 with mentions m2 (newer), m1]`, `dismissed: []`):
  - on the Board, a `JiraMentionMarkFor issueKey="PAY-1"` rendered inside the tree (use a card once Task 5 lands; for now mount the component directly
    under `JiraView`'s context in the test) → clicking it opens one dialog showing `Mention 1 of 2` and m2's excerpt; Next → `Mention 2 of 2`, m1.
  - Dismiss in that dialog → the stubbed POST answers a payload with PAY-1 in `dismissed`; on the next render the `@ 2` mark is gone, the dialog shows its
    Dismissed footer with no position, and the mentions GET count did not increase.
  - mentions payload refreshed with a third mention m3 on PAY-1 while the dialog shows m2 → position reads `Mention 2 of 3`.
  - open `JiraDetail` for PAY-1, then click the mark inside it → exactly one element with `role="dialog"` is in the document, and it is the mention modal;
    Escape → zero dialogs.
  - switching the Jira page (e.g. to Sessions) clears the slot: no mention dialog.
  - the Mentions page still opens its modal from a row and walks rows in List order (existing page suites cover this; they must pass unchanged).
- [ ] **Step 2:** run the new suite — FAIL.
- [ ] **Step 3: Implement.** `JiraView` holds `mentionOpen: { issue: JiraMentionIssue; mention: JiraMention } | null`, reset on page change with `walk` and
  `launch`. The provided opener for a key: look the key up in the index; if found, `setWalk([])` and set the slot to `{ issue, mention: issue.mentions[0] }`
  in the same handler. The board walk per spec §4: order = the live entry's `mentions` (newest first), position from the shown mention's `commentId` in it,
  no position/neighbours when absent. Render `MentionModalHost` after the Detail and before the launch sheet; its `onOpenPage` is Task 6's rule (pass
  `null` for now). Move `JiraMentionsView`'s modal wiring into the host without changing the page's walk. Update `JiraView`'s header comment (the slot, the
  swap, why never stacked).
- [ ] **Step 4:** `pnpm exec jest test/jira/jira-mention-board.test.tsx test/jira/jira-mentions-page.test.tsx test/jira/jira-mention-modal.test.tsx
  test/jira/jira-detail.test.tsx test/jira/jira-ticket-page.test.tsx test/ui/ui-modal.test.tsx` — pass. `grep -l "JiraMentionModal\|JiraView" test/` and
  add hits. `pnpm run typecheck`.
- [ ] **Step 5:** commit `feat(jira): open the mention modal over the board`.

### Task 5: The marker's four homes

**Files:**
- Modify: `client/src/components/jira/JiraCard.tsx` (in `.jira-card-head` after `.jira-card-key`, before the crumb), `JiraLaneHeader.tsx` (the
  `data-kind="board"` head, beside its key, ~:150), `JiraIssueList.tsx` (`IssueRow` and the board-header row: summary cell after the title, before
  `jira-issues-under`; NOT the `none`/`off` lane rows), `JiraTicketStrip.tsx` (a last `Cell label="Mentions"` after `Agent`, only when the key has an entry)
- Test: `test/jira/jira-board.test.tsx`, `test/jira/jira-list.test.tsx`, `test/jira/jira-ticket-body.test.tsx` (strip), and `jira-mention-board.test.tsx`
  (switch its direct mount to a real card)

**Interfaces:**
- Consumes: `JiraMentionMarkFor` (Task 4). Each home renders `<JiraMentionMarkFor issueKey={issue.key} />`; the strip wraps it in its `Cell` only when the
  index has the key (read `useMentionIndex` there too, so an empty cell never draws).

- [ ] **Step 1: Write failing tests** (each suite wraps its mount in the mentions provider/context with a stubbed payload, plus an opener spy via
  `MentionOpenContext`):
  - card for PAY-1 (2 open mentions) → button `2 mentions wait for your answer` inside `.jira-card-head`; click → opener spy called with `'PAY-1'`, the
    card's `onOpen` spy 0 calls; Enter on the focused mark → `onOpen` 0 calls; middle-click → `onOpenPage` 0 calls.
  - card for PAY-2 (no entry) → no mark. Card for PAY-3 (only in `dismissed`) → no mark. Payload `polledAt: null` → no mark on PAY-1.
  - lane header for a parent PAY-10 with 1 mention → `1 mention waits for your answer` in the header; clicking it does not toggle the lane.
  - List: a card row PAY-1 and the board-header row PAY-10 each draw the mark in the summary cell; the `No parent` lane row draws none.
  - strip for PAY-1 → a `Mentions` cell holding `@ 2`, after the `Agent` cell; for PAY-2 → no `Mentions` cell.
- [ ] **Step 2:** run those suites — FAIL.
- [ ] **Step 3: Implement** the four placements.
- [ ] **Step 4:** run the suites above plus `test/jira/jira-strip-css.test.ts` and `test/guards/design-guards.test.ts`; `grep -l
  "JiraCard\|JiraLaneHeader\|JiraIssueList\|JiraTicketStrip" test/` and add hits. `pnpm run typecheck`.
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
    `onOpenPage` with PAY-1. Cmd-click and middle-click on the row's key → `onOpenPage`, and the mention modal does NOT open; a plain click still opens it.
  - Cards: `Open ticket page` text chip before `Reply in Jira`; a dismissed card (Show dismissed on) offers it too.
  - Modal: `Open ticket page` present while the detail read is pending, after it fails, and once it is `ok`; the text `the board cannot open it` is absent;
    `· on none of your boards` still in the head for a `boards: []` ticket. Click → modal's `onClose` then `onOpenPage`.
  - Through `JiraView` on the Mentions page: clicking a row's `Open ticket page` → the page is `ticket`, the key store holds PAY-1, origin `mentions`.
  - Through `JiraView`: mention modal opened from the strip on the ticket page of PAY-1 → `Open ticket page` only closes (page stays, key unchanged); opened
    from a Board card → page `ticket`, origin `board`; from a `JiraDetail` opened on Sessions → origin `sessions`.
- [ ] **Step 2:** run the three suites — FAIL.
- [ ] **Step 3: Implement.** `JiraView` passes `openPage` to `JiraMentionsView`, and to the host: `null`-free function that closes the slot and either does
  nothing more (ticket page, same key) or calls `openPage(key)`.
- [ ] **Step 4:** run the three suites plus `test/jira/jira-ticket-page.test.tsx`, `test/jira/jira-ticket-store.test.tsx`, `test/jira/ticket-url.test.ts`;
  `grep -l "openPage\|JiraMentionList\|JiraMentionCards" test/` and add hits. `pnpm run typecheck`.
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
- [ ] **Step 2:** `pnpm exec jest test/guards/claude-rules.test.ts test/guards/design-guards.test.ts` — pass.
- [ ] **Step 3:** commit `docs(jira): rules and design for the mentions ↔ board link`.

### Task 8: `/ui-verify`

- [ ] Run `/ui-verify` on the live board (no mocks — check against spec §2–§4 and DESIGN.md): a card, a lane header, a List card row and header row, the
  strip in `JiraDetail` and on the ticket page, each with a mark; the mention modal opened from each (one dialog only from Detail); `Open ticket page` from
  a Mentions row, card and modal landing on the ticket page with the right `←` label. Fix defects on the branch; record anything it could not reach (e.g.
  no live mentions) as unverified.
