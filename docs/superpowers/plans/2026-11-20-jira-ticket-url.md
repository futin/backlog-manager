# Jira ticket page in the URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**This plan specifies behaviour, signatures and exact test cases, never literal code.** Write the bodies yourself; disagree with a signature if the code
shows a better one, and say why in the commit.

**Goal:** The Jira ticket page lives at `/?section=jira&ticket=<KEY>`, Back/Forward leave and reopen it with its origin, the rail's ticket row is gone, and
the summary strip's cells spread across the band.

**Architecture:** `lib/deep-link.ts` learns the `section=jira` + key-shaped `ticket` pair; `lib/ticket-url.ts` holds the pure address/state helpers;
`hooks/useJiraTicketKey.ts` becomes a non-persisted module store of `{ key, origin }` whose setter writes history by one transition rule. `App` seeds it
from the deep link, enforces "address follows the screen" in one effect, and owns the one `popstate` listener.

**Tech Stack:** React 18, TypeScript, jest + Testing Library (jsdom `history`/`PopStateEvent`).

**Spec:** `docs/superpowers/specs/2026-11-20-jira-ticket-url-design.md`

## Global Constraints

- One URL scheme: `?section=jira&ticket=<KEY>` on `/`. No hash, no path route, no server or Vite change.
- A key is valid only as the pair `section=jira` AND `isJiraKey(ticket)` (`shared/types.ts`); defined once, in `lib/deep-link.ts`.
- History rule: none → key `pushState` with state `{ jiraTicketOrigin: <origin> }`; key → other key `replaceState` (state kept); key → none `replaceState`
  with state `null` to the address without `section`/`ticket`.
- `TicketOrigin` is `'board' | 'sessions' | 'mentions'`; absent or invalid in `history.state` reads `'board'`.
- No `container-type` on the strip or its frame; no inline `style=` (CSP).
- Comments explain why, at length, matching the repo's density; every component keeps its `.claude/DESIGN.md` header citation. Wrap new prose at 160.
- Jest suites go in `test/<feature>/`. Before the push, `grep -l <symbol> test/` for each symbol whose callers change (`useJiraTicketKey`,
  `setJiraTicketKey`, `readDeepLink`, `RailTree`) and add every hit to the scoped run.

## Review Focus

1. A pasted lowercase or malformed key (`?section=jira&ticket=pay-12`, `ticket=PAY-`) — must be stripped on load and open the app as a plain load would. → Task 3
2. Open A, leave to Sessions, open B from Sessions, browser Back — must land on Sessions, not on A. → Task 3
3. Walk two children deep, then browser Back — must leave the page to the origin, not step to the parent. → Task 3
4. `Forget <KEY>` after a failed read — address bare, key empty, page = origin. Forget replaces the pushed entry with the bare address, so a later Back then
   Forward lands on a bare entry: that popstate (no `ticket`, no key held) changes nothing — no half state, no ticket reopened. → Task 3
5. Other deep links unchanged: `?section=runs&runs=watchdog`, `?section=settings&settings=shared` still applied and stripped. → Task 1, Task 3

---

### Task 1: Deep-link pair and ticket address helpers

**Files:**
- Modify: `client/src/lib/deep-link.ts` (`DeepLink`, `PARAMS`, `readDeepLink`, header comment)
- Modify: `client/src/lib/jira-page.ts` (add `TicketOrigin`, `TICKET_ORIGINS`)
- Modify: `client/src/components/jira/JiraTicketPage.tsx:42` (import `TicketOrigin` from `lib/jira-page.ts` instead of declaring it; keep `ORIGIN_LABEL` there)
- Modify: `client/src/components/jira/JiraView.tsx:19` (import path for the type)
- Create: `client/src/lib/ticket-url.ts`
- Test: `test/ui/deep-link.test.ts` (extend; its `toEqual` objects at ~10-54 each gain `ticket: null`), Create `test/jira/ticket-url.test.ts`

**Interfaces:**
- Produces: `DeepLink.ticket: string | null`; `readDeepLink(search)` sets it only for the valid pair. `PARAMS` includes `'ticket'`, so `withoutDeepLink`
  strips it.
- Produces: `type TicketOrigin = 'board' | 'sessions' | 'mentions'`, `TICKET_ORIGINS: readonly TicketOrigin[]` in `lib/jira-page.ts`.
- Produces in `lib/ticket-url.ts`:
  - `ticketAddress(pathname: string, search: string, hash: string, key: string): string` — every non-deep-link param kept, then `section=jira&ticket=<key>`,
    hash kept.
  - `originFromState(state: unknown): TicketOrigin` — `state.jiraTicketOrigin` when it is one of `TICKET_ORIGINS`, else `'board'`.
  - `ticketState(origin: TicketOrigin): { jiraTicketOrigin: TicketOrigin }`.

- [ ] **Step 1: Write the failing tests.** In `deep-link.test.ts`: `readDeepLink('?section=jira&ticket=PAY-12').ticket === 'PAY-12'`;
  `'?ticket=PAY-12'` → `ticket: null`, `section: null`; `'?section=runs&ticket=PAY-12'` → `ticket: null`; `'?section=jira&ticket=pay-12'` → `null`;
  `'?section=jira&ticket=PAY-'` → `null`; `withoutDeepLink('/', '?ticket=PAY-12&x=1', '#h') === '/?x=1#h'`. In `ticket-url.test.ts`:
  `ticketAddress('/', '', '', 'PAY-12') === '/?section=jira&ticket=PAY-12'`; `ticketAddress('/', '?x=1&section=runs', '#h', 'PAY-7') ===
  '/?x=1&section=jira&ticket=PAY-7#h'`; `originFromState({ jiraTicketOrigin: 'sessions' }) === 'sessions'`; `originFromState(null)`,
  `originFromState({ jiraTicketOrigin: 'setup' })`, `originFromState('x')` all `'board'`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm run test:jest -- test/ui/deep-link.test.ts test/jira/ticket-url.test.ts`
- [ ] **Step 3: Implement** the interfaces above; update `deep-link.ts`'s header ("the one URL this app reads" now also carries the ticket pair, which
  `App` keeps in the address while the page is on screen).
- [ ] **Step 4: Run, expect PASS**, plus `pnpm run typecheck`.
- [ ] **Step 5: Commit** `feat(jira): read the ticket pair from the deep link` (files by path).

### Task 2: The ticket store writes history

**Files:**
- Modify: `client/src/hooks/useJiraTicketKey.ts` (rewrite: non-persisted module store)
- Modify: `client/src/hooks/persistedStore.ts:7` (header comment: `useJiraTicketKey` no longer one of its composers)
- Test: Create `test/jira/jira-ticket-store.test.tsx`; Modify `test/jira/jira-view-store.test.tsx` (its persistence cases for the key, ~lines 141-175)

**Interfaces:**
- Consumes: Task 1's `ticketAddress`, `ticketState`, `withoutDeepLink`, `TicketOrigin`.
- Produces:
  - `useJiraTicketKey(): string` (unchanged name and return).
  - `useJiraTicketOrigin(): TicketOrigin`.
  - `getJiraTicket(): { key: string; origin: TicketOrigin }` — the current value, for non-React readers (`App`'s popstate handler).
  - `setJiraTicketKey(key: string, origin?: TicketOrigin): void` — applies the Global Constraints' history rule against the previous key; on none → key
    stores `origin ?? 'board'`; key → key keeps the stored origin; key → none resets origin to `'board'`. Same key again writes nothing.
  - `syncJiraTicket(key: string, origin: TicketOrigin): void` — sets the store, writes NO history (load seed and popstate).
  - `forgetLegacyTicketKey(): void` — removes localStorage `backlog-manager.jira-ticket-key` inside try/catch.
  - `JIRA_TICKET_KEY_KEY` stays exported only for `forgetLegacyTicketKey` and its test.
- A key that fails `isJiraKey` (other than `''`) is ignored by both setters.

- [ ] **Step 1: Write the failing tests** (reset with `history.replaceState(null, '', '/')` and `syncJiraTicket('', 'board')` in `beforeEach`; spy on
  `history.pushState`/`replaceState`):
  - `setJiraTicketKey('PAY-12', 'sessions')` from empty → one `pushState`, `location.search === '?section=jira&ticket=PAY-12'`,
    `history.state` deep-equals `{ jiraTicketOrigin: 'sessions' }`, `getJiraTicket()` is `{ key: 'PAY-12', origin: 'sessions' }`.
  - then `setJiraTicketKey('PAY-13')` → one `replaceState`, no new push, search `?section=jira&ticket=PAY-13`, state still `sessions`, origin `sessions`.
  - then `setJiraTicketKey('PAY-14', 'mentions')` → `replaceState`, origin stays `sessions` (key → key ignores the argument).
  - then `setJiraTicketKey('')` → `replaceState`, `location.search === ''`, `history.state === null`, `getJiraTicket()` is `{ key: '', origin: 'board' }`.
  - `setJiraTicketKey('PAY-12')` twice → exactly one `pushState` and no `replaceState`.
  - `setJiraTicketKey('pay-12')` → no history call, key stays `''`.
  - `syncJiraTicket('PAY-9', 'mentions')` → no history call; a mounted `useJiraTicketKey()` reader rerenders to `PAY-9`, `useJiraTicketOrigin()` to `mentions`.
  - `forgetLegacyTicketKey()` with `localStorage['backlog-manager.jira-ticket-key'] = '"PAY-1"'` → the entry is gone; with a throwing `removeItem` → no throw.
  - nothing in localStorage under `backlog-manager.jira-ticket-key` after any setter call.
- [ ] **Step 2: Run, expect FAIL.** `pnpm run test:jest -- test/jira/jira-ticket-store.test.tsx test/jira/jira-view-store.test.tsx`
- [ ] **Step 3: Implement** the store as a plain module store with `useSyncExternalStore` (not `persistedJsonStore`); rewrite the header comment (URL is
  the source of truth, why the origin rides in `history.state`). Update `jira-view-store.test.tsx` cases that asserted the key persisted: they now assert
  it is NOT written to localStorage; the "reads a stored key" case (~150-159) becomes "a stored legacy value is not read". In the same commit, every
  `storedKey()` assertion in `test/jira/jira-ticket-page.test.tsx` (helper at :112, ten assertions; drop its now-unused `JIRA_TICKET_KEY_KEY` import, as in
  jira-board) and `test/jira/jira-board.test.tsx` (defined ~2741, asserted ~2778, 2818,
  2861, 2872 — the `.toBe('')` ones pin "a control's click does not open the page", keep them) becomes `getJiraTicket().key`, so no suite is left red.
- [ ] **Step 4: Run, expect PASS**, plus `pnpm run test:jest -- test/jira/jira-ticket-page.test.tsx test/jira/jira-board.test.tsx` and typecheck.
- [ ] **Step 5: Commit** `feat(jira): the ticket key store writes the address, not localStorage`.

### Task 3: App wiring — load, address follows the screen, popstate; JiraView/JiraTicketPage read the store

**Files:**
- Modify: `client/src/App.tsx` (the `link` initializer ~146-150; the mount strip effect ~196-201; a new derived-rule effect; a new `popstate` effect)
- Modify: `client/src/components/jira/JiraView.tsx:83-96` (drop local `origin` state and its reset effect; read `useJiraTicketOrigin()`; `openPage` computes
  origin first and calls `setJiraTicketKey(key, origin)`; header comment)
- Modify: `client/src/components/jira/JiraTicketPage.tsx` (header comment ~31-38; walk/Forget calls unchanged in shape)
- Test: `test/ui/deep-link-app.test.tsx` (extend), `test/jira/jira-ticket-page.test.tsx` (update T22 rail-row and remount cases, add history cases),
  `test/jira/jira-board.test.tsx` (no change here — Task 2 updated it; kept in the run as a regression check)

**Interfaces:**
- Consumes: Task 1 `readDeepLink(...).ticket`, `originFromState`, `withoutDeepLink`, `ticketAddress`; Task 2 `syncJiraTicket`, `setJiraTicketKey`,
  `getJiraTicket`, `useJiraTicketKey`, `useJiraTicketOrigin`, `forgetLegacyTicketKey`; existing `setJiraPage`, `useJiraPage`, `onOpenJiraPage`.
- Behaviour:
  - `link` initializer: `forgetLegacyTicketKey()`; when `read.ticket !== null`: `syncJiraTicket(read.ticket, originFromState(history.state))` and
    `setJiraPage('ticket')`.
  - `useJiraPage()` (new in `App`) is called after the `link` initializer, so its first read sees the page the link wrote; read earlier, the derived
    effect below would clear a deep-linked key on mount.
  - Mount effect: runs when `link.section !== null` OR `new URLSearchParams(location.search).has('ticket')` — not on every `PARAMS` hit, so
    `?section=nope` and a lone `?runs=` stay in the address as today. With a valid pair, the address becomes
    `ticketAddress(...)` of the stripped address and `history.state` is kept; otherwise `withoutDeepLink` as today. `writeSection` only on a valid section.
  - Derived effect on `[section, jiraPage, key]`: when `key !== ''` and not (`section === 'jira'` and `jiraPage === 'ticket'`) → `setJiraTicketKey('')`.
  - `popstate` (one listener, mount only): pair present → `syncJiraTicket(key, originFromState(event.state))` then `onOpenJiraPage('ticket')`; absent and
    `getJiraTicket().key !== ''` → `const o = getJiraTicket().origin`, `syncJiraTicket('', 'board')`, `setJiraPage(o)` in the same handler. The listener
    is bound once, so it calls `onOpenJiraPage` (whose `change` closes over render state) through a ref updated every render.

- [ ] **Step 1: Write the failing tests.** In `deep-link-app.test.tsx` (Jira configured fixture as `jira-ticket-page.test.tsx` builds it):
  - load `/?section=jira&ticket=PAY-12` with stored Jira page `board` → ticket page for PAY-12 drawn, `location.search` still
    `?section=jira&ticket=PAY-12`, chip `← Board`.
  - load the same with `history.state = { jiraTicketOrigin: 'sessions' }` → chip `← Sessions` (reload keeps origin).
  - load `/?section=jira&ticket=pay-12` → `location.search === ''`, Jira Board page (Review Focus 1).
  - load `/?ticket=PAY-12` → `location.search === ''`, app opens as a plain load.
  - load `/?section=runs&runs=watchdog&ticket=PAY-12` → Runs › Watchdog, `location.search === ''` (Review Focus 5).
  - load `/?section=jira&ticket=PAY-12` with `GET /api/jira` → `configured: false` → section falls, `location.search === ''`.
  - localStorage `backlog-manager.jira-ticket-key` set before load → gone after mount.
  - load `/?section=nope` → `location.search === '?section=nope'` (unread params stay, as today — a regression pin, green before Step 3 too).
  In `jira-ticket-page.test.tsx` — the first two cases may use `mountSection` (arm or clear the history spies after mounting: the helper's own
  `setJiraTicketKey` now pushes); every later case needs `App`'s derived effect, popstate listener or rail, so it mounts `<App />` with the
  Jira-configured fixture and is driven through events or the address, never bare store writes (a store write plus a `setState` outside a discrete event
  can render in separate passes and let an effect see the key without the page):
  - from Sessions, Cmd-click a row → one `pushState`, search `?section=jira&ticket=<key>`, state `{ jiraTicketOrigin: 'sessions' }`.
  - a Children row then the Back chip → only `replaceState` calls, search follows the drawn key.
  - `← Sessions` → search `''`, Sessions page, key `''`.
  - rail Board click while on the page → search `''`, key `''`.
  - top-row `Jira` click while on the page → page and search unchanged.
  - rail click on Runs while on the page → search `''`, key `''` (the section arm of the derived rule).
  - open PAY-12 from Sessions, its read fails, `Forget PAY-12` → search `''`, Sessions page, key `''`; then popstate to `''` with state `null` → still
    Sessions, key `''`, no ticket page (Review Focus 4).
  - dispatch `popstate` with search `''` while on the page opened from Sessions → Sessions page, key `''` (no Board flash: the page store never reads
    `board` in between — assert with a mounted `useJiraPage()` probe that records each rendered value).
  - dispatch `popstate` to `?section=jira&ticket=PAY-12` with state `{ jiraTicketOrigin: 'sessions' }` while on Board → ticket page, chip `← Sessions`.
  - open A from Board, `← Board`, open B from Sessions, popstate to `''` → Sessions (Review Focus 2).
  - open from Sessions, walk two children, popstate to `''` → Sessions page, not the parent and not Board (Review Focus 3).
  - Replace T22 "entered by the rail's row" with "entered by a link with no state → `← Board`"; replace "after a remount, origin forgotten" with "after a
    remount with the key held, the origin is kept".
- [ ] **Step 2: Run, expect FAIL.** `pnpm run test:jest -- test/ui/deep-link-app.test.tsx test/jira/jira-ticket-page.test.tsx test/jira/jira-board.test.tsx`
- [ ] **Step 3: Implement** the behaviour above, with comments on why each effect exists (the derived rule replaces per-route clearing; the popstate
  sets the origin page in the same handler so `noTicket` never sends the reader to Board first).
- [ ] **Step 4: Run, expect PASS**, plus `pnpm run test:jest -- test/ui test/jira` and typecheck.
- [ ] **Step 5: Commit** `feat(jira): the ticket page lives in the address bar`.

### Task 4: No rail row

**Files:**
- Modify: `client/src/components/SideRail.tsx:138-140` (drop `ticketKey`, `jiraTree` is `JIRA_TREE_PAGES`), `:315-316` (drop `labelFor` ticket branch and
  `glyphFor`), `RailTree`'s `glyphFor` prop and glyph span (~397-443), comments at ~578-588; drop the `Glyph` component import (`:5`, its only use is the row's span); `GlyphName` stays (`RAIL_GLYPH`)
- Modify: `client/src/styles.css:233` (delete `.rail-sub-glyph`)
- Test: `test/ui/rail.test.tsx` (~713-729: the row case)

**Interfaces:** Consumes Task 2's `setJiraTicketKey`/`syncJiraTicket` in the test only.

- [ ] **Step 1: Replace the failing-to-be test.** The rail case becomes: with `syncJiraTicket('PAY-12', 'board')` and page `ticket`, the Jira tree has
  exactly `Board`, `Sessions`, `Mentions`, `Setup` rows; no button named `PAY-12`; no `.rail-sub-glyph` in the document; no Jira sub-row has
  `aria-current`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm run test:jest -- test/ui/rail.test.tsx`
- [ ] **Step 3: Implement** the removals.
- [ ] **Step 4: Run, expect PASS**; `grep -rn "rail-sub-glyph\|glyphFor" client/src` → no hits; typecheck.
- [ ] **Step 5: Commit** `feat(jira): drop the rail's ticket row`.

### Task 5: Spread strip

**Files:**
- Modify: `client/src/styles.css:1688` (`.jira-strip-cell` gains `flex: 1 1 auto`; comment above `.jira-strip` explains the spread and why no container)
- Test: Create `test/jira/jira-strip-css.test.ts` (reads `client/src/styles.css` as text)

- [ ] **Step 1: Write the failing test:** the `.jira-strip-cell` rule body contains `flex: 1 1 auto`; neither the `.jira-strip` rule nor any rule whose
  selector contains `jira-strip` or `jira-page` sets `container-type`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm run test:jest -- test/jira/jira-strip-css.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; also `pnpm run test:jest -- test/guards` (design and ui-kit guards read styles.css).
- [ ] **Step 5: Commit** `feat(jira): spread the summary strip across the band`.

### Task 6: Docs

**Files:**
- Modify: `.claude/rules/board.md` (Jira pages bullet: headline adds the address as a way in; replace the rail-row and persisted-key clauses with the
  pair, the history rule, the derived effect and the popstate listener)
- Modify: `docs/subsystems/invariants.md` (the matching anchor section's text; keep the anchor slug unless the headline change forces it, then update
  every link to it — `grep -rn "the-jira-sections-five-pages" .`)
- Modify: `docs/subsystems/board.md`, `docs/subsystems/jira.md` (where they describe the ticket page, key store or rail row)
- Modify: `.claude/DESIGN.md` §8.0 (no conditional row) and §8.9.2 (rail-row sentence; the strip's spread)
- Modify: `client/src/lib/jira-page.ts` header (~11-13), any remaining comment naming the persisted key (`grep -rn "jira-ticket-key\|rail's row" client/src`)

- [ ] **Step 1:** Edit each file; new text only, no reflow of untouched prose.
- [ ] **Step 2:** `grep -rn "jira-ticket-key" client/src docs .claude | grep -v superpowers/` → only `useJiraTicketKey.ts` (the legacy removal) and docs
  that say it is removed. `pnpm run test:jest -- test/guards` (doc-link guards, if any) passes.
- [ ] **Step 3: Commit** `docs(jira): the ticket page's address, no rail row, spread strip`.

### Task 7: /ui-verify

- [ ] Run `/ui-verify` against the live app: open a ticket page from Sessions at 1280 px and with `contentWidth: full`; check the address, Back/Forward,
  the rail (no row), and the strip spread with 3 and 6 cells. Fix defects on the branch.
