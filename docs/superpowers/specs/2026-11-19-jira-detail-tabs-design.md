# Jira › Detail — tabs, a ticket page, every MR per target — design

Status: written, awaiting approval. Date: 2026-11-19. Branch `jira-detail-tabs`. Amends DESIGN.md §8.9.2 (Detail dialog) and §8.9.6 (Delivery, the Detail
half only), and the board.md rule "The Jira section's four pages". Mocks: the Design-canvas artifact "Jira Detail" (<https://claude.ai/artifact/DPpfcBD3A4RDu1dq83fcjt>,
private, Version 6, nine comment threads all resolved), copied into [2026-11-19-jira-detail-tabs-mockups/](2026-11-19-jira-detail-tabs-mockups/) and read
against the code in [00-mock-audit.md](2026-11-19-jira-detail-tabs-mockups/00-mock-audit.md).

| Mock | What it fixes |
| ---- | ------------- |
| [Main.dc.html](2026-11-19-jira-detail-tabs-mockups/Main.dc.html) | The ticket PAGE on the Delivery tab: top bar, heading, summary strip, tab row, two target rows (the first open, the second with its older MRs folded), Worktrees fold |
| [B-Modal.dc.html](2026-11-19-jira-detail-tabs-mockups/B-Modal.dc.html) | The MODAL on the Agent tab: the same strip and tabs inside the dialog, a live session card with `Open`, History folded open with `Reopen` per row |
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
- Nothing Detail does today is lost, except what this spec removes by name (Stop on the Detail card, §5.1; the `Comments stay in Jira` sentence's place, §6).
- No new server route and no new Jira or GitLab request.

## Non-goals

- **Review skills.** Custom review skills (`Review ▾` with built-in CodeRabbit plus the user's own: Claude code review, backlog reviewer, MR review loop),
  the Run|Review group switch in Settings › Jira › Skills, drag reordering — all of `Review-Skills.dc.html` and the `Review ▾` menu in `Main.dc.html`. Its
  own spec follows this one; this spec only reserves the slot (§4.4).
- **Mentions ↔ ticket page.** The page is built to be reachable by key so that link is small; the link itself is the next spec.
- Comments: still read in Jira. v1's rule stands.
- The board card, the List and the agent deck: they keep `leadMr` and their look. Only the shared Review-step rule (§4.5) reaches them.
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
4. The Review step of an open MR that CodeRabbit has not reviewed, once Pipeline is reached, is **grey with `skipped` under it** (§4.5).
5. The live session card in Detail offers **Open only** — no Stop (§5.1). (Thread: "We can't stop code rabbit review, so let's remove stop, leave only Open".)
6. Each History row has a **`Reopen`** button, as today.
7. The `Review live` pill in the strip is centred in its cell (a mock fix; recorded so the builder checks it).
8. The tab is **remembered**: the last tab used opens the next ticket, in the modal and the page.
9. The page is a **fifth Jira page, `ticket`**.
10. Review skills get a **separate spec, right after** this one; picking one will open the launch sheet like Run (recorded for that spec).

Calls this spec makes, marked so the user can check them while reading: §1.3 (first-ever tab), §2.2 (rail row), §2.3 (back target), §3 (which facts sit
in the strip vs the Ticket tab), §4.1 (group key), §4.2 (which row opens), §5.1 (Stop stays on the deck), §6 (children on the page).

## 1 The body: strip, tabs, panes

One component — call it `JiraTicketBody` (the name is the builder's) — draws the heading, strip, tab row and four panes from `{ issue, detail, ... }`. The
modal and the page each frame it (§2, §7); neither draws any of its parts.

### 1.1 Heading

The key in mono with the type and labels as tags, the summary as the title (22/600, today's). Above it the crumbs as today: type glyph, key, `· <type>`,
`· in <parent key> <parent summary>` (the parent link, unchanged), `· <sprint>`, and the `← <key>` Back chip while a walk is open.

### 1.2 Summary strip

One `--strip` band under the heading, a row of label-over-value cells (`Main.dc.html` `.strip`), wrapping on a narrow frame:

| Cell | Value | Control |
| ---- | ----- | ------- |
| Status | the status chip (category dot + raw status name) | it IS today's `Move to` control (the chip opens the popover, §8.9.2's Controls unchanged) |
| Assignee | initials disc + name, or `Unassigned` | `Assign to me`, today's rules and titles |
| Sprint | sprint name | — (absent → cell not drawn) |
| Parent | the parent link (pushes the walk, today's behaviour) | — (absent → not drawn) |
| Delivery | one pill per target, `<target> · <word>` in `deliveryLook`'s tone (§4.3), at most three then `+N` | a pill click selects the Delivery tab and opens that target's row |
| Agent | live: a pill `<state label> · <age>` led by the state's dot, centred in the cell; otherwise `idle · N ended` or `no sessions` | a live pill click selects the Agent tab |

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
`Details` pane on the right holding the facts the strip does not: `Reporter`, `Priority`, `Labels`, `Created · updated`, `On boards`, `Repository` (with
today's no-repository hint), `Session`. `Fact`'s rule stands: a fact with nothing to say draws nothing. The mock's `Resolved` row is not drawn — no field
carries it today, and this spec adds no Jira request.

## 2 The ticket page

### 2.1 Page

`JiraPage` gains `ticket`: `JIRA_PAGES = ['board', 'sessions', 'mentions', 'setup', 'ticket']`. The key is a second `persistedStore`
(`backlog-manager.jira-ticket-key`, a string or `null`), so a reload on the page reopens the same ticket. `ticket` with no key is not a page: the
hold-and-fall resolves it to `board` (the same shape as an unknown stored page today).

The page is a component under `JiraView` (so the launch sheet, `nudge` and the walk slot are the ones the board uses) that reads the detail by key
(`fetchJiraDetail`) and builds the `JiraIssue` half from it — `JiraIssueDetail extends JiraIssue`, so no new type. Until the read lands: `loading…`; a
failed read: `could not read <KEY> — <the server's sentence>` with a `Retry`. A 404 (no such ticket, or not visible) says so and offers `← Board`.

Top bar (`Main.dc.html` `.topbar`): crumbs `Jira / <board name> / <parent key> <parent summary> / <KEY>` on the left — the board crumb only when the
ticket is on the picked board; on the right `← <origin>` (§2.3), `Open in Jira ↗`, and `Run ▾` (the split chip at 32 px, today's states). Under it the body
(§1) at the main area's width, tab panes capped at a readable max width (the builder's, ~900 px for single-column panes).

### 2.2 Rail

The Jira tree gains one row, `<KEY>` with the ticket glyph, drawn only while a key is held, under the other four (my call — a permanent `Ticket` row with
nothing to show would be an empty page). Clicking it opens the page; it is the rail's switch, so board.md's rule holds unchanged in shape. The key is
replaced by the next ticket opened on the page; it is never cleared by leaving (the row is how you get back).

### 2.3 Entering and leaving

- **Modal → page.** The modal's head gains `Open full page ↗` (an outlined 28 px link-weight chip beside `Open in Jira ↗`). It closes the modal, sets the
  key, and calls `onOpenJiraPage('ticket')`. `onOpenJiraPage`'s type stays `(p: JiraPage) => void`; the key is set through the store's setter first
  (`setJiraTicketKey(key)`), the same two-writer reason `useJiraPage` is a `persistedStore`.
- **Back.** `← <origin>` returns to the page that opened the ticket page (`Board`, `Sessions`, `Mentions`), held in memory, not persisted; after a reload or
  a rail-row entry it is `← Board` (my call).
- **Walk on the page.** A Children row or the parent link swaps the page's ticket (sets the key) and pushes onto an in-page walk, so the heading shows the
  same `← <key>` Back chip as the modal. The walk is the page's own state, emptied when the page is left.

## 3 What sits where

| Today (column) | After |
| -------------- | ----- |
| Head crumbs, title, `Open in Jira ↗` | heading (§1.1); `Open in Jira ↗` in the frame's head |
| Agent band: label, counts, `Run ▾` | `Run ▾` in the frame's head; counts in the strip's Agent cell and the Agent tab |
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
`<N> targets · <M> MRs`, plus `via <parent key>` when inherited. `kind: 'none'` and `'unknown'` draw today's sentences in place of rows.

Each group is a fold row (`Main.dc.html` `details.tgt`):

- **Compact (summary line).** Chevron, `into <target>`, the repo basename only when the ticket's groups span more than one project, `!<iid>` (a link to the
  MR, new tab), the MR title ellipsised, the compact five-dot track (`deliveryLook(mr).track` marks, no words), the state pill (`deliveryLook`'s chip word
  and tone), the CodeRabbit word (`reviewStepWord`) at `--ink3`, `+N earlier` when older MRs exist, and the representative's age.
- **Expanded.** Today's `DeliveryPane` for the representative, unchanged in content: its head (`!iid ↗`, `<repo> → <target>`, polled age), the full track
  with step words, the ReviewRow (§4.4). Then the older MRs (§4.3). The pane's `Also:` line is gone — the other targets are rows and the rest are older.
- **Which row is open.** The first row (the overall lead) opens by default; the others are closed. A strip pill click opens its row. Fold state is
  per-render, not persisted, and resets on ticket swap (my call — a remembered open row for one ticket means nothing on the next).

### 4.3 Older MRs

Under the expanded pane, a nested fold, closed by default: `<N> earlier MRs into <target> · <x merged>, <y closed>` (`<z open>` too when there are older
open MRs). Each row: `!<iid>` (link), a state pill (`merged` magenta, `closed` grey, `open`/`draft` per `deliveryLook`), `from <source branch>` in mono only
when it differs from the representative's, the title, and the age. Ordered newest `updatedAt` first. A target with no older MRs draws no fold.

### 4.4 Review per target

The ReviewRow moves from "the lead only" to **each expanded target whose representative is open** — the server already accepts any open MR of the ticket.
Its sentence, its play-button split and the sheet it opens are today's: `setLaunch({ issue, action: 'review', review: { half, mr: {project, iid,
sourceBranch}, repos } })` with that row's MR. `reviewGate` and the 409 paths are unchanged.

**Reserved slot.** The button is today's CodeRabbit play-button split, in the place `Main.dc.html` draws `Review ▾`. The review-skills spec turns it into a
menu; this spec draws no menu and no skills.

### 4.5 The `skipped` Review step

`deliveryLook` (shared by card, List and Detail): when the MR is **open**, its review state is `none` (CodeRabbit has not reviewed it), and a **later step
— Pipeline — is already reached**, the Review step's mark is **grey** and its step word is **`skipped`**: the work moved past review without one. Until a
later step is reached the Review step stays today's hollow "not reached" ring with no word. Merged stays magenta, closed stays off. This is the rule the
user was given in the canvas thread on the Review step.

The mock also draws a draft's Pipeline step green (`draft · pipeline passed`). The code makes a draft's pipeline `off` on purpose (`deliveryLook`'s header:
"a draft's red pipeline is work in progress, not a signal"). **This spec keeps the code**: a draft's Pipeline step stays off and its chip stays `draft`.

### 4.6 Worktrees

Today's Worktrees section (`JiraWorktreeRow`, `Remove` copies the command, the running-session guard) moves to a fold at the bottom of the Delivery tab,
closed by default, `Worktrees <count>` in its summary. Drawn when the ticket has trees, whether or not Delivery has MRs — when Delivery is not drawn
(unmapped), the fold sits at the bottom of the Ticket tab instead.

## 5 Agent tab

### 5.1 Live sessions

Today's band content, unchanged except as named: the parent-live and child-live lines, then one card per live session (newest first), a `starting`
reservation's card, `No live session on this ticket.` with `Run ▾`'s twin hidden (Run is in the frame's head). Each card keeps its state strip, age,
linked-how tag and short id, and `SessionOpen`'s split — primary `Open`, and the `Session actions` menu with the secondary Open and `Unlink` (on a `branch`
link only).

**Stop is not drawn in Detail** (decision 5). `JiraSessionCard` gains a prop that suppresses Stop; Detail passes it. **The agent deck on the Board page
keeps Stop** (my call — the user's thread was about Detail's card, and the deck is where a runaway session is caught at a glance). If the user meant every
surface, removing it from the deck is the same prop.

### 5.2 History

A fold, **closed by default**: summary `History`, right-aligned `<N> ended · last <date, time>`. Open, one row per ended session (today's timeline data):
start date-time, the action, the surface/how, the duration, and a `Reopen` button at the row's end — today's `Reopen`, same behaviour. The fold's open state
is per-render (my call).

## 6 Children & comments tab

Two folds: `Children <count>` **open by default** holding today's Children section (head pill, `SpreadBar`, tree, row click swaps the ticket — in the page,
§2.3), and `Comments` closed, holding today's `Comments stay in Jira — v1 neither reads nor writes them.` with the issue's link. On the page, the tree's
descendants come from the picked board's lane walk when the ticket is on the picked board (as the modal's `modalTree` does), else direct children only (my
call — no extra read).

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

- Server: no route, no type, no request. `JiraIssueDetail`, `GET /api/jira/issue/:key`, the review dispatch and its 409s are as they are.
- The board card, the List, the agent deck (except §4.5's shared rule).
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
7. `deliveryLook`: open non-draft, review `none`, pipeline `success` → Review step grey, word `skipped`; same with pipeline `null` → off, no word; review
   `open` → today's amber; merged → magenta, unchanged; draft → per §4.5's draft paragraph.

Detail body (jsdom, rendered in the modal and on the page with the same fixtures):

8. The tab row has Ticket, Delivery, Agent, Children & comments; Delivery absent for a `hidden` ticket.
9. Selecting Agent writes the store; reopening another ticket opens on Agent; a ticket with no Delivery under a remembered `delivery` opens on Ticket and
   the store still reads `delivery`.
10. Arrow keys move the tab selection.
11. Strip: status chip opens `Move to`; `Assign to me` disabled with today's titles; a failing pipeline's pill is red on the Ticket tab (the strip is
    tab-independent); a live session's pill click selects Agent.
12. Delivery tab with the fixture of case 3: two rows; the first is open and shows the full track and the CodeRabbit row; the second's summary shows
    `+4 earlier`; opening it shows the nested fold reading `4 earlier MRs into demo · 3 merged, 1 closed`.
13. A strip Delivery pill click selects the tab and opens that row.
14. Review button on the `demo` row (open representative) calls the launch with `demo`'s iid; a merged representative draws no Review button.
15. Agent tab: History fold closed by default with `5 ended`; opened, five rows each with `Reopen`; the live card has `Open` and no `Stop session` even when
    the row carries `stopState`. The Board deck's card with `stopState` still draws Stop.
16. Walk: Children row click swaps the ticket and keeps the selected tab; `← <key>` returns.

Page (jsdom):

17. `JIRA_PAGES` includes `ticket`; `isJiraPage('ticket')`.
18. Modal `Open full page ↗` → modal closed, key store set, page = `ticket`, page draws the ticket from `fetchJiraDetail` alone (no card fixture).
19. Page with a stored key and no board poll renders after the detail lands; `loading…` before; a failed read shows the sentence and `Retry`.
20. `ticket` with no key resolves to `board`.
21. Rail draws the `<KEY>` row only while a key is held; clicking it switches to the page.
22. `← <origin>`: entered from Sessions → `← Sessions` returns to Sessions; after a rail-row entry → `← Board`.

Guards: grep `test/` for every hook and helper the diff adds a caller of (`useJiraPage`, `persistedStore`, `useOrchestratorRuns` if touched,
`fetchJiraDetail`) and run each hit (CLAUDE.md's source-guard rule).

The plan's last task is `/ui-verify` against the three views of `Main.dc.html` / `B-Modal.dc.html`: page on Delivery, modal on Agent with History open,
and a ticket with two targets — with live data where it exists and a fixture where the user's tickets have one target.

## 10 Docs that move with the code

- `.claude/DESIGN.md` §8.9.2 rewritten for the strip / tabs / panes and the page; §8.9.6's Detail paragraph for per-target rows, older MRs, Review per
  target and `skipped`; §8.0's rail tree for the conditional `<KEY>` row.
- `.claude/rules/board.md`: "The Jira section's four pages" → five, `ticket` and its key store named, `Open full page ↗` listed among the threaded links.
- `docs/subsystems/board.md` where it lists the Jira pages.
- `lib/jira-page.ts` and `hooks/useJiraPage.ts` header comments (the latter already says "board, sessions or setup" — stale before this change).

## Left to the builder

- Component names and file split (`JiraTicketBody`, the page component, the delivery-targets helper).
- How `Modal` draws head + single body (§7.1).
- CSS class names, exact spacing, the tab underline style — follow `Main.dc.html` and DESIGN.md tokens.
- The page's max content width.
- Whether the strip's Delivery pills cap at three or fit-then-`+N`.
