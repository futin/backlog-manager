# Review 1 — `2026-11-03-jira-sessions-design.md`

Reviewer: Fable 5.1, fresh subagent, 2026-11-03. Document: `docs/superpowers/specs/2026-11-03-jira-sessions-design.md` (269 lines). Code read in this
worktree (docs-only diff against `main`) and in `claude-agents-dashboard` at its checkout. Every `file:line` below was read, not inferred from the document.

## Verdict: REVISE

Three contradictions inside the document (re-attach, the Run ▾ gate, and Open in Desktop against its own anti-goal) mean a builder cannot ship a single
behaviour from it; the Important findings are false facts about the two codebases and gaps an implementer would have to guess at.

## Critical

- **[C] 70–77, 238–240 vs 45 — Open in Desktop on a live `local` session forks the transcript the spec's own anti-goal forbids.** The dashboard has no
  "desktop" or "CLI" surface: `SessionSurface = 'local' | 'dashboard' | 'cloud'` (`claude-agents-dashboard/shared/types.ts:44`), and `local` is "an ordinary
  terminal or desktop-app session" (`:27-29`) — a terminal session and a desktop-app session are indistinguishable in the row. C2 disables Desktop only for a
  dashboard-surface session, so a `local` session that is `working`/`question` (a CLI session on a ticket branch, exactly what §5's branch rule links) gets
  an enabled, primary (C3) `claude://resume?session=<id>` — a second `claude` on a transcript a terminal is writing, the anti-goal at line 45. The dashboard
  itself hides the hand-over for every non-`dashboard` surface (`client/src/lib/resume.ts:84-86`, "terminal and cloud sessions have no `claude -p`
  transcript to hand over") and its server refuses the resume (`server/api.ts:1276`, `only dashboard sessions can be resumed`).
  → Name the value (`surface: 'local'`), and disable Open in Desktop for a `local` session too while its status is `working` or `question` (enable on
  `idle`/`incomplete`), or cite what the desktop app does with `claude://resume` on a transcript a live CLI holds — the spec cannot assert safety it has not
  checked.
- **[C] 81–82 vs 254–255 — re-attach rule contradicts its own test.** C5: a resumed ended session "is live again on its ticket, beside any other live session
  there". §12: "A resumed ended session re-attaches only when the ticket has no live session (C5)." Both cannot pass.
  → Pick one. If C5 stands, delete the clause in §12; if the test stands, rewrite C5 and say what happens to the resumed session (stays history? re-links on
  the next detach?).
- **[C] 181, 191 vs 127–129, 266–267 — the Run ▾ gate is defined two ways.** §5 and §12 say `reserve` "ignores `branch` and `manual` links" and "a detected
  session on a ticket with only a branch link lets Run ▾ start". §7.2 offers Run ▾ "when the ticket has no live session" and §7.3 disables it "while a
  session is live (the one-run gate)" — any session, so the UI would refuse what the server allows. Today's gate is `reserve`'s `entries.has(key)`
  (`server/src/jira/live.service.ts:45`), and the client's `JiraRunMenu` disables on `live[key]`.
  → State in §7.2 and §7.3 that the button is disabled exactly when a **Run-linked** live session holds the key, and that the sheet's 409 is the authority.

## Important

- **[I] 111–112 — `gitBranch` is the NEWEST branch, not the one the session started on.** `readTranscript` scans the tail newest-first
  (`claude-agents-dashboard/server/lib/transcript.ts:446`) and keeps the first `gitBranch` it meets (`:453`) — i.e. the most recent record's. A session that
  switches branches moves, and the detection rule as written links it to whichever key its newest record carries.
  → Drop the claim; say what detection does when a linked session's branch changes (keep the old link, add the new key, or re-link) and add the §12 case.
- **[I] 109–110 — detection by `projectPath ∈ mapped repos` misses sessions in a ticket worktree.** `projectPath` is the launch cwd (`shared/types.ts:62-68`
  in the dashboard); a session started in `<repo>/.claude/worktrees/<branch>` (what `worktreePathFor` in `shared/jira-branch.ts` and the 2026-10-20 spec make
  per ticket) has the worktree path there, which is never a Setup-mapped repo. The dashboard's `repo` field is only the main checkout's NAME (`:69-74`), not
  its path.
  → Match `projectPath`, or the main checkout it is a linked worktree of (an `fs` read of `.git`'s `gitdir:` line, no git spawn — CLAUDE.md's "never spawns
  git synchronously" is kept), against the mapped repos; add the worktree case to §12.
- **[I] 113–115, 237 — a route "under `/api/jira`" that asks the dashboard about a session id breaks the module rule.** §10 keeps `agents/` the only module
  that calls the dashboard, and `.claude/rules/jira.md:102-104` says the edge runs `agents → jira` and never back, "which is why the dispatch, the stop and
  the reconciler live in `agents/`". A `jira/` controller cannot check "a session id the dashboard does not know".
  → Put link/unlink beside `jira-stop` in `server/src/agents/jira-agents.controller.ts:11` (`POST /api/agents/jira-link` / `jira-unlink`), and say so in §5
  and §9.2 so `jira.mjs` (`skills/jira/tools/jira.mjs:4-6` lists only `/api/jira/*` today) is told the new path.
- **[I] 188–190 — "Stop is today's `StopSession`" is keyed by ticket, not by session.** `POST /api/agents/jira-stop` takes `{ key }` and stops "the key's
  session" (`server/src/agents/jira-agents.controller.ts:76-81`; `jira-dispatch.service.ts:196` `stop(key)`), with 409s for "no entry" and "starting". With
  several live sessions per ticket (§3 line 52) and a Stop on each Detail card, the route cannot name which to stop.
  → Specify `{ key, sessionId }`, which entry it ends (`stopped`), and the 409 for a session id the ticket does not hold.
- **[I] 108, 134–135, 154–155 — detection and the ~15 s freshness need an arming rule the spec does not give, and "the budget the reconciler already keeps"
  is one GET per 60 s only while an entry is confirmed.** The reconciler arms on `confirm` and stands down when `hasConfirmed()` is false
  (`server/src/agents/jira-live.service.ts:76-88`), so with an empty store the branch rule never runs; and `dashboardSessions` returns only `id → status`
  (`server/src/agents/dashboard-sessions.util.ts:24-37`), none of the §6 fields. A 15 s always-on read is 4× today's rate and never idle.
  → State the arming rule (e.g. armed while agents are enabled and some project maps a repo; 15 s only while a Jira page is connected, 60 s otherwise — the
  GitHub poller's "armed only while something is connected" shape), on start-up as well; and that the util grows to carry the row fields §6 reads.
- **[I] 100–101, 259 — `gone` has a cause the spec does not name: the dashboard's list is capped.** `GET /api/sessions` returns at most `maxSessions`
  (hard cap `SCAN_CAPS.limit: 50`, `claude-agents-dashboard/server/api.ts:99,117`) within `lookbackHours` (`:118`, `:721`), and `dashboardSessions` sends no
  `?limit=` (`dashboard-sessions.util.ts:27`). On a machine with more live sessions than the cap a live one is absent from an answered list and would be
  ended `gone` past the grace — history for a running session.
  → Say the read passes `?limit=` at the cap, and define "absent" for a session inside the lookback as "not judged" (or accept and state the false-end risk).
- **[I] 150, 157–158 — `incomplete` is "your turn" as often as "stalled", so a `local` session shows "Lost contact" every time its turn ends.** The ladder is
  `scan.ts:655` ("your turn (recent+done) OR stalled (stale+pending)"; `docs/subsystems/sessions.md:300-301`): a desktop or CLI session that finishes a turn
  reads `incomplete` for `activeWindowMin` before `idle`. Copy "Lost contact" is wrong for that case, and "does not detach" also means a Run-linked session
  whose process crashed mid-tool (stale+pending) stays live — and holds the one-run gate — until the 8 h backstop, where today's reconciler clears it on the
  next tick (`jira-live.service.ts:17-18`, `ACTIVE`).
  → Either split by surface (a `local` `incomplete` is "Your turn"/"Idle", a `dashboard` one "Lost contact") or pick copy that covers both; and say whether a
  `dashboard` `incomplete` detaches after a longer grace or truly waits 8 h.
- **[I] 70, 257–258 — "alive" is not mapped to row fields, so the Desktop-disabled test is not implementable from the text.** The dashboard's own rule is
  explicit (`resume.ts:84-91`): not `desktopOwned`, no held question/plan/reply, no `stopState`, no `processLive`, and status `idle`/`incomplete`.
  → Write C2 as that predicate over `Session` fields (`shared/types.ts:141,149,155` in the dashboard) so §12's "idle with no live process → enabled" names
  what "no live process" reads.
- **[I] 179 — the List window (24 h / 7 d / 30 d / all) names no field.** Started or ended? Are live rows exempt? C6 keeps 90 days of history, so the default
  hides most of it.
  → Define: live rows always shown; ended rows filtered on `endedAt`.
- **[I] 30, 168 vs mocks — the primary button's copy differs between the spec and the picked mocks and is not called out.** `BoardB.dc.html` and
  `Detail.dc.html` draw `Answer in Dashboard` as the primary on a Needs-you session and `Open in Desktop` otherwise, with the secondary shortened to
  `Desktop`/`Dashboard`; the spec says only "Open in Desktop and Open in Dashboard".
  → Decide whether the verb follows the state (Answer / Approve / Reply / Open) and fix the strings in one table; say the secondary's short form.
- **[I] 198 — "the board's existing rail-badge look" does not exist.** `SideRail` draws the tracker chip slot, the version chip and the blinking cursor
  (`client/src/components/SideRail.tsx:52-62,162`); no rail row carries a count, and `rail-badge` appears in neither `styles.css` nor `DESIGN.md`. DESIGN.md
  has only the type token "Badge count (`19`) 11 px / 500" (`.claude/DESIGN.md:42,130`).
  → Point the builder at that token and the `radius-full` pill, and add the badge to DESIGN.md §8.0's rail description.
- **[I] 242–243 — the docs list omits the invariant the store overturns.** `docs/subsystems/invariants.md:3879` "A Jira session is remembered in server memory
  only, and Stop is the one hand that clears it early" is the `Why:` of the rule `jira.md:86` links; CLAUDE.md says the rule file holds the mechanism and
  invariants.md the reasoning, so both change and the anchor moves.
  → Add `docs/subsystems/invariants.md` (rename the entry; keep or redirect the anchor) to §10's list.

## Minor

- 93: "for each session a Run starts" — the store also holds `branch` and `manual` links; say "for each linked session".
- 129: "A key that was cleared stays cleared" — with persisted history there is no `clear`; the sentence should name the end reason that stops a late
  `confirm` from resurrecting an entry.
- 166–167 vs 177: the deck is "newest first within each" state, the List "by state priority (as the deck), then by start" — say ascending or descending once.
- 166: the Board B mock draws a deck header line (`Agents · 2 need you · 3 working · 7 ended today`) the spec does not mention; call it in or out.
- 148 vs `States.dc.html`: the mock has one `Waiting on answer`; the spec's `Waiting on your answer` is right, note the mock slip.
- 179 vs `List.dc.html`: the mock's window chip reads `Last 7 days` and carries a `Sprint 42 · mine` chip; the spec says `7 d` and lists no sprint chip.
- 191 vs `Detail.dc.html`: the mock's `Next session takes over once this one ends.` line and the `Subtasks` heading (spec: Children tree) are not called out.
- 185: `JiraIssueModal` is one of the eight dialogs on the Escape stack (`.claude/rules/board.md:11-23`); say Detail takes its slot so the count stays eight.
- 66–67: say outright that Board | List is a view inside the Board page, not a third `JIRA_PAGES` entry, so `board.md:56-64`'s "never by an in-page control"
  rule (which is about pages) is untouched; C4's badge click then sets page `board` + view `list` through the same module-store pair.
- 241: the served CSP (`server/src/security.ts:41-47`: `default-src`, `script-src`, `base-uri`…) has no directive that governs an `<a href="claude://">`
  navigation; say no change is expected rather than "if".
- 85–86: say which entries the per-ticket cap of 20 drops (oldest `endedAt` first, never the live one) so the test in §12 has a value.
- 95: `parent` is on `JiraIssue` (`shared/types.ts:775`), so the board list carries it too; "`detail.parent`" is fine but not the only source.

## Verified true (no finding)

`CLAUDE_CODE_SESSION_ID` is set in a session (checked in this one). Every §6 flag is on the dashboard row (`shared/types.ts:90-155`). `POST /api/spawn`
resume refuses a held wait (`server/api.ts:1276-1278`) and a live child (`:1285`); `resumeUrl` is `claude://resume?session=<id>` (`server/lib/desktop.ts:36`).
`Segmented` `track` is DESIGN.md §8.11 and GitHub › PRs uses it (`PullRequestsView.tsx:258`). `useJiraPage` is `localStorage`. `JIRA_COLUMNS`,
`foldMatches`, `bandSub`, `childrenOf`, `sessionUrl(linkBase, id)`, `JiraWorktreeRow`, the priority and worktree markers, the minute tick, and every modal
fact in §8 exist as named. `reserve`/`release`/`confirm` semantics in §5 match `live.service.ts:43-61`. The 120 s grace and 8 h TTL are
`JIRA_LIVE_GRACE_MS` / `JIRA_LIVE_TTL_MS`. `jira.mjs` writes no file and calls only `/api/jira/*`, so `/jira link` through the server keeps `skills.md` and
`jira.md`'s token rule.
