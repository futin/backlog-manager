# Jira page, rebuilt around agent sessions — design

Date: 2026-11-03. Mocks: the Design canvas https://claude.ai/artifact/5XNcY5HrkwvP5NHjrkCFiw (private to its owner), with a copy of its artboards in
[2026-11-03-jira-sessions-mockups/canvas/](2026-11-03-jira-sessions-mockups/canvas/) and the first round in
[mocks.html](2026-11-03-jira-sessions-mockups/mocks.html). Picked: **Board B** (`BoardB.dc.html`), **List** (`List.dc.html`), **Detail**
(`Detail.dc.html`), and the state sheet (`States.dc.html`). `Main.dc.html` (Board A, three lanes) was not picked and is kept only for the record.

Builds on [2026-10-15-jira-integration-design.md](2026-10-15-jira-integration-design.md) (Run ▾, the live map, Stop),
[2026-10-16-jira-grouped-board-design.md](2026-10-16-jira-grouped-board-design.md) (the fold) and
[2026-10-20-jira-repo-branch-design.md](2026-10-20-jira-repo-branch-design.md) (repos, worktrees, the launch sheet).

## 1. Intent

Today's Jira Board page draws the picked Jira board as columns by status category. That duplicates Jira, which the user already has open. What Jira cannot
show is **which Claude session is working on which ticket, what that session is doing right now, and whether it is waiting on the user**. This page should
answer that, and get the user into the session in one click, in the Claude desktop app or in the agents dashboard.

Three things the user wants from the page, all equal:

1. **Who is on what** — every ticket that has an agent, and which agent.
2. **Jump in and steer** — open that session where it lives.
3. **What needs me** — sessions waiting on an answer, a permission, a plan approval or a reply.

## 2. Goals, non-goals, anti-goals

Goals:

- A ticket ↔ session link that is saved on this machine, survives a server restart, and keeps every session a ticket ever had as history.
- Two views of the Jira section's Board page — **Board** and **List** — behind one switch, and a **Detail** view that replaces today's issue modal.
- Open in Desktop and Open in Dashboard on every session, live or ended.
- The Jira rail entry shows how many sessions need the user.

Non-goals:

- Linking from a session's **name**, its transcript, or any other AI tool. The only automatic link is the branch rule in §5. Anything else is linked by hand
  with `/jira link`.
- Answering a question, approving a plan or granting a permission from this page. The page gets the user there; the session's own surface does the rest.
- Writing anything new to Jira. The link lives only here. The writes this page already makes (assign, transition, the launch sheet's) stay as they are.
- Changing the Setup page, the launch sheet, or the Run ▾ menu's actions.

Anti-goals — any of these makes the work a failure even if it ships:

- The page looks like Jira again: status columns as the main structure, with sessions as decoration.
- Any function today's Board page or issue modal has goes missing (§8 lists every one).
- The page says a session is live when it is gone, or sends the user into a session in a way that puts two processes on one transcript.

## 3. Decided by the user

- A session links to a ticket in one of three ways (§5): it was started by **Run ▾ on this board**; its **branch** carries the key in a repo mapped to that
  Jira project (a session started in Desktop, the CLI or the dashboard); or someone typed **`/jira link <KEY>`** in it. *(Revised 2026-11-03; the first
  round allowed only Run ▾.)*
- **A ticket can have several live sessions.** Run ▾ still refuses to start a second one itself (the one-run gate), but a session detected by branch or
  linked by hand is shown live beside whatever is already there.
- A ticket that appears on several Jira boards shows its sessions on each of them: the link is keyed by issue key, never by board (§5).
- The link is saved to disk, survives a restart, and is never written to Jira.
- A ticket keeps all its sessions as history. A finished session **detaches** from the ticket and stays as a history line on our board; the next Run (for
  example, a groom that plans, then an execute that builds) takes the ticket over.
- The Board view shows the **whole picked Jira board**, tickets with no agent included.
- Board layout **B**: live agents as a deck of cards on top; tickets with no live agent on three short shelves by status category.
- In the List view, **one row is one session**; a ticket worked twice shows twice.
- The Detail view as drawn: the ticket's agent on the left, the ticket on the right.
- The look is the board's own (`.claude/DESIGN.md`), no outside design system.

## 4. Calls I made (the user has not contested them; each can be overturned)

- **C1.** The Board | List switch replaces today's Board page; the rail's Jira tree stays `Board` / `Setup`. The switch is remembered per browser, the way
  `useJiraPage` remembers the page. **(User's pick, 2026-11-03:)** the switch is the existing `Segmented` with the `track` skin
  (`client/src/components/ui/Segmented.tsx`, DESIGN.md §8.11). That is the dashboard's own `.seg` view switcher, which GitHub › PRs' layout switch already
  uses. It is not a new control.
- **C2.** Open in Dashboard is always offered. **Open in Desktop is disabled while a dashboard-surface session's headless process is alive.** Opening it in
  the app then would put a second writer on the same transcript. "Alive" includes a held wait: a dashboard session waiting on an answer, a plan or a
  reply is still a running process mid-turn, so it is answered in the Dashboard. *(Builder check: the first draft enabled Desktop on `question`. The
  dashboard's own hand-over refuses exactly that case.)* Desktop enables once that process is gone or once the app owns the session (`desktopOwned`). For a
  dashboard-surface session, Open in Desktop goes through the dashboard's guarded hand-over (`POST /api/spawn` resume) via a route in `agents/`. It is
  never a raw `claude://` href, so the guard stays the dashboard's. A desktop- or CLI-surface session opens with `claude://resume?session=<id>` directly.
- **C3.** The **primary** button follows the session's surface: Desktop for a desktop-surface or desktop-owned session, Dashboard otherwise. The other is
  the secondary button.
- **C4.** The rail badge counts **only** sessions that need the user (§6), across every linked ticket, not just the picked board's. Because the Board's
  deck shows only the picked board's tickets, clicking the badge opens the **List** with Needs you and All tickets set, so the count always lands on the
  sessions it counted.
- **C5.** **Re-attach.** An ended session that becomes active again (the user resumed it in the app or the dashboard) is live again on its ticket, beside
  any other live session there (a ticket can hold several, §3).
- **C9.** A detected link can be wrong — a branch named after one ticket used for another. `/jira unlink <KEY>` in the session removes it, and a removed
  link is remembered so detection never re-adds it for that session. Detail offers the same Unlink on a session the branch rule linked.
- **C6.** History retention: the last 20 sessions per ticket, and a ticket whose newest session ended more than 90 days ago is dropped. The live session is
  never dropped.
- **C7.** The List view defaults to the picked board's tickets, with an **All tickets** chip that widens it to every linked session on this machine. A
  ticket that left the board still shows, from what was saved at launch (§5).
- **C8.** On the Board view the **Done** shelf starts collapsed to its 3 newest rows; To Do and In Progress show their first 8, each with `+ N more`.

## 5. The link store

What the server keeps for each session a Run starts:

- the Jira key, plus a snapshot of the ticket taken when the link is made: summary, type, and the **parent key Jira reports** (`detail.parent`). The List
  and the history need these even after the ticket has left the board. It is the parent, not the board's fold top, because a fold is per board and
  computed in the client. Where a live session sits on the board is still decided by the fold at render time. *(My call, from the builder check.)*
- the session id (as the dashboard answered it), the Run action (`execute`, `context`, `jira-groom`, …), the repo, the branch when the launch made one,
  the surface, the model, the effort.
- `startedAt`; `endedAt` and an end reason once it detaches: `idle`, `stopped`, `expired`, or `gone` (an answered dashboard list no longer carries the
  session, past the same grace — its transcript was moved or deleted).
- **how it was linked**: `run` (Run ▾), `branch` (detected), or `manual` (`/jira link`). Detail and the List show it as a small tag. A `branch` or `manual`
  link has no Run action; it shows the session's name instead.

How a link is made:

- **Run ▾** — as today, through dispatch.
- **Branch detection** — the server looks at every session the dashboard lists (it already fetches the whole `/api/sessions` list to reconcile). A session
  is linked when **both** are true: its `gitBranch` contains a Jira key as a whole token (`PAY-151` in `PAY-151-currency-rounding` or
  `feature/PAY-151`, never inside `XPAY-1510`), and its `projectPath` is one of the repos Setup maps to that key's Jira project. Detection runs only on
  sessions the dashboard reports as `working` or `question`. It never back-fills from old, idle transcripts. The dashboard's `gitBranch` is the
  branch the session **started** on (`transcript.ts` keeps the first one it sees), so a session that switches branches later does not move.
- **`/jira link <KEY>`** — a new subcommand of the `jira` skill. It posts the key and the session's own `CLAUDE_CODE_SESSION_ID` to a new route under
  `/api/jira`. It goes through the local server like every other `jira` command, never to Jira itself. The server checks that the key is a real issue
  (one read, through the existing poller) and refuses a session id the dashboard does not know. `/jira unlink <KEY>` is the inverse (C9).
- **One session, one ticket per link.** A session can be linked to more than one ticket (`/jira link` twice). A branch carrying two keys links to both.

**Several boards.** A Jira board is a saved query over issues, so the store is keyed by issue key and knows nothing about boards. A ticket on three boards
shows the same sessions on all three, the List lists each session once, and the badge counts each session once. There is one Jira connection, so a key
names one issue.

Rules:

- **It is a file under `~/.backlog-manager/`** (the builder names it), and **the server is its one writer**, written whole and atomically (temp file and
  rename). Nothing else reads or writes it. The registry's one-writer rule is the model; this is a second file with the same discipline, not a new field
  in `registry.json`.
- It replaces the memory-only live map as the source of which ticket is live. The map's guarantees carry over unchanged. `reserve` is still the
  synchronous one-run-per-ticket gate for **Run ▾ launches**: it refuses while a Run-linked session is live on the key, and ignores `branch` and
  `manual` links, which the user started outside this board. A `starting` entry is never evicted. `release` never drops a confirmed session. A key that was cleared stays cleared.
- **Detach.** The reconciler that today clears an entry when the dashboard stops reporting it `working` or `question` instead **ends** it. It keeps the
  existing 120 s grace. The entry gets `endedAt` and a reason and becomes history; the ticket is free for the next Run. Stop ends it with `stopped`. The
  8-hour backstop ends it with `expired` rather than deleting it.
- **A desktop launch with no session id** (an older dashboard) records nothing, as today.
- On start-up the server reads the file and resumes reconciling every live entry. A session that ended while the server was down is ended at the first
  reconcile, not on load.

## 6. Session state

Each live session's state comes from the dashboard's `GET /api/sessions` row (`claude-agents-dashboard`, `shared/types.ts` `Session`). Every flag
below is in that row today; checked 2026-11-03. Read the rows top to bottom; the first match wins.

| State shown              | From the dashboard row                                            | Needs you |
| ------------------------ | ----------------------------------------------------------------- | --------- |
| Starting…                | our entry has no session id yet                                   | no        |
| Waiting for plan approval | `remotePlan`                                                     | yes       |
| Waiting for permission   | `permissionWait`                                                  | yes       |
| Waiting for a reply      | `remoteReply`                                                     | yes       |
| Waiting on your answer   | `status: 'question'` with none of the three flags above (`remoteQuestion`, or the transcript's own question) | yes |
| Working                  | `status: 'working'`                                               | no        |
| Lost contact             | `status: 'incomplete'`, or the dashboard did not answer            | no        |
| Ended (history)          | `status: 'idle'` past the grace — detaches (§5)                    | —         |

Alongside the state, the page shows the row's `surface`, `desktopOwned`, model, effort and `contextPct`, and how long the session has been in that state.
A wait's age is measured from when this server first saw it in that state. While any session is live, its state should be no more than ~15 s old on
screen; today's 60 s reconcile is too slow for **Needs you**. The builder picks the mechanism, within the dashboard-load budget the reconciler already keeps.

`incomplete` means "your turn, or stalled" in the dashboard and cannot be split from its row. It is shown as Lost contact, does not count toward the badge,
and does not detach.

## 7. The views

### 7.1 Board (`BoardB.dc.html`)

- **Band**: board title, the sub line (site, issue and card counts, poll age — today's `bandSub`), the Board | List switch, the board picker, search.
  Today's filter bar (Type, Assignee, Sprint picks) stays under the band, unchanged in behaviour.
- **Agents deck**: one card per live session (Starting, any Needs you state, Working, Lost contact), Needs you first, then Working, then Starting and Lost
  contact; newest first within each. A card shows: the state strip with its age; type, key and the crumb `run · repo · surface · model`; the summary,
  which opens Detail; the primary and secondary open buttons (C2, C3); and the context %. A session on a ticket folded under a top issue shows the
  session's own key and names the top in its crumb.
- **Shelves**: To Do / In Progress / Done (`JIRA_COLUMNS`), one dense row per **top** issue (today's fold, unchanged) that has no live session on itself or
  on anything folded under it. A top with one is represented by its deck card and leaves the shelves. Every row keeps what today's card shows (§8). Its
  extra line is the newest ended session: `run ended <age>` plus a Reopen link, or `N sessions` when there are several. Lengths are per C8.
- Search and filters apply to the deck and the shelves alike, with today's fold-aware matching (`foldMatches`): a match inside a fold rings its top.

### 7.2 List (`List.dc.html`)

- One row per session; two groups, **Live** then **Ended**. Live is sorted by state priority (as the deck), then by start. Ended is sorted newest end first.
- Columns: State · Ticket (type, key, summary → Detail) · Run · Repo · branch · Where (surface) · Model · Context · Started · For (duration) · Open.
- Filter chips: All / Needs you / Working / Ended with counts; Repo; Run; a window of 24 h, 7 d (default), 30 d or all; All tickets (C7). Search covers
  key, summary, repo and branch.
- An ended row's Open is **Reopen**, the primary surface's link (C3), plus Run ▾ when the ticket has no live session.

### 7.3 Detail (`Detail.dc.html`)

Replaces `JiraIssueModal` and opens from any deck card, shelf row or list row. It is still a dialog with today's Escape behaviour and narrow-width fold.

- **Left, the agent**: one card per live session, stacked newest first, each with everything the deck card has, plus run, surface, model and effort, context, repo, branch, start, a
  shortened session id, how it was linked, Unlink for a `branch` link (C9), and **Stop**. Stop is today's `StopSession`, shown **only when the dashboard
  row carries `stopState`**, which is the dashboard's own rule for a session it can signal. A Desktop- or CLI-owned session, or a `processLive` one with no
  handle, gets no Stop. Otherwise it would end as `stopped` while still running, and C5 would re-attach it at the next reconcile. Below it, the history timeline, newest first, one line per session:
  `run · ended <when>`, surface, duration, and a Reopen link. The next Run ▾ sits last and is disabled while a session is live (the one-run gate).
  The mock shows the waiting question's text. That text is **not** in the dashboard row. Drop it unless the dashboard already exposes it elsewhere; adding
  it to the dashboard is out of scope.
- **Right, the ticket**: everything `JiraIssueModal` shows and does today (§8), regrouped as drawn.

### 7.4 Rail badge

The Jira rail entry carries the Needs you count (C4) and shows nothing at zero. It follows the board's existing rail-badge look.

## 8. Function that must survive (audit of today's page against the mocks)

The mocks leave several of these out to stay readable. The build keeps every one.

Board page (`JiraBoardView`, `JiraCard`, `JiraView`):

- board picker and the board sheet (`JiraBoardSheet`); search; Type / Assignee / Sprint picks; the band's sub line with fold counts and poll age;
- the fold: one card per top issue, its `C children · D below them` line with `SpreadBar`, the match ring naming the matching folded key;
- per card: type icon, key, crumb, summary, assignee initials, status **name** pill (a shelf is a category; the name still differs, such as "In Review"), age,
  the ↗ link to Jira, the priority and worktree markers, Run ▾ (`JiraRunMenu`) and its launch sheet (`JiraLaunchSheet`);
- the minute tick that re-ages cards without re-folding; the setup-needed and error states of today's page.

Issue modal (`JiraIssueModal`), all of which moves to Detail's right side:

- key and open in Jira ↗; the facts: type · parent, status · category, priority · sprint, assignee · reporter, labels, created · updated, on boards,
  repository (or the "no repository mapped" sentence), session;
- Assign to me (with its block reason), Move to (transitions, with its block reason), Run ▾, Stop, and the write-error line;
- the Worktrees list with Remove (`JiraWorktreeRow`);
- the Children tree, where a row swaps the dialog's issue, built from the board's `childrenOf` snapshot, with its `SpreadBar` progress;
- the description with its measured clamp.

## 9. Sections, in build order

1. **Link store and state.** Persisted links (§5), the state mapping (§6), and the read the client needs: per ticket, the live session and the history,
   each with state, ids, surface, model and context. Today's `live` on `GET /api/jira` keeps working for anything still reading it until section 2 lands. No
   UI change in this section beyond what today's strip already shows.
2. **Detection and `/jira link`.** The branch rule in the reconciler, the link and unlink route, and the `jira` skill's two subcommands. A `skills/` change
   reaches sessions only after commit, push and `pnpm run plugin:sync`.
3. **Detail.** Replaces the modal: the left column is new, the right is today's modal regrouped. Comes before the board, because both views open it.
4. **Board B.** Deck plus shelves; the switch arrives here, with List greyed until section 5 lands.
5. **List.**
6. **Rail badge.**

Each section ships as its own PR and leaves the page working.

## 10. Constraints

- Every route stays under `/api`. `agents/` stays the only module that calls the dashboard. The server writes no git and no item files.
- The dashboard deep link is `sessionUrl(settings.linkBase, id)` (`client/src/lib/agents.ts`), per device. The desktop link is per C2: the dashboard's
  guarded hand-over for a dashboard-surface session, `claude://resume?session=<id>` for the rest. On a device with no desktop app (a phone over the
  tailnet), the Desktop button does nothing useful; the builder decides whether to hide it there.
- If the served build's CSP (`server/src/security.ts`) blocks the `claude:` href, it changes, and a test pins whatever changes there.
- Docs: `docs/subsystems/board.md` and `api.md`, `.claude/DESIGN.md` §8.9 (the Jira views), and `.claude/rules/jira.md`, which governs `server/src/jira/**`
  and `server/src/agents/jira-*.ts`. The persisted store changes that rule file's live-map mechanism.

## 11. Left to the builder

The file name and schema version of the store; the shape of the client read (a new route, or extended `GET /api/jira`); how the reconcile gets to ~15 s
fresh; how history entries are paged in Detail; component names; whether Board A's files are deleted from the mock folder.

## 12. Test expectations (cases, not code)

- Store: survives a restart; a session that ended while the server was down ends at the first reconcile, not on load; reserve stays a synchronous gate;
  `release` never drops a confirmed entry; the 8-hour backstop ends with `expired`; caps per C6.
- Detach and re-attach: idle past the grace ends with `idle`. Idle inside the grace stays live. A resumed ended session re-attaches only when the ticket has
  no live session (C5).
- State table: one case per row of §6, including first-match order (a row that is `question` with `remotePlan` is plan approval, not answer).
- Buttons: dashboard-surface `working` → Desktop disabled. The same session in a held wait (`remoteQuestion`, `remotePlan`, `remoteReply`) → still
  disabled. The same session `idle` with no live process → enabled. `desktopOwned` → Desktop is primary. Stop appears only with `stopState`.
- End reasons: a session missing from an answered dashboard list past the grace ends `gone`; a dashboard that does not answer ends nothing.
- Badge click opens the List with Needs you and All tickets set.
- Badge: counts plan, permission, reply and answer only; zero draws nothing; a session on a ticket off the picked board still counts.
- Board: a top whose folded child has a live session leaves the shelves; search finds a folded issue through its ringed top; shelf lengths per C8.
- List: grouping, the two sort orders, every filter chip, the 7-day default window, All tickets.
- Detail: every item in §8's modal list is present and still works.
- Detection: `PAY-151-x` in a mapped repo links. The same branch in an unmapped repo does not. `XPAY-1510` does not match `PAY-151`. A branch with two keys
  links both. An `idle` session is never detected. A detected session on a ticket with a live Run session shows both live, and Run ▾ is still refused.
  A detected session on a ticket with only a branch link lets Run ▾ start.
- `/jira link` / `unlink`: an unknown key is refused; an unknown session id is refused. Unlink removes a branch link and detection never re-adds it.
- Several boards: one session on a ticket present on two boards shows on both, once in the List, and once in the badge.
