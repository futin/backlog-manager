# UI verify — PR check counts (2026-11-06)

Verdict: **PASS**. Small change, no plan; the reference is the PRs layouts mock (https://claude.ai/artifact/JGHYN5bT7oaU8uute4W82h, Matrix section) plus the
wording the user picked in session: `N of M` (`2 of 7 failing`, `3 of 7 running`, `7 passing`; chips `2 of 7 checks failing`).

## Inventory

| View | Mock | How opened | Data | States |
| ---- | ---- | ---------- | ---- | ------ |
| GitHub › PRs › Matrix, Checks column | mock §2 Matrix | branch Vite on :5199, `/api/prs` fulfilled by a fixture | 7 PRs, one repo | failing 2/7, failing 1/1, running 10/12, pending with 0 running, passing 7, passing without tallies, none (draft) |
| GitHub › PRs › Inbox, checks chip | mock §1 Inbox | same | same | same |
| GitHub › PRs › Cards, checks chip | mock §3 Cards | same | same | same |

## Geometry (1440×1000 and 600×1000, light)

Only `sr-only` spans (1 px by design) at 1440. At 600, Matrix's `prs-matrix-scroll` scrolls sideways (the table's deliberate min-width) and one `prs-title`
ellipsises — both unchanged by this branch. No new overflow.

## Regions

- Matrix Checks cell: **match**, sized. `2 of 7 failing` / `1 failing` keep the red pill, `10 of 12 running` the live tone, `7 passing` plain; one line each,
  the column did not widen into its neighbours. The mock's `running…` ellipsis is not drawn — **deviation**, unchanged by this branch (the cell has always said
  `running`).
- Matrix fallbacks: `running` (pending, nothing running yet), `passing` (no tallies), `—` (no checks): **match** the pre-count words.
- Inbox and Cards chips: **match** — `2 of 7 checks failing`, `1 check failing`, `10 of 12 checks running`, `7 checks passing`; bare `checks pending` /
  `checks passing` where there are no counts to back the word.

Screenshots were in the session scratchpad (`live-{matrix,inbox,cards}-{1440,600}.jpg`); the harness fulfilled `/api/prs` from a fixture built on
`PullRequestsPayload`.
