# Rail pending counts — design

Status: short design (small change). Date: 2026-11-16.

## Intent

The rail is where the reader learns that something waits, without opening each page to look. Today it half-does that: the GitHub row counts only the PRs
that rank _needs you_, the Runs row counts live runs, and Jira counts sessions that need you — each on the top row, with nothing on the sub-page that
actually holds the items. The user wants to glance at the rail and know **how many open PRs they have** and **how many runs are in flight**, and wants the
mechanism to scale: tomorrow more sub-pages will want a pending number of their own.

## Goals

- Every sub-page row in a rail tree can carry a **pending count** — a live count of items waiting there, never a "since you last looked" count.
- The **top-level row shows the sum** of its sub-pages' counts, so a section whose tree is closed still says something waits inside.
- First three counts:
  - **GitHub › PRs** — every open PR the PRs page lists: the sum of the shown repos' `total`, the same `N` as the page band's `N open in M repos`
    (`PrBandSub`). That sum gets one home, a new `openPrCount(data)` in `client/src/lib/pr-layouts.ts` beside `needsYouCount`, with the same rules: `null`
    data is `0`, and only `splitReach`'s shown repos count (a repo the token cannot read is never counted). `PullRequestsView`'s inline
    `shown.reduce(...)` (`client/src/components/github/PullRequestsView.tsx:196`) is replaced by a call to it, so the band and the pill cannot drift. Tone
    **amber** while at least one PR ranks _needs you_ (`needsYouCount` > 0), **grey** otherwise. Before the first answer, with the provider disabled or
    with no token, both read `0` and no pill draws. A truncated repo counts its `total`, as the band does, though only its listed PRs are ranked for tone.
  - **Runs › History** — live runs, `liveRunCount` (running + paused, local and remote), unchanged from today's Runs pill. It counts every going run on
    the machine whatever the History page's range and project filters say, and does not count `Starting` placeholder rows. Grey.
  - **Jira › Sessions** — the existing Needs-you count (`useJiraNeedsYou`): sessions that need you across every linked ticket, keeping its last value
    while the dashboard is unreachable. Amber.
- Adding a fourth count is one entry in one map, with no rail markup to touch.

## Non-goals

- No seen/unseen memory, no localStorage marker, no "new" semantics.
- No new server route or poller: every count is derived from a read the shell already holds (`PullRequestsContext`, `OrchestratorRunsContext`,
  `JiraSessionsContext`).
- No counts on Files, Settings, Watchdog, Ticks or any other page yet.

## Anti-goals

- Two numbers on one row that disagree with the page they point at. The PRs pill and the PRs band must read the same `N` (one function). The History pill
  matches the Live sheet's going runs while the page is unfiltered (range and project at their widest); a filtered page may show fewer, because the rail
  speaks for the machine, not for the page's current filter — as today's Runs pill already does. The Sessions pill counts every linked ticket, so its
  click lands on Sessions with `All tickets` on (see Builder's calls), where the page lists the same sessions.
- A pill on a row that has nothing pending: zero draws no element, top row and sub-row alike (today's rule).

## Approaches

1. **Per-page count map, summed for the top row (picked).** One pure `lib/` function builds a map `section → page → entry`, where an entry is
   `{ n, tone: 'warn' | 'neutral', label }` and `label` is the full accessible name in words (Copy, below). `SideRail` calls it: `App` still passes the
   PRs payload and `liveCount` it already reads (`prs.data`, `useOrchestratorRunsContext`), and `SideRail` adds the Jira input from `useJiraNeedsYou()`
   itself, because `JiraSessionsProvider` is mounted inside `AppShell`'s own return (`client/src/App.tsx:355`) and a read in `AppShell` would sit above it
   and get the context's silent "nothing known" default. `RailTree` draws a pill per item from the section's entries, and the top row draws the sum, amber
   if any entry is amber. A new count is one entry in that function — its number, tone and label — with no rail markup to touch.
2. **Keep top-row-only counts, change their meaning.** Smallest diff, but the number sits on a row that holds four pages, and a second count in one section
   has nowhere to go — fails the "multiple sub-sections tomorrow" ask.
3. **Dot on the top row, numbers on sub-rows.** Never sums unlike things, but the user picked the sum (mock choice, 2026-11-16) because it reads with the
   tree closed.

## Decided with the user

- Pending counts, not last-seen (2026-11-16).
- Top row = sum of sub-counts; sub-rows carry the per-page number (picked from three text sketches shown in chat, not kept as files).
- Page keys are each section's own union: the History entry is `runs.runs` (`RUNS_MODES`), PRs `github.prs`, Sessions `jira.sessions`.
- PRs count = all open PRs, not only needs-you.

## Builder's calls (mine, correctable)

- PRs pill tone carries needs-you: amber when any PR needs the reader, so the old signal is not lost when the number widens to all open PRs.
- An entry may carry an optional `onOpen`. With it, the pill is a real `<button>` beside the row's (as Jira's top-row count is today); without it, a plain
  `role="img"` span that lets the click through to the row. Jira › Sessions has one — the existing handler: Sessions page, `Needs you` chip, `All tickets`
  on — and the Jira top-row pill keeps the same click. GitHub and Runs pills, top and sub, stay plain.
- Sub-row pills hang at the sub-row's right edge, same `Pill` component and size as the top row.
- Tone rule in words: **amber** when the count includes something waiting on the reader, **grey** when it is only a quantity. A top row is amber when any
  of its entries is.

## Copy (accessible names)

| Entry | n = 1 | n > 1 |
| --- | --- | --- |
| GitHub › PRs, none need you | `1 open PR` | `5 open PRs` |
| GitHub › PRs, k need you | `1 open PR, 1 needs you` | `5 open PRs, 1 needs you` / `5 open PRs, 2 need you` |
| Runs › History | `1 live run` | `2 live runs` |
| Jira › Sessions | `1 session needs you` | `3 sessions need you` |

A top row's name is its non-zero entries' labels joined by `; ` in tree order — with one entry, exactly that entry's label. Today's GitHub top-row name
`N PRs need you` (`client/src/components/SideRail.tsx:240`) goes, since the number is no longer needs-you.

## Docs this rewrites

- `.claude/DESIGN.md` §8.0's **The counts** paragraph (counts "on a row's right end and nowhere else", GitHub counting needs-you, the `2 PRs need you`
  name): rewritten to the per-page counts, the sum, the tone rule and the copy above.
- `.claude/rules/board.md`'s poller bullet ("the rail counts PRs that need you on every page"): now "the rail counts open PRs on every page".
- `docs/superpowers/specs/2026-11-05-jira-sessions-page-design.md` C4 ("the Sessions tree entry carries no count") is superseded by this spec; the badge on
  the Jira row stays, as C4 wanted, now as the sum.
- `test/ui/rail.test.tsx`'s case pinning no count on Sessions flips to pin the new pill.
- A section whose sum is zero draws no top-row pill even when a sub-page is open.
- Below 700 px (trees always open) both the top-row sum and sub-row counts draw, as at desktop width.

## Left to the builder

- Where the map type and the summing helper live (a `lib/` module, testable without rendering).
- CSS for `.rail-sublink` holding a trailing pill, inside DESIGN.md §8.0's measurements.
