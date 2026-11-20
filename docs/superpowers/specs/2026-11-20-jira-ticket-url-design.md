# Jira ticket page: the key in the URL, no rail row, a spread strip — design

Small change on top of the Jira detail tabs spec (`2026-11-19-jira-detail-tabs-design.md`, #579). It overrides that spec's §2.1–§2.3 where they disagree.

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
- C. Path route `/jira/<KEY>`. Rejected: needs an SPA fallback in `server/src/static.ts` and Vite dev, touches the security rules, for the same result.

## Decided

- **URL is the source of truth for the key.** `backlog-manager.jira-ticket-key` (`hooks/useJiraTicketKey.ts`, a `persistedJsonStore`) stops being
  persisted: nothing needs it across loads once the rail row is gone and the URL carries the key. The hook keeps its shape for its readers
  (`JiraView`, `JiraTicketPage`) but reads/writes the URL. The stored page `ticket` with no `ticket=` in the URL falls to Board through `JiraView`'s existing
  `noTicket` path. A stale localStorage entry under the old key is ignored (removing it once is the builder's call).
- **History.** Opening the page (modal `Open full page ↗`, Cmd/Ctrl/middle-click, a walk from nothing) is `pushState` of `?section=jira&ticket=<KEY>`.
  A walk step and the Back chip are `replaceState` — the in-page Back chip walks, browser Back leaves. Leaving the page by any in-app route (rail, `← <origin>`,
  `Forget <KEY>`) is `replaceState` to the address without `section`/`ticket`.
- **popstate.** A `popstate` listener re-reads the URL: `ticket=<KEY>` present → section `jira`, page `ticket`, key set; absent while the ticket page is on
  screen → leave to the origin page (Board after a load). The walk is emptied on a popstate, as on any leave.
- **Deep-link strip.** `App`'s mount effect today removes `section`/`runs`/`settings` once applied. With `ticket` present it keeps `section=jira&ticket=` in
  the address; every other deep link is stripped as today. `ticket` without `section=jira`, or not shaped like a key (`isJiraKey`), is ignored — the existing
  "anything unrecognised is ignored" rule.
- **Rail.** `SideRail` drops the `ticket` row and its `labelFor`/`glyphFor` branch; `jiraTree` is `JIRA_TREE_PAGES` always. With the page on screen the Jira
  row is the active section and no sub-row is highlighted. `ticket` stays in `JIRA_PAGES` (the page store still holds it).
- **Spread strip.** `.jira-strip` spreads its cells evenly across the band when they fit on one line, and wraps left-packed as today when they do not. The
  user's ask is "equally spread" in full-width mode; it applies wherever the strip has the room (the ticket page, and the modal if it is wide enough), not
  keyed on `data-width`. Mechanism is the builder's: e.g. `justify-content: space-between` under an `@container` min-width on the strip's frame, so a
  wrapped second row is never pushed to the far edges. No inline `style=` (CSP).

## Left to the builder

- Where the URL sync lives (a small `lib/ticket-url.ts` of pure read/write helpers plus the store, or inside `useJiraTicketKey.ts`), and how `App` hears a
  popstate (one listener, mounted once).
- The container-query threshold for the strip, checked against the live page at 1280 px and in full width.
- Docs: `.claude/rules/board.md` (Jira pages bullet: rail row and key store), `docs/subsystems/board.md`, `docs/subsystems/jira.md`, `invariants.md` where
  it names the key store or the row, `.claude/DESIGN.md` §8.9.2 (the strip), and `lib/deep-link.ts`'s header comment ("the one URL this app reads").
- Tests that pin the row or the persisted key: `test/ui/rail.test.tsx`, `test/jira/jira-ticket-page.test.tsx`, `test/jira/jira-view-store.test.tsx`,
  `test/jira/jira-board.test.tsx`, and `test/ui/deep-link.test.ts` / `deep-link-app.test.tsx` for the new param.
