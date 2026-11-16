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
    (`PrBandSub`). Tone **amber** while at least one PR ranks _needs you_ (`needsYouCount` > 0), **grey** otherwise.
  - **Runs › History** — live runs, `liveRunCount` (running + paused, local and remote): the rows of History's Live sheet. Grey.
  - **Jira › Sessions** — the existing Needs-you count (`useJiraNeedsYou`). Amber.
- Adding a fourth count is one entry in one map, with no rail markup to touch.

## Non-goals

- No seen/unseen memory, no localStorage marker, no "new" semantics.
- No new server route or poller: every count is derived from a read the shell already holds (`PullRequestsContext`, `OrchestratorRunsContext`,
  `JiraSessionsContext`).
- No counts on Files, Settings, Watchdog, Ticks or any other page yet.

## Anti-goals

- Two numbers on one row that disagree with the page they point at. The PRs pill and the PRs band must read the same `N`; the History pill and the Live
  sheet the same row count.
- A pill on a row that has nothing pending: zero draws no element, top row and sub-row alike (today's rule).

## Approaches

1. **Per-page count map, summed for the top row (picked).** `App` builds `Partial<Record<Section, Partial<Record<page, {n, tone}>>>>` from the providers it
   already reads and hands it to `SideRail`; `RailTree` draws a pill per item from it, and the top row draws the sum, amber if any part is amber. Scales by
   adding a map entry.
2. **Keep top-row-only counts, change their meaning.** Smallest diff, but the number sits on a row that holds four pages, and a second count in one section
   has nowhere to go — fails the "multiple sub-sections tomorrow" ask.
3. **Dot on the top row, numbers on sub-rows.** Never sums unlike things, but the user picked the sum (mock choice, 2026-11-16) because it reads with the
   tree closed.

## Decided with the user

- Pending counts, not last-seen (2026-11-16).
- Top row = sum of sub-counts; sub-rows carry the per-page number (picked from three mocks).
- PRs count = all open PRs, not only needs-you.

## Builder's calls (mine, correctable)

- PRs pill tone carries needs-you: amber when any PR needs the reader, so the old signal is not lost when the number widens to all open PRs.
- The Jira top-row pill keeps its click (opens Sessions with the Needs-you chip and All tickets). The Sessions sub-row pill is plain, like every sub-row
  pill: the sub-row itself is the control. GitHub and Runs top-row pills stay plain, as today.
- Sub-row pills hang at the sub-row's right edge, same `Pill` component and size as the top row; aria-labels name what is counted (`5 open PRs, 2 need you`,
  `2 live runs`, `3 sessions need you`).
- A section whose sum is zero draws no top-row pill even when a sub-page is open.
- Below 700 px (trees always open) both the top-row sum and sub-row counts draw, as at desktop width.

## Left to the builder

- Where the map type and the summing helper live (a `lib/` module, testable without rendering).
- CSS for `.rail-sublink` holding a trailing pill, inside DESIGN.md §8.0's measurements.
