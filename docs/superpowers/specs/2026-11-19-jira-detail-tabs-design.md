# Jira › Detail — tabs, a ticket page, every MR per target — design

Status: accepted after two review rounds (autopilot); plan `docs/superpowers/plans/2026-11-19-jira-detail-tabs.md`, not yet executed. Date: 2026-11-19. Branch `jira-detail-tabs`. Amends DESIGN.md §8.9.2 (Detail dialog) and §8.9.6 (Delivery, the Detail
half only), and the board.md rule "The Jira section's four pages". Mocks: the Design-canvas artifact "Jira Detail" (<https://claude.ai/artifact/DPpfcBD3A4RDu1dq83fcjt>,
private, Version 9, twelve comment threads all resolved), copied into [2026-11-19-jira-detail-tabs-mockups/](2026-11-19-jira-detail-tabs-mockups/) and read
against the code in [00-mock-audit.md](2026-11-19-jira-detail-tabs-mockups/00-mock-audit.md). The `*.dc.html` files need the canvas runtime; standalone copies that open in any
browser, with no runtime, are in [html/](2026-11-19-jira-detail-tabs-mockups/html/index.html) (same names, `.html`).

| Mock | What it fixes |
| ---- | ------------- |
| [Main.dc.html](2026-11-19-jira-detail-tabs-mockups/Main.dc.html) | The ticket PAGE on the Delivery tab: top bar, heading, summary strip, tab row, two target rows (the first open, the second with its older MRs folded), Worktrees fold |
| [B-Modal.dc.html](2026-11-19-jira-detail-tabs-mockups/B-Modal.dc.html) | The MODAL on the Agent tab: the same strip and tabs inside the dialog, a live session card with `Open`, History folded open with `Reopen` per row |
| [States.dc.html](2026-11-19-jira-detail-tabs-mockups/States.dc.html) | §4.5's fourteen MR states as compact target rows, each with its track, next-step ring, `next:` pill and row button, plus the two ignored states (§4.5.1) |
| [Review-Skills.dc.html](2026-11-19-jira-detail-tabs-mockups/Review-Skills.dc.html) | NOT this spec — the follow-up review-skills spec's Settings page, kept beside the others because the `Review ▾` menu in `Main.dc.html` belongs to it |

The mocks carry real-looking sample data from one ticket; the layout, controls, copy and states are what they fix. Where a mock and this spec differ, this
spec wins — the audit lists every such place.

## Intent

Detail is the one place a ticket's whole story is read: what Jira says about it, what the agent did on it, and what became of the work in GitLab. Today it is
one dialog with two columns — Agent (sessions band, Delivery pane, History timeline, `Run ▾`) and Ticket (facts, Assign / Move to, description, children,
worktrees, comments note) — and the user's words are that "it's not clear what is what". Everything is open at once, so a ticket with five ended sessions
pushes Delivery below the fold, and a ticket with a long description pushes Children a screen down.

Two things are also wrong, not only crowded:

- **One MR is shown where several exist.** The user's branch for a ticket routinely has one MR per target — `develop`, `demo`, sometimes more — and every
  re-cut leaves the older ones merged or closed. `ticketDelivery` sorts them all and Detail draws only the lead (plus a one-line `Also:`), so the `demo` MR
  is invisible unless it happens to lead.
- **There is no full page.** A ticket can only be read in the dialog over the board, and only for a ticket the board's poll holds. The follow-up (Mentions →
  ticket and back) needs a ticket that opens by its key alone.

This spec reorganises Detail into a summary strip over four tabs, used identically by the dialog and a new fifth Jira page; folds the session history; and
draws every MR, grouped per target branch, compact by default and expanding into today's richer Delivery pane.

## Goals

- One reading of a ticket — summary strip, tab row, four panes — drawn by both the modal and the page, so the two never disagree on what a tab holds.
- The strip answers "where is it" at a glance on every tab: status, assignee, sprint, parent, one delivery pill per target, the agent's state.
- Delivery shows every MR the ticket has: one row per target branch led by that target's newest MR, compact by default and expanding to today's full pane;
  the rest of that target's MRs folded under it.
- Session history is folded by default and each row can reopen its session, as today's `Reopen` does.
- A full page for one ticket, opened from the modal and loadable by its key without the board's poll.
- The tab last used is the tab the next ticket opens on, in the modal and the page alike.
- Nothing Detail does today is lost, except what this spec removes by name (Stop on a review session's card, §5.1; the `Comments stay in Jira` sentence's place, §6).
- No new server route and no new Jira or GitLab request.

## Non-goals

- **Review skills.** Custom review skills (`Review ▾` with the built-in review-bot request plus the user's own: Claude code review, backlog reviewer, MR review loop),
  the Run|Review group switch in Settings › Jira › Skills, drag reordering — all of `Review-Skills.dc.html` and the `Review ▾` menu in `Main.dc.html`. Its
  own spec follows this one; this spec only reserves the slot (§4.4).
- **Mentions ↔ ticket page.** The page is built to be reachable by key so that link is small; the link itself is the next spec.
- Comments: still read in Jira. v1's rule stands.
- The board card, the List and the agent deck: they keep `leadMr` and their look. The next-step marker (§4.5) is Detail's only.
- A URL router. The client has none and this spec does not add one.

## Anti-goals

- **A second Detail.** If the modal and the page each grow their own layout, they drift in a month. One body component, two frames.
- **A tab that hides an alarm.** A failing pipeline, a session waiting on an answer or findings to fix must show in the strip, whichever tab is on screen —
  tabs fold detail, never state.
- **Losing the walk.** Children rows and the parent link swap the ticket in place with `← <key>` back today; tabs must not break that, and the page must
  offer the same.
- **A Delivery tab that guesses.** Grouping happens over the MRs the server already returns; a target with no MR is not invented, and `unknown` still says
  unknown.

## Constraints

- No router: the Jira section's page is `JIRA_PAGES` in `lib/jira-page.ts`, held by `hooks/useJiraPage.ts` (a `persistedStore`), switched by the rail's tree
  or a link threaded down from `App` (`onOpenJiraPage`), never an in-page control of its own (board.md).
- `JiraDetail` is a composer of `ui/Modal` (`test/guards/dialog-count-docs.test.ts` counts composers). The page is not a dialog.
- The two data sources stay: the card's `JiraIssue` (instant), then `GET /api/jira/issue/:key` → `JiraIssueDetail` (description, children, transitions,
  boards, session). The page has no card, so it opens on the detail read alone.
- `lib/delivery.ts` owns every delivery word, tone and mark; surfaces arrange them (DESIGN.md §8.9.6).
- The review launch is unchanged: `setLaunch({ issue, action: 'review', review: { half, mr, repos } })`. The server already accepts ANY open MR carrying the
  ticket's key or its parent's (`jira-dispatch.service.ts` `launch`, spec §5.5), so a Review button per target needs no server change.
- One write guard (`useAction`) per Detail; state keyed by issue key (the `shownKey` pattern).
- Wrap at 160 columns; comments explain why (CLAUDE.md conventions).

## Approaches

Two questions were settled with the user against canvas mocks.

**Layout.** (A) Jira-like: a wide main column (description, children, comments) with a right rail of facts and agent — familiar, but the rail is today's
crowding in a narrower column. (B) **Summary strip + tabs** — the strip carries every at-a-glance state, each tab owns one question (what is it / where did
the work go / what did the agent do / what hangs under it). (C) Accordions: every section a fold on one long scroll — nothing hidden by a tab, but the user
still scrolls past sections they did not open, and fold state per section per ticket is more to remember. **The user picked B**, for the modal and the page
alike, with one amendment: today's Delivery pane is richer than B's first mock, so a target row is B's compact line by default and expands into today's pane
on click.

**Page shape.** (1) **A fifth Jira page, `ticket`**, held like the other four and reached by a threaded link — fits the shell as it is, survives a reload,
and the Mentions page can open it later with one call. (2) URL hash routes (`#/jira/PAY-12`) — linkable from outside, but a router the client does not have,
and every other page would have to learn it. (3) A full-screen variant of the modal — cheap, but still a dialog over the board: it cannot be reached by key
without the board's poll, and Escape leaves it. **The user picked (1).**

## Decisions

The user's, from the canvas threads and the questions after them:

1. Layout B, in both the modal and the page.
2. The second tab is named **Delivery** (the mock said Development).
3. A target row is compact by default and expands into today's Delivery pane; older MRs of a target are folded under it.
4. **"skipped" is dropped for a "next step" marker** (§4.5): the first unfinished step of an open MR's track gets an accent ring and a `next` word, the
   compact row reads `next: <step>`, and the row's one button does that step — Detail only, the card and List unchanged. A `null` pipeline does not block
   (Review clean + no pipeline → next is Merge). The states are drawn in `States.dc.html`.
5. **Stop is hidden on a review session only** (§5.1) — a session whose link's `action` is `'review'`. Every other live session keeps Stop in its menu,
   as today.
6. Each History row has a **`Reopen`** button, as today.
7. The strip's live Agent pill is centred in its cell (a mock fix; the mock's `Review live` text is the card's, not the pill's — recorded so the builder
   checks the centring).
8. The tab is **remembered**: the last tab used opens the next ticket, in the modal and the page.
9. The page is a **fifth Jira page, `ticket`**.
10. Review skills get a **separate spec, right after** this one; picking one will open the launch sheet like Run (recorded for that spec).
11. A plain click opens the modal; **Cmd/Ctrl-click or middle-click opens the full page** directly. No setting (§2.3).
12. **A Pipeline or Review step can be ignored** (§4.5.1): an `Ignore` beside the row's button, remembered per MR in this browser while the step stays in
    the state it was ignored in. Covers a flaky or unrelated pipeline, and a repo with no review bot, where Review would otherwise read `next` forever.
13. **Open findings get no new action** (§4.5 row 5): a live review session already asks whether to fix or leave, so the button is `Open session` while
    one is linked to the key; with none, the row keeps today's review split, fix half preset. A "fix findings" review skill is the next spec's business.
14. **The review bot is never named** (§4.7): no drawn string, mock or doc of this change says CodeRabbit. Review skills exist so a team can use any
    reviewer; the bot is whatever account `BM_GITLAB_REVIEW_BOT` names.

Calls this spec makes, marked so the user can check them while reading: §1.3 (first-ever tab), §2.2 (rail row), §2.3 (back target), §3 (which facts sit
in the strip vs the Ticket tab), §4.1 (group key), §4.2 (which row opens), §1.2 (repo in a Delivery pill), §5.2 (History rows), §6 (children on the page).

## 1 The body: strip, tabs, panes

One component — call it `JiraTicketBody` (the name is the builder's) — draws the heading, strip, tab row and four panes from `{ issue, detail, ... }`. The
modal and the page each frame it (§2, §7); neither draws any of its parts.

### 1.1 Heading

The key in mono with the type and labels as tags, the summary as the title (22/600, today's), and the `← <key>` Back chip before the key while a walk is
open. The crumbs are NOT the body's: each frame draws its own (the modal's head keeps today's crumb line — type glyph, key, `· <type>`, `· in <parent key>
<parent summary>`, `· <sprint>`, §7.1; the page's top bar draws `Jira / <board> / <parent> / <KEY>`, §2.1), so the key shows once in the crumbs and once
in the heading on either frame.

### 1.2 Summary strip

One `--strip` band under the heading, a row of label-over-value cells (`Main.dc.html` `.strip`), wrapping on a narrow frame:

| Cell | Value | Control |
| ---- | ----- | ------- |
| Status | the status chip (category dot + raw status name) | it IS today's `Move to` control (the chip opens the popover, §8.9.2's Controls unchanged) |
| Assignee | initials disc + name, or today's `unassigned` | `Assign to me`, today's rules and titles |
| Sprint | sprint name | — (absent → cell not drawn) |
| Parent | the parent link (pushes the walk, today's behaviour) | — (absent → not drawn) |
| Delivery | one pill per target, `<target> · <word>` in `deliveryLook`'s tone (§4.2), led by the repo basename when the groups span more than one project (my call); ordered worst tone first (red, amber, then the rest in `leadOrder`), at most three, then `+N` in the worst tone among the folded ones; `kind: 'none'` → `no MR` (grey); `kind: 'unknown'` → `unknown` (grey, today's unknown title); not drawn when the Delivery tab is not | a pill click selects the Delivery tab and opens that target's row; `+N` selects the tab |
| Agent | live: a pill `<STATE_LABEL[state]> · <age>` (`shared/jira-sessions.ts`'s labels; the age is `pollAge` from the link's `stateSince`, or a `starting` reservation's `startedAt` — the session card's `LiveStrip` reading) led by the state's dot, centred in the cell, for the LEAD live session, then `+N` when more are live; otherwise `idle · N ended` or `no sessions` | a live pill click selects the Agent tab |

The Agent pill's lead is the live session that most wants the reader: one waiting on an answer (`question`) first, then `working`, then a `starting`
reservation, then any other live state; newest first within a state. So a waiting session is never hidden behind a newer working one.

The strip is the anti-goal's answer: a failed pipeline (red pill), findings to fix (amber), a session waiting on an answer (its state word) are all
visible on every tab. The write error line (`role="alert"`) sits under the strip, as it sits under the facts row today. `Run ▾` is not in the strip: it is
the frame's (§2.1, §7.1).

### 1.3 Tabs

`Ticket` · `Delivery <count>` · `Agent <count>` · `Children & comments <count>`, a `role="tablist"` of buttons with `aria-selected`, arrow keys moving
between them (the WAI-ARIA tabs pattern). Counts at 12 px `--ink3`: Delivery `N targets` (one target: `1 target`), Agent `N live` in the live tone when any
session is live else the ended count, Children the direct-children count. A count with nothing to say is not drawn.

- **Delivery** is drawn only when `deliveryShown` and the ticket's delivery is not `hidden` (the same condition the pane has today). Otherwise three tabs.
- **Remembered.** The selected tab is a `persistedStore` (`backlog-manager.jira-detail-tab`, values `ticket | delivery | agent | children`), shared by
  the modal and the page, written on every user selection (not on a fallback). A remembered tab that is not drawn for this ticket (Delivery on an unmapped
  project) falls back to `ticket` for this render without overwriting the store, so the next mapped ticket opens on Delivery again.
- **First-ever tab: `ticket`** (my call — it is the one tab every ticket can draw).
- A walk step (Children row, parent link, Back) keeps the selected tab.

### 1.4 Ticket pane

Two columns (`minmax(0,1fr) 340px`, stacked under 700 px): the description pane on the left — today's `renderMarkdown`, six-line clamp, `Show more` — and a
`Details` pane on the right holding the facts the strip does not: `Reporter`, `Priority`, `Labels`, `Created · updated`, `Resolved`, `On boards`, `Repository`
(with today's no-repository hint), `Session`. `Fact`'s rule stands: a fact with nothing to say draws nothing. `Resolved <date>` (the mock's row) is drawn from
`JiraIssue.resolved` when it is not `null`, as a sibling of `Created · updated`.

## 2 The ticket page

### 2.1 Page

`JiraPage` gains `ticket`: `JIRA_PAGES = ['board', 'sessions', 'mentions', 'setup', 'ticket']`. The key is a second `persistedStore`
(`backlog-manager.jira-ticket-key`), a `persistedStore<string>` whose guard accepts a Jira key (`isJiraKey` / `JIRA_KEY_RE`, `shared/types.ts` — the one definition) or `''`, with `''` as the
fallback meaning "no ticket" — `persistedStore` holds strings only, so "none" is the empty string, never `null`. A reload on the page reopens the same
ticket. `ticket` with an empty key is not a page: `JiraView` draws the Board for it and writes `board` back through `setJiraPage` in one effect, so the rail
never highlights a row it does not draw. (The App's hold-and-fall moves the section on `configured === false` only and is not involved; `useJiraPage`'s
guard sees one store and cannot do it.)

The page is a component under `JiraView` (so the launch sheet and `nudge` are the ones the board uses; the walk is the page's own, §2.3, and no modal opens
on the `ticket` page) that reads the detail by key
(`fetchJiraDetail`) and builds the `JiraIssue` half from it — `JiraIssueDetail extends JiraIssue`, so no new type. Until the read lands: `loading…`; a
failed read of any kind: today's line, `could not read the ticket — <the sentence fetchJiraDetail rejects with>` (the body draws it, so the modal and the
page word it alike), and on the page beside it `Retry` (reads again) and `Forget <KEY>` (sets the key store to `''` and returns to the origin, §2.3). No
404 branch: `fetchJiraDetail` rejects with a sentence only, and the server's sentence already says what went wrong.

**The page's frame before an issue exists** (first open, a reload, and every walk step, since the page has no card): the top bar draws the crumbs
`Jira / <KEY>` and `← <origin>`; `Open in Jira ↗` and `Run ▾` are not drawn (both need the issue). Below it, no strip or tabs: the heading row holds the
walk's `← <key>` Back chip (when the walk has a step to return to) and `<KEY>` in mono, then `loading…`, or the failure line with `Retry` and `Forget <KEY>`.
Once the read lands the full frame and body draw; a later failed re-read of an issue already drawn keeps it and shows the failure line under the strip,
as the modal does today.

Top bar (`Main.dc.html` `.topbar`): crumbs `Jira / <board name> / <parent key> <parent summary> / <KEY>` on the left — the board crumb only when the
ticket is on the picked board; on the right `← <origin>` (§2.3), `Open in Jira ↗`, and `Run ▾` (the split chip at 32 px, today's states). Under it the body
(§1) at the main area's width, tab panes capped at a readable max width (the builder's, ~900 px for single-column panes).

### 2.2 Rail

The Jira tree gains one row, `<KEY>` with the ticket glyph, drawn only while a key is held, under the other four (my call — a permanent `Ticket` row with
nothing to show would be an empty page). Clicking it opens the page; it is the rail's switch, so board.md's rule holds unchanged in shape. The key is
replaced by the next ticket opened on the page; it is never cleared by leaving (the row is how you get back). Only `Forget <KEY>` on a failed read clears
it (§2.1), so a ticket that no longer reads does not leave a row that opens an error forever.

### 2.3 Entering and leaving

- **Which frame a click opens** (decision 11). On every surface that opens Detail today — Board card, List row, agent-deck card, Sessions row, a Children
  row inside the modal — a plain click opens the **modal**, as today. **Cmd-click (macOS) / Ctrl-click (elsewhere) or a middle-click opens the page
  directly** on that ticket (key store set, `onOpenJiraPage('ticket')`, origin = the surface's page), with no modal in between. These surfaces are clickable elements (`role="button"` divs, `<tr>` rows, buttons),
  not links, so the modifier is read off the click event (`metaKey || ctrlKey`, `button === 1` via `onAuxClick`); a new browser tab is NOT opened — there is
  no URL to open it at. Each surface's `title` gains `⌘-click: full page` (`Ctrl-click: full page` off macOS). No setting.
- **Modal → page.** The modal's head gains `Open full page ↗` (an outlined 28 px link-weight chip beside `Open in Jira ↗`). It closes the modal, sets the
  key, and calls `onOpenJiraPage('ticket')`. `onOpenJiraPage`'s type stays `(p: JiraPage) => void`; the key is set through the store's setter first
  (`setJiraTicketKey(key)`), the same two-writer reason `useJiraPage` is a `persistedStore`.
- **Back.** `← <origin>` returns to the page that opened the ticket page (`Board`, `Sessions`, `Mentions`), held in memory, not persisted; after a reload or
  a rail-row entry it is `← Board` (my call).
- **Walk on the page.** A Children row or the parent link swaps the page's ticket (sets the key) and pushes onto an in-page walk, so the heading shows the
  same `← <key>` Back chip as the modal. The walk is the page's own state — not `JiraView`'s `OpenSlot`, which draws the modal — emptied when the page is
  left; every step and every Back writes the key store, so a reload lands on the ticket on screen.

## 3 What sits where

| Today (column) | After |
| -------------- | ----- |
| Head crumbs, title, `Open in Jira ↗` | heading (§1.1); `Open in Jira ↗` in the frame's head |
| Agent band: label, counts, `Run ▾` | `Run ▾` in the frame's head; counts in the strip's Agent cell and the Agent tab |
| Agent band: `No session on this ticket`, `default: … · last run …` sub-line, gate line | Agent tab (§5.1) |
| Session cards | Agent tab (§5.1) |
| Parent-live line, child-live line | Agent tab, above the cards, unchanged |
| Delivery pane | Delivery tab, once per target (§4) |
| History timeline | Agent tab, folded (§5.2) |
| Facts: Status, Assignee, Sprint, Parent | strip (§1.2) |
| Facts: Reporter, Priority, Labels, Created · updated, On boards, Repository, Session | Ticket tab's Details pane (§1.4) |
| Description | Ticket tab (§1.4) |
| Children | Children & comments tab (§6) |
| Worktrees | Delivery tab, a fold at the bottom (§4.6) |
| Comments note | Children & comments tab (§6) |

## 4 Delivery tab

### 4.1 Grouping

Over the MRs `ticketDelivery` already resolves for this ticket (its own, else the parent's for a sub-task — the `via` rule unchanged): group by
**(project, targetBranch)** (my call — two repos both into `develop` are two rows). Each group's representative is `leadMr` over that group's MRs (open
first, then newest `updatedAt`); the rest of the group are its **older MRs**. Groups are ordered by `leadOrder` over their representatives, so the first row
is the ticket's overall lead — the MR the card and List show — and the card, List and Detail never disagree on which MR leads. A new helper in
`lib/delivery.ts` (e.g. `deliveryTargets(mrs)`) owns this; the tab only draws it.

### 4.2 Tab head and rows

The head line: `Branch <source branch>` in mono (the representative's `sourceBranch` when all groups share one, else omitted), and right-aligned
`<N> targets · <M> MRs` (singular `1 target`, `1 MR`), plus `via <parent key>` when inherited. `kind: 'none'` and `'unknown'` draw today's sentences in place of rows.

Each group is a fold row (`Main.dc.html` `details.tgt`):

- **Compact (summary line).** Chevron, `into <target>`, the repo basename only when the ticket's groups span more than one project, `!<iid>` (a link to the
  MR, new tab), the MR title ellipsised, the compact five-dot track (`deliveryLook(mr).track` marks, no words), the state pill (§4.5's Pill column), the
  review word (`reviewStepWord`) at `--ink3`, `+N earlier` when older MRs exist, and the representative's age. No button: the summary line only folds.
- **Expanded.** Today's `DeliveryPane` for the representative: its head (`!iid ↗`, `<repo> → <target>`, polled age), the full track with step words
  (§4.5 rings the next one), and in the ReviewRow's place the **next row**: a hairline, a sentence on the left, the row's one button and `Ignore` on the
  right (§4.5's table says which). For a Review step the sentence is today's `reviewRowText`; for the other steps it is §4.5's Sentence column. A row with
  no button and no sentence draws no next row. Then the older MRs (§4.3). The pane's `Also:` line is gone — the other targets are rows and the rest are older.
- **Which row is open.** The first row (the overall lead) opens by default; the others are closed. A strip pill click opens its row. Fold state is
  per-render, not persisted, and resets on ticket swap (my call — a remembered open row for one ticket means nothing on the next).

### 4.3 Older MRs

Under the expanded pane, a nested fold, closed by default: `<N> earlier MRs into <target> · <x merged>, <y closed>` (`<z open>` too when there are older
open MRs). Singular `1 earlier MR`; a part that is zero is left out with its comma (`2 earlier MRs into demo · 2 merged`). Each row: `!<iid>` (link), a state pill (`merged` magenta, `closed` grey, `open`/`draft` per `deliveryLook`), `from <source branch>` in mono only
when it differs from the representative's, the title, and the age. Ordered newest `updatedAt` first. A target with no older MRs draws no fold.

### 4.4 Review per target

The ReviewRow moves from "the lead only" to **each expanded target whose representative is open** — the server already accepts any open MR of the ticket.
Its sentence, its play-button split and the sheet it opens are today's: `setLaunch({ issue, action: 'review', review: { half, mr: {project, iid,
sourceBranch}, repos } })` with that row's MR. `reviewGate` and the 409 paths are unchanged.

**Reserved slot.** The button is today's review play-button split (`ReviewRow`'s), in the place `Main.dc.html` draws `Review ▾`. The review-skills spec
([2026-11-20-jira-review-skills-design.md](2026-11-20-jira-review-skills-design.md)) turns it into a menu; this spec draws no menu and no skills.

### 4.5 The next step

A pure `deliveryNext(mr, now, ignored)` in `lib/delivery.ts` answers, for one MR, which track step is next, its word, the pill, the sentence and which
button the row draws — as a kind (`request | fix | run | merge | gitlab | null`) plus whether `Ignore` is offered. `ignored` is the MR's entry in the
ignore store (§4.5.1), or `undefined`. It never reads sessions: the caller turns `fix` into `Open session` when a live `review` link is on the key, else
into today's split with the fix half preset. Detail only: the card,
the List, the band and the filters keep `deliveryLook` as it is, and `deliveryLook` itself does not change. The track draws the next step's dot with a
dashed accent ring (`--cyan`, the board's action colour — dashed so it never reads as a reached green step) and, under the step label, `next · <word>`
when the row has a Next word, else `next`, in place of the step's own word. The compact row's state pill is the Pill column — `next: …` in the same accent
when something is next — and its five-dot track rings the same dot. When nothing is next no dot is ringed. `<n>` in `fix <n>` is `review.open`, written
`<n>+` when the review is `capped`. A waiting or done row's pill is `deliveryLook(mr).word` — never `.chip`, which repeats the `!<iid>` the row already
prints. The table is the user's, row for row (`States.dc.html` draws each):

| # | MR | Next | Pill | Sentence (non-Review rows) | Row button | Ignore |
| - | -- | ---- | ---- | -------------------------- | ---------- | ------ |
| 1 | open draft, review `none` | Review | `next: review` | — | `▶ Request review` (request half) | yes |
| 2 | open, review `null` (never read) | — (waiting) | `deliveryLook(mr).word` | `The review has not been read yet.` | none | yes — stored as `'unread'` |
| 3 | open, review `none` | Review | `next: review` | — | `▶ Request review` | yes |
| 4 | open, review `reviewing` | — (waiting) | `reviewStepWord(review)` | — | none | no |
| 5 | open, review `open` (findings) | Review — word `fix <n>` | `next: fix <n>` | — | `fix`: `Open session` while a live `review` link is on the key (it asks fix-or-leave); else today's split, fix half preset | yes |
| 6 | open, review `stale` | Review — word `re-review` | `next: re-review` | — | `▶ Request review` | yes |
| 7 | review `clean`, pipeline `running` | — (waiting) | `deliveryLook(mr).word` | — | none | no |
| 8 | review `clean`, pipeline `failed` | Pipeline — word `fix pipeline` | `next: fix pipeline` | `The pipeline failed — fix it in a Run session.` | `run`: a second `JiraRunMenu` (`home="modal"`), the same component and states as the frame's, disabled with `runBlockTitle` while a run is live | yes |
| 9 | review `clean`, pipeline `success` | Merged — word `merge` | `next: merge` | `Reviewed and green — merge happens in GitLab.` | `merge`: `Merge in GitLab ↗` (the MR's URL, new tab; the board never merges GitLab) | — |
| 10 | review `clean`, pipeline `null` or `'none'` | Merged — word `merge`; the Pipeline step keeps today's word (`pipelineWord`) and is not ringed | `next: merge` | `Reviewed, no pipeline — merge happens in GitLab.` | `merge` | — |
| 11 | review `none`, pipeline `success` | Review (the old "skipped" case: review is simply next) | `next: review` | — | `▶ Request review` | yes |
| 12 | review `clean`, pipeline `canceled` | Pipeline — word `re-run` | `next: re-run` | `The pipeline was canceled — re-run it in GitLab.` | `gitlab`: `GitLab ↗` (the MR's URL) | yes |
| 13 | merged | — (done) | `deliveryLook(mr).word` | — | none | — |
| 14 | closed | — (an older MR, or the representative of a target with only closed MRs) | `deliveryLook(mr).word` | — | none | — |

Precedence: Review before Pipeline before Merge — the first unfinished one wins, so a failed pipeline under open findings is row 5, not 8 (the fix half
fixes both). An ignored step (§4.5.1) counts as finished. A draft follows the same rows; its Pipeline step stays `off` (`deliveryLook`'s draft rule) and so never blocks or rings — a clean draft's
next is `Merged` with the word `mark ready`, pill `next: mark ready`, sentence `Still a draft — mark it ready in GitLab.`, button `gitlab`. `null` pipeline does not block (decision 4): worst case, Merge is offered a poll early. The
review buttons are today's ReviewRow split and launch (§4.4); the server's 409s cover the race where the state moved on. `unknown` review (too long to read)
waits like `reviewing` (pill `reviewStepWord(review)`, no button), but offers `Ignore`: `unknown` never clears on its own (`shared/review.ts` rule 0), so
without it such an MR could never reach `merge`. `review: null` (row 2) is the first poll's gap, but also any MR whose review
read has never succeeded — it stays `null` (`.claude/rules/gitlab.md`, the review fold) — so it offers `Ignore` too, or such an MR could never reach `merge`.

`Open session` (row 5) is the Agent card's open control (`SessionOpen`) for the newest live link on the key whose `action` is `'review'`; an ended review
session does not count (it already asked), and History's `Reopen` stays its way back.

#### 4.5.1 Ignoring a step

The rows the table marks draw a quiet `Ignore` text button after the row button (and `unknown`, §4.5). It ignores the step that is next — Review (states
`none`, `open`, `stale`, `unknown`, and `null` stored as `'unread'`) or Pipeline (`failed`, `canceled`) — for that MR:

- The step draws grey with the word `ignored` (its title: `ignored in this browser — click to stop ignoring`); clicking the word un-ignores. The compact
  track draws the dot grey.
- The marker moves to the next unfinished step, so a clean review over an ignored failed pipeline is row 9's `merge`.
- Stored under `backlog-manager.jira-ignored-steps` as one JSON object, `<project>!<iid>` → `{ review?: { state, landedAt }, pipeline?: { status,
  updatedAt } }`: the step's state when ignored (`review.state` is a `ReviewState` or `'unread'` for a `null` review, row 2), plus a stamp that moves when
  the thing behind it is redone — the review's `landedAt` (a new review round; `string | null`, and `null` is a real stamp: a `none` or unread review has
  no landing, and `null` stays `null` until one lands, which moves the state anyway) and the MR's `updatedAt` (a push). `persistedStore` holds one closed string, so this is a module store of the same shape (one listener set, every
  mounted reader re-renders on a write) over a JSON value — a sibling helper beside `persistedStore` or a generalisation of it, the builder's call. Its
  guard keeps only well-formed entries (a `review.state` that is a `ReviewState` or `'unread'` with a `landedAt` that is a string or `null`; a
  `pipeline.status` that is a `GitlabPipeline` with a string `updatedAt`) and drops the rest; anything unparseable reads as `{}`.
- An ignore holds only while the step still reads that state AND the stamp is unchanged; otherwise it is dropped on read, so a new review or a new push
  is judged fresh. Limit, accepted: a pipeline retried by hand on the same commit and failing again keeps its ignore (nothing on the MR moves) — the
  reader asked to ignore that commit's pipeline, and `ignored` is one click to undo. A comment that bumps `updatedAt` drops a pipeline ignore early —
  the safe direction. On every write, the entries of THIS ticket's delivery groups (§4.1) whose MR is no longer open are dropped; entries of MRs the
  ticket's delivery does not hold are never touched (they belong to other tickets), and nothing is pruned while the GitLab payload is `null` or the
  ticket's delivery is not `kind: 'mrs'`.
- This browser only, by design (no server route, no write): ignoring is a reader's call about what to look at next, not a fact about the MR.
- Detail only, as §4.5: the strip's Delivery pill, the card, the List and the filters keep `deliveryLook` — a failed pipeline stays red there.

### 4.6 Worktrees

Today's Worktrees section (`JiraWorktreeRow`, `Remove` copies the command, the running-session guard) moves to a fold at the bottom of the Delivery tab,
closed by default, `Worktrees <count>` in its summary. Drawn when the ticket has trees, whether or not Delivery has MRs — when Delivery is not drawn
(unmapped), the fold sits at the bottom of the Ticket tab instead.

### 4.7 The review bot is not named

Every string this change draws says `review` / `review bot`, never a product. Today's one drawn name goes: `reviewRowText`'s `CodeRabbit · ` prefix
(`lib/review-copy.ts`) becomes `Review · `. The review session's prompt (`reviewText` in `server/src/jira/prompt.util.ts`, `request` half) stops writing
`` `@coderabbitai review` `` and tells the session to post the review trigger the mr-review-loop skill uses (its trigger step), and — for a skill version that names none — to mention
the repository's review bot account with `review`, as the MR's earlier review threads show it. The prompt names no account itself. Not by passing `gitlabReviewBot` (`server/src/gitlab/env.util.ts`) in: `jira/` may import `gitlab/remote.util.ts` and nothing else
(`.claude/rules/jira.md`), and dispatch and the preview would both need the name threaded. `reviewText`'s signature and the preview/dispatch callers are
unchanged. Code
identifiers, file names and server comments keep their names — renaming them is churn with no reader. DESIGN.md's "CodeRabbit row" heading and the
board.md rule title "The CodeRabbit button is the MR's" are reworded with the docs (§10).

## 5 Agent tab

### 5.1 Live sessions

Today's band content, unchanged except as named: the parent-live and child-live lines, then one card per live session (newest first), a `starting`
reservation's card. With no live session: today's `No session on this ticket` and its sub-line `default: <action> · last run <age>` (`bandSub`), with
no `Run ▾` beside them (Run is in the frame's head). The gate line (`Next Run can start once this one is quiet.` / `Quiet — a new Run can start now.`,
today's `nextLine`) sits at the top of the Agent tab, above the cards — it explains the frame's `Run ▾` chip, and the Agent tab is where sessions are. Each card keeps its state strip, age,
linked-how tag and short id, and `SessionOpen`'s split — primary `Open`, and the `Session actions` menu with the secondary Open and `Unlink` (on a `branch`
link only).

**Stop is hidden on a review session** (decision 5): `JiraSessionCard` drops Stop from its menu when the link's `action` is `'review'`, on every surface
that draws the card. Every other session keeps Stop exactly as today (only while agents are on and the row carries a `stopState`).

### 5.2 History

A fold, **closed by default**: summary `History`, right-aligned `<N> ended · last <date, time>`. Open, one row per ended session (today's timeline data):
today's `JiraHistoryLine`, unchanged — `<how> · ended <age> ago`, the surface, the duration and the name, with `Reopen` where the row has a session id (my
call: the user asked for the button "like we have now"; the mock's absolute start time and action label are not drawn). The fold's open state is per-render.

## 6 Children & comments tab

Two folds: `Children <count>` **open by default** holding today's Children section (head pill, `SpreadBar`, tree, row click swaps the ticket — in the page,
§2.3), and `Comments` closed, holding today's `Comments stay in Jira — v1 neither reads nor writes them.` with the issue's link (the mock's comments copy
is not drawn). Children's states: detail loading → `loading…`; failed read → nothing (the Ticket tab carries the failure line, §2.1); zero children →
`No child tickets.` in the fold, and the tab's count is not drawn. On the page, the
tree is the detail read's direct children only (my call — the page mounts no board poll, so it has no lane walk; the modal keeps its deeper tree).

## 7 The modal

### 7.1 Frame

`JiraDetail` stays a composer of `ui/Modal`, drops the split shape's two columns, and draws a head + one body: the head holds the crumbs on the left and, on
the right, `Open full page ↗`, `Open in Jira ↗`, `Run ▾`, and the shell's close. The body is §1 below the head. How `Modal` draws a head with no facts slot
(a new shape, or the head with an empty facts slot) is the builder's call, as long as the scrim, Escape stack, exit and 700 px fold stay the shell's and
`test/ui/ui-modal.test.tsx` and `dialog-count-docs` stay green. The width stays today's.

### 7.2 Unchanged

The walk (`OpenSlot`, push/pop, `← <key>`), the one `useAction` write guard, the `shownKey` reset of per-ticket state, `useParentRead`, the launch sheet,
`nudge`, Escape closes the whole dialog.

## 8 What does not change

- Server: no route, no type, no request — except §4.7's prompt wording. `JiraIssueDetail`, `GET /api/jira/issue/:key`, the review dispatch and its 409s are as they are.
- The board card, the List, the agent deck.
- The Mentions page and its modal.
- `Run ▾`'s menu and the launch sheet.

## 9 Testing

The plan specifies behaviour and exact cases, never literal code. jsdom suites under `test/jira/`, pure-function suites beside them.

`lib/delivery.ts` (pure):

1. `deliveryTargets` on one MR → one group, no older.
2. Two open MRs into `develop` and `demo`, same project → two groups; order = `leadOrder` of the two.
3. `develop`: one open + two merged; `demo`: one open + three merged + one closed → `demo` group's older = 4, counts `3 merged, 1 closed`.
4. Same target in two projects → two groups.
5. A target with only merged MRs → its representative is the newest merged.
6. The first group's representative equals `leadMr(all).lead` for every fixture above.
7. `deliveryNext` returns, for each of §4.5's fourteen rows, exactly that row's next step, word and button; plus: findings open + pipeline failed → row
   5; clean draft → `mark ready`; `unknown` review → waiting; an ignored failed pipeline under a clean review → row 9; an ignored `none` review over a
   success pipeline → row 9; an ignore stored for `failed` with the pipeline now `running` → not ignored (row 7); a stored `failed` ignore whose
   `updatedAt` differs from the MR's → not ignored (row 8); `unknown` review → waiting with Ignore; pipeline `'none'` → row 10; pill and sentence of every
   row exactly as the table; `fix 3+` for a capped review with 3 open. `deliveryLook` output is byte-identical to today's for every fixture (no shared change).

Detail body (jsdom, rendered in the modal and on the page with the same fixtures):

8. The tab row has Ticket, Delivery, Agent, Children & comments; Delivery absent for a `hidden` ticket.
9. Selecting Agent writes the store; reopening another ticket opens on Agent; a ticket with no Delivery under a remembered `delivery` opens on Ticket and
   the store still reads `delivery`.
10. Arrow keys move the tab selection.
11. Strip: status chip opens `Move to`; `Assign to me` disabled with today's titles; a failing pipeline's pill is red on the Ticket tab (the strip is
    tab-independent); a live session's pill click selects Agent.
12. Delivery tab with the fixture of case 3: two rows; the first is open and shows the full track and the next row; the second's summary shows
    `+4 earlier`; opening it shows the nested fold reading `4 earlier MRs into demo · 3 merged, 1 closed`.
13. A strip Delivery pill click selects the tab and opens that row.
14. The `demo` row's next-step button (open representative, review `none`) calls the review launch with `demo`'s iid; a merged representative draws no
    button; the next dot carries the ring and the word `next`.
15. Agent tab: History fold closed by default with `5 ended`; opened, five rows each with `Reopen`; a live card whose link `action` is `'review'` has no
    `Stop session` even with a `stopState`; an `execute` card with a `stopState` still draws it.
16. Walk: Children row click swaps the ticket and keeps the selected tab; `← <key>` returns.

Page (jsdom):

17. `JIRA_PAGES` includes `ticket`; `isJiraPage('ticket')`.
18. Modal `Open full page ↗` → modal closed, key store set, page = `ticket`, page draws the ticket from `fetchJiraDetail` alone (no card fixture).
19. Page with a stored key and no board poll renders after the detail lands; `loading…` before; a failed read shows the sentence and `Retry`.
20. `ticket` with no key resolves to `board`.
21. Rail draws the `<KEY>` row only while a key is held; clicking it switches to the page.
22. `← <origin>`: entered from Sessions → `← Sessions` returns to Sessions; after a rail-row entry → `← Board`.
23. Cmd-click (and Ctrl-click, and middle-click) on a Board card, a List row, a deck card and a Sessions row → no modal, page = `ticket`, key set, origin
    = that page; a plain click on each → the modal, page unchanged.

24. Row 5 with a live `review` link on the key draws `Open session` (opening that session); with only an ended one, the fix-half split.
25. `Ignore` on a failed pipeline writes `{ pipeline: { status: 'failed', updatedAt: <the MR's updatedAt> } }` under `<project>!<iid>`, the step reads `ignored`, the pill reads `next: merge`; clicking
    `ignored` removes the entry; the strip's Delivery pill stays red throughout.
26. `reviewRowText` for an `open` review starts `Review · `; no drawn string in the Delivery tab contains `CodeRabbit` (rendered-text assertion); the
    `request` prompt contains no `@coderabbitai` and still names the mr-review-loop skill's trigger step.
27. Strip Agent pill: a `working` session newer than a `question` one → the pill shows the `question` session and `+1`.
28. Page with a failing read: `could not read the ticket — <sentence>`, `Retry` reads again, `Forget <KEY>` sets the key to `''` and returns to the origin;
    the rail row is then gone. A stored key that fails the guard (`foo`) reads as `''`.
29. Ignore store guard: a stored value with a bad `review.state`, a numeric stamp or non-JSON reads those entries as absent; `{ review: { state: 'none',
    landedAt: null } }` and `{ review: { state: 'unread', landedAt: null } }` survive a write and a re-read, and `Ignore` on a `none` review (row 3)
    still reads `ignored` after a remount (the store round trip, not `deliveryNext` alone).
30. Prune: ticket A ignores its open MR, ticket B's delivery merges a different MR → A's entry is untouched; A's own MR merges → A's entry is dropped on
    the next write; a write while the GitLab payload is `null` drops nothing.


Guards: grep `test/` for every hook and helper the diff adds a caller of (`useJiraPage`, `persistedStore`, `useOrchestratorRuns` if touched,
`fetchJiraDetail`) and run each hit (CLAUDE.md's source-guard rule).

The plan's last task is `/ui-verify` against the three views of `Main.dc.html` / `B-Modal.dc.html`: page on Delivery, modal on Agent with History open,
and a ticket with two targets — with live data where it exists and a fixture where the user's tickets have one target.

## 10 Docs that move with the code

- `.claude/DESIGN.md` §8.9.2 rewritten for the strip / tabs / panes and the page; §8.9.6's Detail paragraph for per-target rows, older MRs, Review per
  target, the next-step marker and Ignore, and "CodeRabbit row" renamed "Review row"; §8.0's rail tree for the conditional `<KEY>` row.
- `.claude/rules/board.md`: "The Jira section's four pages" → five, `ticket` and its key store named, `Open full page ↗` listed among the threaded links; the rule title
  "The CodeRabbit button is the MR's" → "The review button is the MR's", with `jira-ignored-steps` named in the §4.5.1 store list if one is kept there.
- `.claude/rules/board.md` line "The CodeRabbit button is the MR's": ReviewRow draws for **each expanded open target**, not "the LEAD MR only (`Also:`
  MRs get none)"; and the `Run ▾` rule's "the Detail dialog's agent column" → the Detail frame's head (and the `run` next row, §4.5).
- `.claude/rules/jira.md`, the `review` action bullet: the `request` half posts the skill's review trigger, no `@coderabbitai`.
- `.claude/DESIGN.md` §8.9.5's Review mode paragraph ("opened by the CodeRabbit row's button") → the review row.
- `docs/subsystems/invariants.md`: the headings behind board.md's anchors `#the-jira-sections-four-pages-…` and `#the-coderabbit-button-belongs-to-the-mr-never-to-run`
  are renamed with the rules, and each anchor in board.md, CLAUDE.md and the subsystem docs is updated to match (grep the old anchors; none may remain).
- `docs/subsystems/board.md` where it lists the Jira pages, and the same "four pages" in `docs/overview.md` and `docs/subsystems/jira.md`.
- `.claude/rules/board.md`'s Escape rule, which names `components/jira/JiraDetail.tsx` as the Move-to popover's home (update to the body component if it
  moves), and `hooks/persistedStore.ts`'s header list of its users (`useJiraTicketKey` and, if built on it, the ignore store).
- `lib/jira-page.ts` and `hooks/useJiraPage.ts` header comments (the latter already says "board, sessions or setup" — stale before this change).

## Left to the builder

- Component names and file split (`JiraTicketBody`, the page component, the delivery-targets helper).
- How `Modal` draws head + single body (§7.1).
- CSS class names, exact spacing, the tab underline style — follow `Main.dc.html` and DESIGN.md tokens.
- The page's max content width.
