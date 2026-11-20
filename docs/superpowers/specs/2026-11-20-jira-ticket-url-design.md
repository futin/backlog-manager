# Jira ticket page: the key in the URL, no rail row, a spread strip — design

Small change on top of the Jira detail tabs spec (`2026-11-19-jira-detail-tabs-design.md`, #579). It overrides that spec where they disagree: §2.1–§2.3,
the "No router" constraint, §9's rail-row cases and §10's conditional `<KEY>` row.

## Intent

After #579 the ticket page opened with a bare `127.0.0.1:5177` in the address bar and a `TIMIFY-27684` row appeared in the rail under Jira › Setup. The user
read the row as a stray section and missed the ticket key in the URL: a ticket page should be a link — pasteable, reloadable, openable in another tab — and
the browser's Back should leave it. The rail row's only job was "a way back to the last ticket", which the URL and Back now do. Separately, in full-width
mode (`contentWidth: 'full'`) the summary strip's cells bunch at the left edge with empty band to the right; they should spread across the band.

## Goals

1. While the ticket page is on screen the address bar reads `/?section=jira&ticket=<KEY>`, and it follows the walk (Children row, parent link, Back chip).
2. Opening `/?section=jira&ticket=<KEY>` — a paste, a reload, a new tab — lands on that ticket page, whatever localStorage holds.
3. Browser Back from the ticket page returns to the page that opened it; Forward reopens the ticket.
4. The rail draws no ticket row, ever. Jira's tree is its four fixed pages.
5. On a wide frame the summary strip's cells spread evenly across the band; on a narrow frame they wrap as today.

## Non-goals

- No URL for any other page or section. Board, Sessions, Mentions, Setup and every other section keep a bare `/` and their localStorage place.
- Cmd-click still opens the page in this tab, not a new browser tab (the surfaces are buttons and rows, not links). Making them real links is later work.
- No server or Vite change: the URL is a query on `/`, which both already serve.

## Anti-goals

- A second URL scheme (hash or path routes) beside the existing `?section=` deep link.
- A URL that goes stale: the address bar must never name a ticket that is not on screen, and must never keep `ticket=` after the page is left.

## Approaches

- **A. Query param on the existing deep link (picked).** `lib/deep-link.ts` learns `ticket` beside `section`. One parser, no server change.
- B. Hash route `#/jira/<KEY>`. Rejected: a second URL scheme beside `?section=`, two parsers for one app.
- C. Path route `/jira/<KEY>`. Rejected: the SPA fallback already serves any path (`server/src/static.ts`'s `ServeStaticModule`, Vite dev by default), but
  it is still a second URL scheme beside `?section=`, read off `pathname` by a second parser, for the same result.

## Decided

- **URL is the source of truth for the key.** `backlog-manager.jira-ticket-key` (`hooks/useJiraTicketKey.ts`, a `persistedJsonStore`) stops being
  persisted: nothing needs it across loads once the rail row is gone and the URL carries the key. The hook keeps its shape for its readers
  (`JiraView`, `JiraTicketPage`) but reads/writes the URL. The stored page `ticket` with no `ticket=` in the URL falls to Board through `JiraView`'s existing
  `noTicket` path. The orphaned `backlog-manager.jira-ticket-key` entry is removed once on load, so no dead key lingers in localStorage.
- **History: one rule on the key's transitions.** No key → key is `pushState` of `?section=jira&ticket=<KEY>` (modal `Open full page ↗`, a Cmd/Ctrl/middle
  click). Key → another key is `replaceState` (a Children row, the parent link, the Back chip: the in-page chip walks, browser Back leaves). Key → none is
  `replaceState` to the address without `section`/`ticket`. The one setter (`setJiraTicketKey`) applies this rule, so its callers keep their shape.
- **The address follows the screen, by one derived rule.** Whenever (section, Jira page) is not (`jira`, `ticket`) with a key held, the address carries no
  `section`/`ticket`; one effect in `App` enforces it, so every leave — the rail's tree and count pills, the strip chips, `← <origin>`, `Forget <KEY>`, the
  Jira fall, the source settle, `JiraView`'s `noTicket` write-back — drops them without each route knowing. A click on the rail's top-row `Jira` while on the
  ticket page is not a leave (it re-selects the section and keeps the page), so page and address stay.
- **Back and Forward keep the origin.** The push writes `history.state` `{ jiraTicketOrigin: <origin> }` (`board`, `sessions` or `mentions`). A `popstate`
  that lands on an entry with `ticket=<KEY>` sets section `jira`, page `ticket`, the key, and the origin from that entry's state (`board` when absent). A
  `popstate` that lands on an entry without `ticket` while the ticket page is on screen sets the Jira page to the current origin in the same handler that
  clears the key, so `noTicket` never sends the reader to Board first. Sessions → ticket → Back → Forward → Back therefore ends on Sessions. The walk is
  emptied on any leave, popstate included. A popstate onto a ticket entry enters through `App`'s `onOpenJiraPage` pair (`setJiraPage` then `change`), so
  the section key is still recorded in one place. Where the origin lives so `App`'s listener can read it (lifted out of `JiraView`, or a small module store)
  is the builder's call. Accepted: after an in-app leave the pushed entry reads `/`, so one browser Back press may change nothing visible.
- **Deep link on load.** `ticket` joins `PARAMS` in `lib/deep-link.ts`, and the key is defined there as one pair: `section=jira` AND a key-shaped `ticket`
  (`isJiraKey`). A valid pair writes the page store in `App`'s `link` initializer — `setJiraPage('ticket')` and the key, beside `setRunsMode`, before the lazy
  `JiraView` mounts — so a pasted link opens the ticket even with `board` stored, and the mount effect keeps `section=jira&ticket=` in the address. An
  ignored `ticket=` (no `section=jira`, or not key-shaped) is stripped on mount even when no valid `section` is present, so the address never names a
  ticket that is not on screen; every other deep link is stripped as today. While `GET /api/jira` is unanswered the pair is held (`JiraView` draws its
  `loading…`); on `configured: false` the Jira fall moves the section and the derived rule above strips it.
- **Rail.** `SideRail` drops the `ticket` row and its `labelFor`/`glyphFor` branch; `jiraTree` is `JIRA_TREE_PAGES` always. With the page on screen the Jira
  row is the active section and no sub-row is highlighted. `ticket` stays in `JIRA_PAGES` (the page store still holds it). `RailTree`'s `glyphFor` prop and
  `.rail-sub-glyph`, whose only caller was the row, go with it.
- **Spread strip.** Each `.jira-strip-cell` grows (`flex: 1 1 auto`): the band's spare width on a row is shared equally among that row's cells, so the gap
  after every cell widens by the same amount, and each cell's label and value stay left-aligned inside it. Six cells on one 1900 px row: six columns, the
  same extra space after each. Two cells (a ticket with no Delivery or Agent cell): two halves, the second starting mid-band. A wrapped row fills its own
  width the same way, so no row is pushed to the far edges. It applies wherever the strip draws (the page and the modal), not keyed on `data-width`. No
  `container-type`: the strip holds the Move-to `Popover` and `Run ▾`, whose phone-shape panels are `position: fixed`, and a container would become their
  containing block (the hazard `styles.css` documents beside `.jira-list-frame`). No inline `style=` (CSP).

## Left to the builder

- Where the URL sync lives (a small `lib/ticket-url.ts` of pure read/write helpers plus the store, or inside `useJiraTicketKey.ts`), and how `App` hears a
  popstate (one listener, mounted once).
- Checking the spread strip on the live page at 1280 px and in full width.
- Docs: `.claude/rules/board.md` (the Jira bullet's headline gains the URL as a way in, plus the rail row and key store clauses), `docs/subsystems/board.md`,
  `docs/subsystems/jira.md`, `invariants.md` (that bullet's anchor section), `.claude/DESIGN.md` §8.0 (the conditional row) and §8.9.2 (the rail-row sentence
  and the strip), `lib/deep-link.ts`'s header comment ("the one URL this app reads"), and the header comments that describe the row or the persisted key
  (`lib/jira-page.ts`, `hooks/persistedStore.ts`, `JiraView.tsx`, `JiraTicketPage.tsx`, `SideRail.tsx`).
- Tests that pin the row or the persisted key: `test/ui/rail.test.tsx`, `test/jira/jira-ticket-page.test.tsx`, `test/jira/jira-view-store.test.tsx`,
  `test/jira/jira-board.test.tsx` (and every hit of `grep -l useJiraTicketKey test/`). New behaviour gets its own cases: the deep-link pair parsed and an
  ignored `ticket=` stripped (`test/ui/deep-link.test.ts`, `deep-link-app.test.tsx`), push on open, replace on walk and on leave, popstate both ways with
  the origin kept, the address dropped on each leave route, and no rail row.
