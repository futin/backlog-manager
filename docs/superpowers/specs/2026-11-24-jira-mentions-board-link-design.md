# Jira › Mentions ↔ Board — design

Status: full design (project), one phase. Date: 2026-11-24. Branch `feat/jira-mentions-board-link`. No mocks: every mark below reuses a shape the board
already draws (named per item), and the plan's last task is `/ui-verify` against the live board.

Builds on [`2026-11-16-jira-mentions-design.md`](2026-11-16-jira-mentions-design.md) (the Mentions page and its modal) and
[`2026-11-19-jira-detail-tabs-design.md`](2026-11-19-jira-detail-tabs-design.md) (the ticket page, which its Non-goals left "Mentions ↔ ticket page … the link
itself is the next spec" — this is that spec, plus the opposite direction).

## Intent

The Jira section has two halves that do not know about each other. The **Board** (cards, List, the ticket modal `JiraDetail` and the ticket page) is where the
user works tickets; the **Mentions** page is where the user sees who asked them something. Two things go wrong, equally:

1. **A mention is invisible on the board.** A ticket someone asked the user about looks like every other card; the user only notices on a visit to Mentions.
2. **A mention has too little context to answer.** The mention modal shows the thread and a few ticket facts, but answering usually needs the branch, the MR,
   the sessions and the children — the ticket page's tabs. Today the modal says "This ticket is on none of your boards, so the board cannot open it" and
   offers nothing even when the ticket IS on a board; the user goes hunting.

## Goals

- **Board → mention.** Wherever the board draws a ticket that holds an open (not dismissed) mention, it draws an amber **mention marker**; clicking it opens the
  **mention modal** for that ticket, over the page the user is on.
- **Mention → ticket.** The Mentions page and its modal offer **Open ticket page**, which opens the **ticket page** (`?section=jira&ticket=<KEY>`) with origin
  `mentions`, so its `← Mentions` returns. This works for EVERY mention — the ticket page reads `fetchJiraDetail` by key and needs no board.
- **One mentions payload for the whole section.** The board's marker, the Mentions page and the mention modal read one poll, so a Dismiss in the modal clears
  the board's marker on the same render, and no two readers disagree for an interval.

## Non-goals

- Mentions on the **agent deck** (`JiraAgentDeck`) and in the Sessions page. Board cards, List rows and the ticket's summary strip only.
- Changing what an open mention is, the server's check, its cadence, or any route. This is client-only (no `shared/types.ts`, no server change).
- A mention filter or lane on the board ("show only tickets that ask me"). Mentions on tickets that sit on no board stay on the Mentions page only.
- Opening the board's ticket **modal** (`JiraDetail`) from a mention. The ticket page is the one landing, because it works for tickets on no board.
- Comments in `JiraDetail` / the ticket page. The thread stays the mention modal's (the mentions spec's `ModalB`, not picked, stays not picked).

## Anti-goals

- **A second mentions poller.** Two `useJiraMentions` instances would be two timers on one cache and two newest-read counters — exactly what
  `JiraMentionsView`'s header ("One read per page mount") and `board.md`'s poller rule exist to prevent. If the build ends with the hook called in two places, it failed.
- **The marker lagging a Dismiss.** Dismiss in the modal, close it, and the card still saying "asks you" until the next poll is a failure even though every
  piece "works".
- **Polling mentions while the Jira section is closed.** The two readers outside the section — the rail count (`SideRail`) and the Jira chip's popover
  `Mentions` row (`JiraChip`) — both read the status payload's `mentions` summary, never `useJiraMentions`; a shell-wide poll on top of them would read the
  cache every 3 min for nobody.

## Approaches (picked in the conversation)

1. **One shared mentions poll — a `JiraMentionsProvider` in `App`'s shell (picked).** Lift `useJiraMentions` into a provider beside `JiraSessionsProvider`;
   Board, ticket page, Mentions page and the mention modal read it through `useJiraMentionsContext()`. Dismiss/restore answers land in the one payload, so the
   marker clears at once. Cost: the Mentions page stops owning its hook, and `board.md`'s poller bullet ("called once, by the Mentions page") changes.
2. **The server adds a mention count to each board issue.** No new client poll (the cache is in server memory), but the marker moves on the board's clock
   (minutes), a Dismiss lags until the board re-reads, and `JiraIssue` plus the board payload change shape. Rejected: it hits anti-goal 2.
3. **The board mounts its own `useJiraMentions`.** Smallest diff; a second timer and counter. Rejected: anti-goal 1.

Landing for mention → ticket: **the ticket page (picked)** over the board's ticket modal, because the modal only exists for tickets the board's poll holds
and the mentions spec's own premise is that most mentions sit on no tracked board.

## Design

### 1. The provider

- `JiraMentionsProvider` (new, `client/src/hooks/JiraMentionsContext.tsx`), `JiraSessionsContext.tsx`'s shape: it calls `useJiraMentions` once and hands the
  whole `JiraMentionsState` down. Default context value is "nothing known" (`data: null`, writes resolving `{ ok: false, … }`, no fetch), so a test mounting
  a card or `JiraDetail` alone draws no marker and fetches nothing.
- Mounted in `App`'s shell, inside `JiraSessionsProvider` (the mention modal reads the sessions context for `sessionLink`), with
  `enabled = jiraConfigured === true && section === 'jira'`. `useJiraMentions` gains an `enabled` input: while false it arms no timer and makes no read, and
  keeps the last `data` (so leaving and re-entering the section draws the old markers at once and refreshes; the focus refetch also stays off while false).
  On the false → true edge it reads at once — the same as today's page mount.
- `JiraMentionsView` reads the context instead of calling the hook. Its "One read per page mount" header becomes "one read for the section": the
  provider is the one caller.
- `useJiraMentions`'s existing mechanics (one timer, sequence-numbered reads and POST answers, the 15 s draft re-read) are unchanged; only its caller moves.
- **One new trigger: the status says the cache is newer.** A check started outside the hook — the Jira chip's popover `Sync now` or its Mentions row
  refresh, which post the sweep themselves and re-read only the shell status (`JiraChip`'s `sweepMentions` → `reload`) — moves the rail count at once while
  the hook would wait out its own timer (up to ~3 min). Since a lagging marker is an anti-goal, the hook (it already reads `useJiraContext`) re-reads at
  once when the status payload's `mentions.polledAt` is later than its own payload's `polledAt` — through the same sequence-numbered `reload`, so no second
  request path. Test: a status update carrying a newer `mentions.polledAt` causes exactly one mentions read; an equal or older one causes none.

### 2. The mention marker (board → mention)

A small amber chip, the shape the board already uses for a count that waits on the reader (`DESIGN.md`: amber when something waits on the reader; the
mark `--amber-solid`, its word `--amber-ink` on the tint, as the warn pill does). Content `@ N`, where N is the ticket's open mentions (`mentions.length` of
the ticket's entry in `data.issues`; `dismissed` tickets draw nothing). Accessible name and `title`: `1 mention waits for your answer` /
`<n> mentions wait for your answer`. It is a `<button>`; its click opens the mention modal (§4) and never reaches the card's or row's own open — it stops
`click`, `auxclick` and an Enter/Space `keydown` from bubbling, the three `JiraCard`'s own handlers listen for (`JiraCard.tsx`'s `Contained` is the
pattern), so a keyboard press or middle-click on the marker never opens Detail or the ticket page. Tests cover the keyboard and middle-click cases.

**One home each** (`board.md`: one `components/ui/` home per look, one `lib/` home per derivation): the look is a new `components/ui/MentionMark.tsx`,
whose header cites `.claude/DESIGN.md` §7 (Chip) and §8.9.7. It is NOT a `Pill` (a `<span>` whose header says nothing in it is clickable) nor a `Marker`
(an unfilled word): it is `Chip` — already the board's one clickable control family — with a new `ChipVariant`, **`warn`**: the warn pill's amber tint
and `--amber-ink` word on the `.ui-chip` base, one `.ui-chip-warn` variant rule in the primitives block beside the other `ui-chip-*` variants (so the
design guard's one-base-rule-per-family holds; no new family). Size 28. `Chip.tsx`'s header and DESIGN.md §7 name the new variant. The words are one
`lib/jira-mentions.ts` function returning the `@ N` label and the `title` sentence for a count. All four homes draw `MentionMark`.

Where it draws, and nowhere else:

| Home | Where in it |
| ---- | ----------- |
| Board card (`JiraCard`) | In `.jira-card-head`, after the key (before the crumb). |
| Lane header (`JiraLaneHeader`) — a parent on the board is drawn here, never as a card; since the follow-up below, an off-board parent's header too | Beside the header's key. |
| List row (`JiraIssueList`): card rows AND the board-header row (kind `board`, the parent itself) — not the `none` lane row | In the summary cell, after the title, before `jira-issues-under`. |
| Summary strip (`JiraTicketStrip`, so both `JiraDetail` and `JiraTicketPage`) | A `Mentions` cell, the strip's last (after `Agent`): `MentionMark` (`@ N`). Absent when N is 0. |

Parents are in on purpose (user, 2026-11-24): a story or epic with children on the board is in no column (DESIGN.md §8.9.1), and questions are often
asked on exactly those. DESIGN.md §8.9.1's lane-header description gains the marker.

Off-board parents too (user, 2026-11-24, a follow-up to the first build): a parent on no board is still a ticket the user is asked on, and the modal opens
by key, so the `not on this board` lane header carries the marker beside its key as the on-board one does. The List's off-board header row still has none.

The strip draws wherever the strip draws — including a `JiraDetail` opened from the Sessions page. The Non-goal "Sessions page" means its own rows and deck,
not the ticket modal it opens.

The lookup is a `Map<key, JiraMentionIssue>` built from `data.issues` once per payload (a `useMemo` in a small `useMentionIndex()` helper beside the context),
so each card's read is one `get`. A payload that is `null`, unconfigured, or whose `polledAt` is null draws no marker — "not checked" is never "none", but it
is also never a guess.

### 3. Open ticket page (mention → ticket)

The control is worded **`Open ticket page`** everywhere, never `Open ticket` — the modal already has `Open ticket in Jira`, and the two must not read alike.
- **List row** (`JiraMentionList`): an icon-only `Chip size={28}`, matching its `Open in Jira` neighbour, in the hover action cell before it; glyph:
  `document` (the ticket's own page — `external`, the arrow out, stays `Open in Jira`'s alone, so the two icon chips side by side never look alike);
  `aria-label` and `title` `Open ticket page`. **Card** (`JiraMentionCards`): a text `Chip size={28}`
  `Open ticket page`, before `Reply in Jira`. Dismissed rows (Show dismissed on) offer it too — reading the ticket is not answering it.
- **Mention modal**: the right column's "This ticket is on none of your boards, so the board cannot open it." note is removed. A text chip
  `Open ticket page` takes its place — drawn by the modal itself from `issue.key`, OUTSIDE `TicketFacts` (which, with its `Open ticket in Jira` chip, draws
  only once the detail read is `ok`), so it is there while the ticket loads and after the read fails too; tests cover the loading and failed states. The
  head's "· on none of your boards" stays (still true, still useful). Its click closes the modal and opens the ticket page. **An unposted edit in the reply box is dropped, exactly as Close and Escape
  already drop it** (the box's text is local state, `JiraMentionModal`'s draft box); the server-held draft survives and is there on return. No new guard: a
  guard on this one exit and not the other two would be inconsistent.
- All three call one `onOpenPage(key)` threaded from `JiraView` — its existing `openPage`, which already computes the origin from the current page
  (`mentions` → `← Mentions`) and pushes the key store. A Cmd-, Ctrl- or middle-click on a mention row's key opens the page too, as a card's does on the board.

### 4. The mention modal over the board

- The modal is opened today only by `JiraMentionsView`, which wires about fifteen props (writes, drafts, sessions, handover). The build extracts that wiring
  into one host — a `MentionModalHost` (name is the builder's) that reads the writes, drafts, repos and session link from the mentions and sessions contexts —
  used by both `JiraMentionsView` and `JiraView`. Two hand-wired copies would drift.
- **The walk stays the caller's** (my call): the host takes the shown `{ issue, mention }`, `position`, `onPrev`, `onNext` and `onClose` from its caller,
  exactly the props the modal takes today. The Mentions page keeps its own walk untouched — `opened`, `lastAt`, `byTicket`, List steps per mention and Cards
  steps per ticket — so no tested page behaviour is rewritten. The board's caller computes its own, simpler walk (below).
- `JiraView` holds a `mentionOpen` slot beside `walk` and `launch`, cleared on a page change like them. The marker sets it with the ticket's newest mention;
  the walk (`Mention i of N`) runs over **that ticket's** open mentions, newest first — the board has no mentions order of its own.
- **The board walk when the payload moves under it.** The slot holds the opened snapshot `{ issue, mention }`, so the dialog never vanishes from under the
  reader. Every render re-reads the ticket's entry from the live payload: the order is its current `mentions`, `position`/`onPrev`/`onNext` come from the
  shown mention's place in it, and `state` is the page's own mapping (`MentionTicketState`: open, dismissed when the ticket is in `dismissed`, `gone` when
  in neither — answered or posted). A shown mention no longer in the order (Dismiss, a posted reply, answered elsewhere) draws no position and no
  neighbours, as the page draws a stop that left its order; a NEW mention arriving mid-walk joins the order and the position recounts.
- **The mention modal never opens over another modal.** Every `Modal` paints on one tier (scrim z 60, panel z 61, `styles.css`'s `.ui-modal-scrim` /
  `.ui-modal`), and `over` (62 / 63) is already `JiraReplyEditor`'s, which opens over the mention modal — a ticket modal under a mention modal under a reply
  editor would need a third tier. So the strip's marker inside `JiraDetail` **swaps** the dialogs: it empties the Detail walk and sets `mentionOpen` in one
  handler, so the ticket modal closes and the mention modal opens on the same render; Escape or Close then returns to the page beneath (Board or Sessions),
  not to the ticket modal. Opened from a card, header or row it is the only dialog; on the ticket page it opens over the page. The paint tiers, `ui/Modal.tsx`
  and the Escape-stack dialog count in `board.md` are all unchanged — it is the same dialog, with more homes. Test: the strip marker in an open `JiraDetail`
  leaves exactly one dialog mounted, the mention modal.
- Its **Open ticket page** from `JiraView`: on the ticket page for the same key it only closes; elsewhere it calls `openPage` unchanged, so the origin is the
  page the user is on — `board`, or `sessions` for a `JiraDetail` opened from the Sessions page (my call: `← Sessions` is where that user came from).
- After a Dismiss, the modal keeps its "Dismissed. It comes back…" footer with Undo (unchanged), and the marker behind it is gone on the same render.

## Constraints

- **Rule files that change** (each in the same PR as the code): `board.md` — the client-poller bullet (`useJiraMentions` is called once, by
  `JiraMentionsProvider`, gated on the section being open), the mention modal's homes, and the Jira-pages bullet that lists every link reaching the ticket
  page (it gains the Mentions row, card and modal `Open ticket page`, mirrored in `JiraView`'s header); `DESIGN.md` — the marker under the card and List row sections and
  §8.9.7's Open ticket page, and §7's new `warn` chip variant. The mentions spec gets a one-line "Superseded in part by" pointer at its "board cannot open
  it" note. `docs/subsystems/invariants.md`'s Escape-stack section ("It opens from the Mentions page and over nothing else") changes to the mention modal's
  homes and the never-over-another-modal rule (§4); `docs/subsystems/jira.md`'s client paragraph names the provider as `useJiraMentions`' caller. No new
  rendered-age cache (the marker shows no age), so the five-caches invariant is untouched.
- **Source guards.** Before pushing, `grep -l` each symbol the diff adds a caller of (`useJiraMentions`, `useJiraMentionsContext`, `JiraMentionModal`,
  `openPage`, `Chip`) in `test/` and add every hit to the scoped run (CLAUDE.md), plus `test/guards/design-guards.test.ts` for the new chip variant rule.
  If a guard pins `useJiraMentions`' caller list, it moves to the provider.
- The board's own poll, `JiraIssue` and every server route are untouched.

## Left to the builder

- The host's exact name and props; the index helper's name; whether `enabled` lives on the hook or the provider skips calling it (the hook must still be
  called unconditionally — React's rules — so most likely an input).
- Test shape: a provider-level test that one mount = one timer and that a closed section reads nothing; marker tests on card, lane header, both List row
  kinds and the strip (N, dismissed →
  none, `polledAt` null → none, click opens the modal and not the card); Open ticket page tests on row, card and modal (origin `mentions`); a Dismiss-from-board
  test asserting the marker is gone on the next render with no extra read.
- Final task: `/ui-verify` on the live board — a card, a lane header, a List card row and header row, and the strip with a marker, the modal over each, and
  Open ticket page landing on the page.
