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
  uses. It is not a new control, and Board | List is a view inside the Board page, not a third `JIRA_PAGES` entry; C4's badge click sets page `board` and view `list` through the same kind of module store.
- **C2.** Open in Dashboard is always offered. **Open in Desktop is enabled only when opening it cannot put a second process on the transcript.** The
  dashboard row's `surface` is `'local' | 'dashboard' | 'cloud'` (`claude-agents-dashboard/shared/types.ts`, `SessionSurface`); `local` is anything a
  person drives, the CLI or the desktop app, and the row cannot tell which. `cloud` rows have no local transcript and never reach this server.
  - `surface: 'dashboard'` with `desktopOwned`: enabled, as the href `claude://resume?session=<id>` (the app already owns it).
  - `surface: 'dashboard'` otherwise: enabled exactly when the dashboard's own hand-over would accept it — no `stopState`, no `processLive`, none of
    `remoteQuestion` / `remotePlan` / `remoteReply`, and `status` is `idle` or `incomplete` (the dashboard's `handOverState` → `'offer'` in
    `client/src/lib/resume.ts`, and its server's `resumeTarget` behind `POST /api/spawn`). A held wait is a running process mid-turn, so it is answered in the Dashboard.
    *(Builder check: the first draft enabled Desktop on `question`.)* When enabled it goes through that guarded hand-over (`POST /api/spawn` resume) via a
    route in `agents/`, never a raw `claude://` href, so the guard stays the dashboard's. The route is `POST /api/agents/jira-open-desktop { sessionId }`;
    like `jira-stop` it passes the dashboard's status and sentence through (501 `desktop app unavailable`, 400 `unknown session`, 409 `session is still
    running` / `already resuming` / `session is open in the desktop app`, 429, 500 `open failed`), an unreachable dashboard is a 502, and the button's
    error line shows the sentence.
  - `surface: 'local'`: enabled only while `status` is `idle` or `incomplete`, as the href `claude://resume?session=<id>`. While `working` or `question`
    the session may be a terminal mid-turn, and the app opening it would fork a transcript that terminal is writing. *(My call, review 1.)* The builder
    checks by hand what the app does with `claude://resume` on a live CLI session; if it refuses or only focuses, this case may enable — the test in §12
    changes with it.
  - A disabled Desktop button carries a title saying why: `Still running — open it in the Dashboard` (dashboard) or `Still running in a terminal or the
    app` (local).
- **C3.** The **primary** button follows the session's surface: Desktop for a `local` or `desktopOwned` session, Dashboard otherwise. When Desktop is the
  surface's pick but C2 disables it, Dashboard is promoted to primary. The other is the secondary button. Labels are in §7.5.
- **C4.** The rail badge counts **only** sessions that need the user (§6), across every linked ticket, not just the picked board's. Because the Board's
  deck shows only the picked board's tickets, clicking the badge opens the **List** with Needs you and All tickets set, so the count always lands on the
  sessions it counted.
- **C5.** **Re-attach.** An ended session that becomes active again (the user resumed it in the app or the dashboard) is live again on its ticket, beside
  any other live session there (a ticket can hold several, §3). It re-opens its own entry — `endedAt` and the reason are cleared — rather than adding a
  new one, so a session that pauses and resumes does not grow the history. A re-attached `run` link counts for the one-run gate again.
- **C9.** A detected link can be wrong — a branch named after one ticket used for another. `/jira unlink <KEY>` in the session removes it, and a removed
  link is remembered so detection never re-adds it for that session. Detail offers the same Unlink on a session the branch rule linked.
- **C6.** History retention: the last 20 sessions per ticket (past 20, the oldest `endedAt` goes first), and a ticket whose newest session ended more than 90 days ago is dropped. The live session is
  never dropped.
- **C7.** The List view defaults to the picked board's tickets, with an **All tickets** chip that widens it to every linked session on this machine. A
  ticket that left the board still shows, from what was saved at launch (§5).
- **C8.** On the Board view the **Done** shelf starts collapsed to its 3 newest rows; To Do and In Progress show their first 8, each with `+ N more`.

## 5. The link store

What the server keeps for each linked session (Run, branch or manual):

- the Jira key, plus a snapshot of the ticket taken when the link is made: summary, type, and the **parent key Jira reports** (`detail.parent`). The List
  and the history need these even after the ticket has left the board. It is the parent, not the board's fold top, because a fold is per board and
  computed in the client. Where a live session sits on the board is still decided by the fold at render time. *(My call, from the builder check.)*
- the session id (as the dashboard answered it), the Run action (`execute`, `context`, `jira-groom`, …), the repo, the branch when the launch made one,
  the surface, the model, the effort.
- `startedAt`; `endedAt` and an end reason once it detaches: `idle`, `stopped`, `expired`, or `gone` (an answered dashboard list no longer carries the
  session, past the same grace — its transcript was moved or deleted). The dashboard's `GET /api/sessions` is capped (`maxSessions`, at most 50 with
  `?limit=`, `server/api.ts` `SCAN_CAPS`) within `lookbackHours` (at most 168), so absence is not proof. The reconciler asks with `?limit=50&lookback=168`,
  and a session absent from a list that came back **full** (50 rows) is not judged — it stays live and the 8-hour backstop ends it as `expired`. Only an
  absence from a list shorter than the cap ends a session `gone`.
- **how it was linked**: `run` (Run ▾), `branch` (detected), or `manual` (`/jira link`). Detail and the List show it as a small tag. A `branch` or `manual`
  link has no Run action; it shows the session's name instead.

How a link is made:

- **Run ▾** — as today, through dispatch.
- **Branch detection** — the server looks at every session the dashboard lists (it already fetches the whole `/api/sessions` list to reconcile). A session
  is linked when **both** are true: its `gitBranch` contains a Jira key as a whole token (`PAY-151` in `PAY-151-currency-rounding` or
  `feature/PAY-151`, never inside `XPAY-1510`; the rule is `branchCarriesKey` in `shared/jira-branch.ts`), and its `projectPath` is one of the repos Setup
  maps to that key's Jira project **or a linked git worktree of one**. `projectPath` is the launch cwd, so a ticket-worktree session's is
  `<repo>/.worktrees/<branch, / → ->` (`worktreePathFor`, `shared/jira-branch.ts`) or any other linked worktree, never the mapped path; the row's `repo` is a folder name only. The server resolves a worktree to its main checkout by
  reading the `gitdir:` line of `<projectPath>/.git` (a file read, no git spawn), and compares that. Detection runs only on sessions the dashboard reports as
  `working` or `question`. It never back-fills from old, idle transcripts. The dashboard's `gitBranch` is the branch on the **newest** transcript record
  (`server/lib/transcript.ts` scans newest-first), so it follows a session that switches branch. Detection only ever adds: a link made from an earlier
  branch stays when the session moves on (Unlink removes it, C9), and the new branch's key, if any, adds its own link. A detected key is confirmed with one
  Jira read before it links, through the poller, and at most 5 such reads go out per tick; a 404 marks the (session, key) pair never-link, and any other
  failure leaves it for the next tick.
- **`/jira link <KEY>`** — a new subcommand of the `jira` skill. It posts the key and the session's own `CLAUDE_CODE_SESSION_ID` to
  `POST /api/agents/jira-link`, beside `jira-stop` in `agents/` (`jira-agents.controller.ts`), because checking the session id is a dashboard call and
  `agents/` is the only module that makes one (`.claude/rules/jira.md`: the edge runs agents → jira, never back). It goes through the local server like
  every other `jira` command, never to Jira itself; `jira.mjs`'s header, which names only `/api/jira` routes today, gains this one. The server checks that
  the key is a real issue (one read, through the existing poller; a 404, 429 or unreachable Jira refuses with the poller's own sentence) and refuses a
  session id only when the dashboard's `GET /api/sessions/:id/row` answers 404 — not on absence from the capped list, which proves nothing (above). `/jira unlink <KEY>` is
  the inverse (C9), `POST /api/agents/jira-unlink`; it refuses a `run` link (409 `<KEY> was started by Run ▾ — stop it from the board instead`), since
  dropping one would free the one-run gate under a live Run session.
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
  `manual` links, which the user started outside this board. A `starting` entry is never evicted. `release` never drops a confirmed session. An entry that has ended stays ended: a late `confirm` for it does not revive it (only C5's re-attach, from the dashboard's own row, does).
- **Detach.** The reconciler that today clears an entry when the dashboard stops reporting it `working` or `question` instead **ends** it. It keeps the
  existing 120 s grace, but on a second clock as well: today's grace runs only from `startedAt`; now each entry also records `quietSince`, the first tick
  that saw it neither `working` nor `question` (cleared whenever a tick sees it active again), and it ends only once both `startedAt` and `quietSince` are
  more than 120 s old. So a session is Quiet for two minutes after each finished turn, not only in its first two minutes. The entry gets `endedAt` and a reason and becomes history; the ticket is free for the next Run. Stop ends it with `stopped`. The
  8-hour backstop ends it with `expired` rather than deleting it.
- **A desktop launch with no session id** (an older dashboard) records nothing, as today.
- On start-up the server reads the file and resumes reconciling every live entry. A session that ended while the server was down is ended at the first
  reconcile, not on load.
- **Arming and rate.** Today the reconciler's `setTimeout` chain is armed by `confirm` and runs only while some entry holds a session id
  (`server/src/agents/jira-live.service.ts`, `hasConfirmed`), so branch detection would never run on an empty store. It now stays armed while the store
  holds a live entry **or** Setup maps at least one repo (detection has something to find), and start-up arms it under the same rule. Its period is ~15 s
  while a Jira page is open in some client (the builder picks how the server knows, e.g. a recent `GET /api/jira` read) and today's 60 s otherwise — one
  `GET /api/sessions` per tick either way, and still never in a request's path.
- **The dashboard read carries rows, not statuses.** `dashboardSessions` (`server/src/agents/dashboard-sessions.util.ts`) returns `id → status` today;
  the reconciler needs each row's `status`, `surface`, `desktopOwned`, `stopState`, `processLive`, `remoteQuestion`, `remotePlan`, `remoteReply`,
  `permissionWait`, `projectPath`, `gitBranch`, `sessionName`, model, effort and `contextPct`. The builder widens it, or adds a sibling, without changing
  what its three existing readers see.

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
| Quiet                    | `status: 'incomplete'`, `quietSince` less than 120 s ago (§5)      | no        |
| Lost contact             | the dashboard did not answer this tick                            | no        |
| Ended (history)          | `status: 'idle'` or `'incomplete'` past the grace — detaches (§5)  | —         |

Alongside the state, the page shows the row's `surface`, `desktopOwned`, model, effort and `contextPct`, and how long the session has been in that state.
A wait's age is measured from when this server first saw it in that state. While any session is live, its state should be no more than ~15 s old on
screen while a Jira page is open; today's 60 s reconcile is too slow for **Needs you**. The server's rate is in §5 (Arming and rate). The client's
cadence matters too: `useJira` polls `GET /api/jira` at the soonest board's sync interval with a 15 s floor, and not at all when no board syncs. So the
live-session read polls on its own 15 s timer while a Jira page is on screen, whatever the boards' sync settings.

`incomplete` means "your turn (recent and done) or stalled" in the dashboard (`server/lib/scan.ts`) and cannot be split from its row; a `local` session
reads it after every finished turn. It is shown as **Quiet**, with the title `Turn finished or stalled — the dashboard cannot tell which`, and does not
count toward the badge. Past the grace it detaches with `idle`, as today's reconciler already clears it, so a crashed Run session frees the one-run gate
within minutes instead of holding it for 8 hours; when the user next types, C5 re-attaches the same entry. **Lost contact** is only the dashboard not
answering: every live entry keeps its last state, marked as stale, and nothing ends.

## 7. The views

### 7.1 Board (`BoardB.dc.html`)

- **Band**: board title, the sub line (site, issue and card counts, poll age — today's `bandSub`), the Board | List switch, the board picker, search.
  Today's filter bar (Type, Assignee, Sprint picks) stays under the band, unchanged in behaviour.
- **Agents deck**: one card per live session (Starting, any Needs you state, Working, Quiet, Lost contact), Needs you first, then Working, then Quiet,
  then Starting and Lost contact; newest first within each. A card shows: the state strip with its age; type, key and the crumb `run · repo · surface · model`; the summary,
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
  key, summary, repo and branch. The window filters **ended** rows on `endedAt`; live rows are always shown, whatever the window.
- An ended row's Open is **Reopen**, the primary surface's link (C3), plus Run ▾ when the ticket has no live `run`-linked session — the one-run gate's own
  rule (§5); a live `branch` or `manual` link does not hide it. The launch sheet's 409 stays the authority if the two ever disagree.

### 7.3 Detail (`Detail.dc.html`)

Replaces `JiraIssueModal` and opens from any deck card, shelf row or list row. It is still a dialog with today's Escape behaviour and narrow-width fold, and takes the modal's slot on the Escape stack (`.claude/rules/board.md`), so the count of dialogs there does not change.

- **Left, the agent**: one card per live session, stacked newest first, each with everything the deck card has, plus run, surface, model and effort, context, repo, branch, start, a
  shortened session id, how it was linked, Unlink for a `branch` link (C9), and **Stop**. Stop is today's `StopSession`, shown **only when the dashboard
  row carries `stopState`**, which is the dashboard's own rule for a session it can signal. A Desktop- or CLI-owned session, or a `processLive` one with no
  handle, gets no Stop. Otherwise it would end as `stopped` while still running, and C5 would re-attach it at the next reconcile. Because a ticket can hold
  several live sessions, Stop names one: `POST /api/agents/jira-stop` takes `{ key, sessionId }` (today it takes `{ key }`). The session ends with
  `stopped`; a `sessionId` that is not live on that key is a 409, and today's other answers (agents off, `starting`, the dashboard's 404 / 502) keep their
  meaning per session. Below it, the history timeline, newest first, one line per session:
  `run · ended <when>`, surface, duration, and a Reopen link. The next Run ▾ sits last and is disabled while a `run`-linked session is live (the one-run
  gate, §5); a live `branch` or `manual` link does not disable it.
  The mock shows the waiting question's text. That text is **not** in the dashboard row. Drop it unless the dashboard already exposes it elsewhere; adding
  it to the dashboard is out of scope.
- **Right, the ticket**: everything `JiraIssueModal` shows and does today (§8), regrouped as drawn.

### 7.4 Rail badge

The Jira rail entry carries the Needs you count (C4) and shows nothing at zero. The rail has no badge today (`SideRail.tsx` draws a chip slot, the
version chip and the cursor), so this is a new element built from existing tokens: DESIGN.md's `Badge count` type (11 px / 500), a `radius-full` pill,
and the FilterBar funnel's 16 px `--ink` count badge (`.filter-bar-badge` in `styles.css`) as the model. DESIGN.md's rail section gains it.

### 7.5 Open buttons — labels

One table for every surface that draws them (deck card, Detail's live card, List row). The state is §6's. Read the rows top to bottom; the first match
wins. Waiting for permission gets no verb: the dashboard shows `permissionWait` but nothing can answer that dialog remotely (its `shared/types.ts`), so
it falls to `Open in Dashboard` (or the Desktop row), and the state strip's title says the dialog is answered where the session runs.

| Case                                     | Primary                                 | Secondary   |
| ---------------------------------------- | --------------------------------------- | ----------- |
| `dashboard` surface, not `desktopOwned`, Waiting on your answer | `Answer in Dashboard` | `Desktop` |
| `dashboard` surface, not `desktopOwned`, Waiting for plan approval | `Review plan in Dashboard` | `Desktop` |
| `dashboard` surface, not `desktopOwned`, Waiting for a reply | `Reply in Dashboard` | `Desktop` |
| Primary is Dashboard, any other live state (a `local` wait included) | `Open in Dashboard`                   | `Desktop`   |
| Primary is Desktop (C3), any live state  | `Open in Desktop`                       | `Dashboard` |
| Ended (history line, List's ended row)   | `Reopen` (the primary surface's link)   | none        |

A `local` session's wait can be answered only where it runs, which the row cannot name, so it gets no verb: its Desktop is disabled while it waits (C2)
and the title says where to go. The secondary is the short form; Detail's live card, which has the width, spells it out (`Open in Desktop`, `Open in Dashboard`). A disabled Desktop
keeps its label and carries C2's title. The mocks were brought in line with C2 after review 1 (Desktop disabled on PAY-151, PAY-140 and PAY-143). Where
a mock and this table still differ, the table wins.

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
   each with state, ids, surface, model and context. Today's `live` on `GET /api/jira` keeps working until section 4 retires its readers (`JiraIssueModal`, `client/src/lib/jira.ts`'s run state), and
   until then it carries the live `run`-linked entry per key only, so a `branch` or `manual` link never disables Run ▾ where `reserve` would allow it. No
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
- The served build's CSP (`server/src/security.ts`) has no directive that governs an `<a href="claude://…">` navigation, so no change is expected there; if one turns out to be needed, a test pins it.
- Docs: `docs/subsystems/board.md` and `api.md`, `.claude/DESIGN.md` §8.9 (the Jira views) and its rail section (the badge, §7.4), and
  `.claude/rules/jira.md`, which governs `server/src/jira/**` and `server/src/agents/jira-*.ts`. The persisted store changes that rule file's live-map
  mechanism, and overturns its `Why:` entry in `docs/subsystems/invariants.md` ("A Jira session is remembered in server memory only, and Stop is the one
  hand that clears it early"): that entry is renamed for the persisted store, and its old anchor is kept or redirected so links into it still land.

## 11. Left to the builder

The file name and schema version of the store; the shape of the client read (a new route, or extended `GET /api/jira`); how the reconcile gets to ~15 s
fresh; how history entries are paged in Detail; component names; whether Board A's files are deleted from the mock folder.

## 12. Test expectations (cases, not code)

- Store: survives a restart; a session that ended while the server was down ends at the first reconcile, not on load; reserve stays a synchronous gate;
  `release` never drops a confirmed entry; the 8-hour backstop ends with `expired`; caps per C6.
- Detach and re-attach: idle past the grace ends with `idle`; so does `incomplete` past the grace. Idle inside the grace stays live. A resumed ended
  session re-attaches as live even when the ticket already has a live session, and re-uses its own entry (history length unchanged) (C5).
- State table: one case per row of §6, including first-match order (a row that is `question` with `remotePlan` is plan approval, not answer).
- Buttons (C2, C3, §7.5): a `desktopOwned` session in `question` → `Open in Desktop`, not `Answer in Dashboard`. Permission wait → `Open in
  Dashboard`. `dashboard` `working` → Desktop disabled. The same session in a held wait (`remoteQuestion`, `remotePlan`, `remoteReply`) →
  still disabled. `dashboard` `idle` with `stopState` → disabled; with `processLive` → disabled; with neither and no hold → enabled; `incomplete`, same
  → enabled. `desktopOwned` → Desktop enabled and primary. `local` `working` or `question` → Desktop disabled and Dashboard promoted to primary; `local`
  `idle` → Desktop enabled and primary. Answer, plan and reply each give their own primary label. Stop appears only with `stopState`.
- Stop: `{ key, sessionId }` on a ticket with two live sessions ends only that one, `stopped`; a session id not live on the key is a 409.
- End reasons: a session missing from an answered dashboard list of fewer than 50 rows, past the grace, ends `gone`; missing from a full list of 50, it
  stays live; a dashboard that does not answer ends nothing and shows Lost contact. `incomplete` past the grace ends `idle`.
- Badge click opens the List with Needs you and All tickets set.
- Badge: counts plan, permission, reply and answer only; zero draws nothing; a session on a ticket off the picked board still counts.
- Board: a top whose folded child has a live session leaves the shelves; search finds a folded issue through its ringed top; shelf lengths per C8.
- List: grouping, the two sort orders, every filter chip, the 7-day default window, All tickets. A live session started 10 days ago shows under the 7-day
  window; a session that ended 10 days ago does not. Run ▾ shows on an ended row whose ticket has only a live `branch` link.
- Detail: every item in §8's modal list is present and still works.
- Detection: `PAY-151-x` in a mapped repo links. The same branch in an unmapped repo does not. `XPAY-1510` does not match `PAY-151`. A branch with two keys
  links both. An `idle` session is never detected. A detected session on a ticket with a live Run session shows both live, and Run ▾ is still refused.
  A detected session on a ticket with only a branch link lets Run ▾ start. A session whose `projectPath` is `<mapped repo>/.worktrees/PAY-151-x`
  (its `.git` file pointing into the mapped repo) links; a worktree of an unmapped repo does not. A session that moves from `PAY-151-x` to `PAY-160-y`
  keeps its PAY-151 link and gains PAY-160. Detection runs with an empty store as long as Setup maps a repo.
- `/jira link` / `unlink`: an unknown key is refused; an unknown session id is refused. Unlink removes a branch link and detection never re-adds it. Unlink of a `run` link is a 409. `/jira link` while the dashboard's list is full but its
  row route answers 200 links. A detected key Jira answers 404 for is never linked; a 429 retries next tick.
- Quiet: a session that finishes a turn 10 minutes after it started shows Quiet for 120 s, then ends `idle`; one that works again inside the 120 s stays
  live and its `quietSince` clears.
- Several boards: one session on a ticket present on two boards shows on both, once in the List, and once in the badge.
