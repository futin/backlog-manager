# Review 2 — `2026-11-03-jira-sessions-design.md`

Reviewer: Fable 5.1, fresh subagent, 2026-11-03. Document: `docs/superpowers/specs/2026-11-03-jira-sessions-design.md` (337 lines, after commit
5dd14830). Code read in this worktree and in `claude-agents-dashboard` at its checkout. Every `file:line` below was read, not inferred from the document.
Round 1's findings that 5dd14830 fixed are not repeated; the fixes themselves were re-checked against the code, and two of them carried a false fact in.

## Verdict: REVISE

No Critical finding: the three round-1 contradictions are resolved and the document no longer disagrees with itself on re-attach, the Run ▾ gate or the
anti-goal. Eleven Important findings remain — two false facts the round-1 fixes introduced (the worktree path, the predicate's name), one label that
promises an action the dashboard cannot perform, and gaps (the grace clock, the client's poll cadence, `live[key]` between sections 2 and 4, the Jira
read every link needs, `/jira link` on a capped list, `/jira unlink` on a `run` link) where an implementer would have to guess. Each is a sentence or
two to fix.

## Critical

None.

## Important

- **[I] 125, 333–334 — the ticket worktree path is `<repo>/.worktrees/<branch>`, not `<repo>/.claude/worktrees/<branch>`.** `worktreePathFor` returns
  `` `${repo}/.worktrees/${branch.replaceAll('/', '-')}` `` (`shared/jira-branch.ts:133-136`); `jira.mjs` puts its trees under the same `.worktrees/`
  (`skills/jira/tools/jira.mjs:345-348`), and the 2026-10-20 spec rules it (`docs/superpowers/specs/2026-10-20-jira-repo-branch-design.md:246`).
  `.claude/worktrees/` is this app's own session worktree, not a ticket's. The `gitdir:` mechanism is path-agnostic, so only the stated example and the §12
  test value are wrong — but a test written from the document would build the wrong fixture.
  → Write `<mapped repo>/.worktrees/PAY-151-x` in both places (and note that any linked worktree, wherever it lives, resolves the same way).
- **[I] 75–76 — the predicate C2 names is the wrong function.** `stillRunningNote` (`claude-agents-dashboard/client/src/lib/resume.ts:81-89`) is true
  exactly when `processLive` is set and nothing else blocks — the DISABLED case. The predicate the spec spells out (no `stopState`, no `processLive`, no
  hold, status `idle`/`incomplete`) is `handOverState(...) === 'offer'` (`resume.ts:53-64`) / `resumeEligible` (`:32-44`), and the server's checks are
  `resumeTarget` (`server/api.ts:1264-1297`), which also refuses a session the desktop app holds (`desktopLiveSessionIds`, 409) and one mid-hand-over
  (`listLaunching`, 409).
  → Name `handOverState` → `'offer'` as the client predicate and `resumeTarget` as the server's; the listed fields stay.
- **[I] 244–251 vs 73, 85 — the §7.5 table matches a `desktopOwned` session twice.** A `desktopOwned` row keeps `surface: 'dashboard'`
  (`claude-agents-dashboard/shared/types.ts:37, 152-155`), so an app-owned session in `question` (the app's own AskUserQuestion, which the transcript
  reports as `status: 'question'`) matches row 1 (`dashboard` surface, Waiting on your answer → `Answer in Dashboard`) and row 6 (Primary is Desktop by
  C3 → `Open in Desktop`). Row 1 is wrong for it: the dashboard holds no remote wait for an app-owned session and cannot answer it.
  → Key rows 1–4 on "Primary is Dashboard and the wait is a remote hold (`remoteQuestion` / `remotePlan` / `remoteReply`)", or add "and not
  `desktopOwned`" to each, and say the table is first-match.
- **[I] 248, 175 — `Allow in Dashboard` promises what the dashboard cannot do.** `permissionWait` is "Display-only: nothing can answer that dialog
  remotely" (`claude-agents-dashboard/shared/types.ts:118-127`), and the dashboard has no permission-answer route (`server/api.ts:1004` is the hook's
  notify only). The user must go to the terminal or the app that drew the dialog — which for a headless `dashboard` session is nowhere the button can
  reach.
  → Label it `Open in Dashboard` (or `Permission in Dashboard` with a title saying the dialog is answered where the session runs), and say in §6 that
  permission counts for the badge but the page can only show it.
- **[I] 150–151, 179, 181, 187–190 — "inside the grace" names no clock, and today's clock makes Quiet unreachable after two minutes.** Today the grace
  is measured from `startedAt` (`server/src/agents/jira-live.service.ts:111`, `now - Date.parse(startedAt) < JIRA_LIVE_GRACE_MS`). Under that clock a
  session older than 120 s that reads `incomplete` — every `local` session after every finished turn (`scan.ts:655`) — is ended `idle` on the very next
  tick (≤ 60 s, or ≤ 15 s per §5), never shown as Quiet, and C5 re-attaches it when the user types: the deck card and the List row flip live → ended →
  live on every turn. If the intended clock is "first seen in this state" (line 184 measures a wait's age that way), Quiet lasts two minutes and then
  ends — a different behaviour and a different test.
  → Say which: grace from `startedAt` (today's, re-attach keeps it so Quiet is a first-two-minutes state only) or from the first tick that saw
  `incomplete` (then C5's re-attach must reset it). Add the §12 case: "a `local` session two hours old reads `incomplete` → shows Quiet for N, then ends".
- **[I] 283–284 — `live[key]` on `GET /api/jira` is read by the OLD UI until section 4, not section 2, and with branch links it must be defined.** The
  modal's Stop and `session` fact read `data.live[issue.key]` (`client/src/components/jira/JiraIssueModal.tsx:193, 245`) and `JiraRunMenu` disables on
  `live` (`JiraRunMenu.tsx:29, 118`). Section 2 (detection) is what first puts a `branch` session on a key; if it fills `live[key]`, the old Run ▾ refuses
  while `reserve` allows — the §5 gate contradicted for two sections — and the old Stop would stop a session the row cannot signal.
  → Define `live[key]` for the transition as "the live `run`-linked entry only, else absent", and say it is removed when section 4 retires its readers.
- **[I] 134 vs 111–114 — `/jira link` refuses a session absent from the list, after §5 says absence from a capped list is not proof.** The dashboard's
  list is at most 50 rows (`server/api.ts:99, 117`), hides app-archived transcripts (`server/lib/scan.ts:73-78, 735`) and is sorted by mtime (`:744`); on
  a machine with more recent sessions than that a live session typing `/jira link` is refused. The dashboard has a per-id read with none of the list's
  skips: `GET /api/sessions/:id/row` (`server/api.ts:2004-2012`, 404 only when no transcript exists).
  → Check the session id with `GET /api/sessions/:id/row` (and read its `surface`, `projectPath`, `gitBranch` from that row), not the list.
- **[I] 105, 121–129, 134 — every link needs a Jira read, and the document does not say what a failed one does.** The snapshot (summary, type,
  `detail.parent`) comes from `GET /api/jira/issue/:key`, which is three Jira calls — issue, children, transitions — and "any of the three failing fails
  it" (`server/src/jira/poller.service.ts:383`), so "one read" (line 134) is three, and a branch rule firing for `PAY-9999-x` (no such issue), under a
  429 window, or with Jira unreachable has no stated outcome: link without a snapshot, skip, or retry next tick? Detection could also fire up to 50 such
  reads in one tick.
  → State: a `/jira link` whose read fails is refused with the poller's sentence; a detected key whose read 404s is never linked (remembered like an
  unlink); a read that fails otherwise is retried next tick and the session is not linked until it succeeds; and the snapshot may come from the board
  cache (`JiraIssue.parent`, round 1 Minor) before the fresh read, to spare the budget.
- **[I] 158–160, 184–185, 308 — "no more than ~15 s old on screen" needs the client's cadence too, and today's is the board's sync interval.** The
  client reads `GET /api/jira` once per soonest board's interval (`SYNC_INTERVALS` 15 s / 1 m / 5 m, `shared/types.ts:572-577`) with a 15 s floor
  (`client/src/hooks/useJira.ts:34, 43-52`); a board on `5m` shows a state up to five minutes old whatever the reconciler's period. §11 leaves "how the
  reconcile gets to ~15 s" to the builder but says nothing about the read.
  → Say the client polls the session read every 15 s while a Jira page is on screen (the same read the server uses to know a page is open, §5), or move
  the live state to its own route with its own cadence.
- **[I] 93–94, 336 — `/jira unlink <KEY>` on a `run` link is undefined.** C9 scopes the Detail button to `branch` links but the subcommand to any; unlinking
  a live `run` link would free the one-run gate (§5) with the Run session still working on the ticket, and the next Run ▾ starts a second one.
  → Say `/jira unlink` removes `branch` and `manual` links only and refuses a `run` link (`<KEY> was started by Run ▾ — Stop it from the board`), or
  that unlinking a `run` link ends it `stopped` without stopping the process; pick one and add the §12 case.
- **[I] 77–78 — the `agents/` hand-over route has no stated answers.** The dashboard's `POST /api/spawn` hand-over answers 501 `desktop app unavailable`,
  409 `session is still running` / `already resuming` / `session is open in the desktop app`, 429, and 500 `open failed` (`server/api.ts:1197-1225,
  1276-1297`), and is gated on the remote-answer toggle (`:1096-1102`). `jira-stop` says which of its peer's answers keep their meaning (line 226); the new
  route does not.
  → Name the route (`POST /api/agents/jira-open`?), its body (`{ sessionId }`), and that the dashboard's status and sentence pass through as `jira-stop`'s
  do; the button shows the sentence as its title on refusal.

## Minor

- 256: "The mocks were brought in line with C2 … PAY-151, PAY-140 and PAY-143" is true of `BoardB.dc.html` only (5dd14830 touched no other mock);
  `List.dc.html:118, 132` still draw an enabled primary `Desktop` on the `Desktop`-surface Working rows for PAY-140 and PAY-143. The "table wins" clause
  covers it; say the List mock was not updated.
- 297–299: for a `dashboard`-surface session the Desktop button is the hand-over POST, which opens the app on the server's own Mac — on a phone over the
  tailnet that is useful, not "nothing useful"; only the `claude://` href cases are dead there.
- 210: "then by start" still names no direction (round 1 Minor, unfixed); the deck says "newest first within each".
- 95: say whether the cap of 20 counts live sessions (3 live + 20 ended: keep 23, or trim ended to 17?).
- 99: "its 3 newest rows" — newest by `updated`, `created`, or the board's own order?
- 136: `/jira link` with a key the session already holds — idempotent 200, or 409? Say idempotent.
- 156–158: say that a link made by `/jira link` or by detection calls the reconciler's `arm()` the way `confirm` does (`jira-live.service.ts:76-88`), or
  the "stays armed while the store holds a live entry" sentence has no trigger on an empty, repo-less store.
- 147–149: "a `starting` entry is never evicted" presumes a cap; say whether `JIRA_LIVE_CAP` (100, `server/src/jira/live.service.ts:7`) survives and what
  it counts (live entries only, history bounded by C6) — parked with autopilot.
- 133: `skills/jira/tools/jira.test.mjs:3` describes the fake as "jira.mjs's one network peer is `/api/jira`"; the fake router and that sentence both
  need the `/api/agents/jira-link` route when §9.2 lands.
- 222: `StopSession` is a private component of `JiraIssueModal.tsx:359`, mounted only for a confirmed entry (`:291`); fine as a name, but Detail will
  re-home it.
- 134: "(one read, through the existing poller)" — three Jira calls today (see the Important finding above); if the builder adds a lighter issue-only
  read, say so.

## Verified true (no finding)

The round-1 fixes that hold: `SessionSurface = 'local' | 'dashboard' | 'cloud'` and every §6 flag is on the row (`shared/types.ts:44, 84-155`);
`permissionWait`, `remoteQuestion`/`remotePlan`/`remoteReply`, `stopState`, `processLive`, `desktopOwned`, `contextPct`, `projectPath`, `gitBranch`,
`sessionName`, `model`, `effort` all exist as named. `gitBranch` is the newest record's (`transcript.ts:446-453`). `repo` is a name only (`types.ts:70`).
`SCAN_CAPS = { limit: 50, lookback: 168 }` and the query names `?limit=&lookback=` (`api.ts:99, 103, 117-118`); the list sorts by mtime desc
(`scan.ts:744`), so a full list of 50 is correctly "not judged". `dashboardSessions` returns `id → status` and has three readers
(`dashboard-sessions.util.ts:7-9, 24-37`). The reconciler arms on `confirm`, stands down on `!hasConfirmed()`, 60 s, 120 s grace from `startedAt`
(`jira-live.service.ts:9, 15, 76-88, 111`). `reserve`/`release`/`confirm` as described (`live.service.ts:43-61`). `jira-stop` takes `{ key }` with the
409s named (`jira-agents.controller.ts:80-87`, `jira-dispatch.service.ts:196-208`). `branchCarriesKey` is bounded on both sides, every occurrence tried
(`shared/jira-branch.ts:60-68`): `XPAY-1510` does not match `PAY-151`. `repos` is `Record<projectKey, absolute paths[]>` (`shared/types.ts:950`), so "the
repos Setup maps to that key's Jira project" is right. `resumeUrl` is `claude://resume?session=<id>` (`desktop.ts:36-37`). `.filter-bar-badge` is 16 px,
`--ink`, 11 px / 500 (`client/src/styles.css:443-448`); DESIGN.md has §8.0, §8.9 and §8.11. Detail as a `Modal` composer keeps the Escape stack at eight
(`.claude/rules/board.md:11-23`); the rail badge is not an in-page control, so `board.md:56-64` is untouched. `invariants.md:3879` is the entry §10 renames
and `jira.md:86-104` the rule it changes. The CSP (`security.ts`) has no directive over an `<a href>` navigation. The gitdir file read spawns no git.
`JIRA_PAGES` is `['board', 'setup']` (`lib/jira-page.ts:15`).
