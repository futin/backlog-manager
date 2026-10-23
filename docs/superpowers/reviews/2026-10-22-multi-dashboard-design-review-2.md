# Review 2 — `docs/superpowers/specs/2026-10-22-multi-dashboard-design.md`

Reviewer: Fable 5.1 subagent, 2026-10-22, on the revision that answers review 1. Checklist: facts vs code, internal consistency, edge cases, copy, scope,
hard rules (CLAUDE.md, `.claude/rules/*.md`). Every code claim below was read from the files cited; line numbers are as of this working tree. Line numbers
for the spec are as of the 157-line revision.

## Verdict

**APPROVE WITH FIXES** — nothing breaks a hard rule or loses data, and review 1's five Important findings are all answered. What remains is nine places where
two builders would build different things: one stated fact that is only true when an env var is set, one configuration entry missing a field the spec
itself requires, one row shape the spec promises but never defines, and six edge cases a sentence each would pin.

## Important

- **[I] spec:24 — "the `BM_MACHINE_NAME` of the machine it runs on — the same value that machine's claims record as `host`" is true only when that machine
  SETS it.** A claim's `host` is `hostIdentity()`: `BM_MACHINE_NAME` when set and not blank, else `<user>@<hostname>` (`skills/backlog/tools/backlog.mjs:898-912`,
  `skills/backlog-orchestrate/tools/orchestrate.mjs:901-905`; `.claude/rules/tracker.md:41-45`). A remote machine running the skills from a shell without the
  variable records `andreja@pro-mac`, and the list's lookup (L25, L32) never matches. → Define the field as "the `host` value that machine's claims carry", and
  require `BM_MACHINE_NAME` to be set in the shell environment on every remote machine (not only in its compose `.env`, which the server reads to COMPARE and
  the skills never see).

- **[I] spec:31-33 — "asks that dashboard" does not say what it asks.** Today's no-record path never STOPS anything: it asks `dashboardSessionStatus` and
  refuses with "session … is working — stop it before releasing its claim" unless the holder is neither `working` nor `question`, then releases the claim
  (`server/src/agents/items-abort.service.ts:93-110`); only the WITH-record path calls `stopDashboardSession` (`items-abort.service.ts:65-92`,
  `server/src/agents/session-stop.util.ts:17-33`). After a restart the spec's "Stop must keep working" could mean either the stop or the status check,
  routed to the remote dashboard. → Say which: "the remote dashboard is asked to stop `holder.session`, then the claim is released", or "the remote dashboard
  is asked for `holder.session`'s status and the claim is released only when it is not running" — and note the two answer different user promises
  ("Stop & release" vs "release if dead").

- **[I] spec:28-30 — "the dispatch appears in this board's history" names a row that nothing defines.** History is the `runs` + `remote` payload
  (`OrchestratorRunsPayload`, `shared/types.ts:1825`); a `remote` row is a `RemoteRun` with `runId`, `queue`, `mergeMode` and the rest (`shared/types.ts:1912`),
  derived ONLY from claims that carry `run` (`server/src/orchestrator/remote-runs.util.ts:301`). A card dispatch's claim has no `run` — and a LOCAL card
  dispatch has no history row today either (`DispatchRecordsService` is memory-only, 24 h, `server/src/items/dispatch-records.service.ts:29-72`). L30 says the
  derivation "learns which machine a session is on", which does not make a non-run claim a run row. → Either define the row (a new kind beside `remote`, with
  what a claim can supply: session, host, item, phase, heartbeat) and say local dispatches get the same, or drop "history" for card dispatches and keep the
  card badge and Stop, which the claim alone supports.

- **[I] spec:23-25 and 121-124 — the dashboard-list entry has no field for the remote backlog-manager, which "offered" requires reading.** L23-24 lists
  name, URL, token and machine name — all for the DASHBOARD. L122-123 then reads the remote machine's backlog-manager (registry, sync state), a second
  server on a different port that binds loopback (`.claude/rules/security.md:7-10`), has no token ("nothing has auth"), and reaches the tailnet only through
  `pnpm run tailnet` on the WEB port (`scripts/tailnet.mjs:1-20`; `.ts.net` admitted by `server/src/allowed-hosts.ts:68`). L107-108 names only the
  dashboard's allowlist and token. → Add the remote backlog-manager's URL to the entry (or derive it and say how), and state in Constraints that the remote
  machine must keep `pnpm run tailnet` up and that those reads are unauthenticated by design.

- **[I] spec:129-132 — "per project and machine" is the wrong key for a card dispatch.** A card dispatch is per ITEM: the record is keyed by item path
  (`dispatch-records.service.ts:29-36`) and the per-item block is `itemClaimBlock` (`server/src/agents/agents.service.ts:2137`). Keyed per project, a remote
  groom of item A blocks a remote execute of item B on the same machine for up to the timeout; keyed per item, it does not block a second ORCHESTRATE of
  the project, which L130 wants. → State the key per launch kind — item for a dispatch, project for an orchestrate — and what each one blocks.

- **[I] spec:100-101, 129-131 — once the entry clears on the first claim, nothing blocks a second remote ORCHESTRATE of the same project to the same machine
  while its `remote` run is live.** This server's lock reads `runs` and `starting` only (`agents.service.ts:718-719, 778`); remote rows never join `runs`
  (`remote-runs.util.ts:365-387`), and L100-101 keeps it that way. The remote `orchestrate.mjs init` refuses with its on-disk lock, but only AFTER a session
  has been spawned and wasted — bug-21's shape (`agents.service.ts:711-717`), now one machine over. → Say whether a live `remote` run for (repo, machine)
  blocks a remote orchestrate launch to that machine (a per-dashboard check against `remote`, not against `runs`), or accept the wasted spawn in writing.

- **[I] spec:54 — "the suggestion is home" assumes home is offered.** L49 makes an unreachable dashboard "not offered", and L115 offers a dashboard only when
  its gate passes for the project; home's own dashboard can be down or not list the project (`projectDispatchGate`, `shared/agent.ts:364-387`). → Say what is
  suggested when home is not offered: the first offered dashboard in the prefer order, or no suggestion with the picker left blank.

- **[I] spec:41-42, 52 — a null `exhaustAt` is also the "does not run out" answer, and one of its causes is a reset already in the past.** `walkForward`
  returns `exhaustAtMs: null` both when the walk coasts to the reset and when `resetsAtMs` is not finite or `<= nowMs`
  (`claude-agents-dashboard/server/lib/usage-forecast.ts:77, 156-158`); `shapeUsageProfile` sets `walkAbsent: 'no-window'` only for a NON-finite reset
  (`claude-agents-dashboard/server/api.ts:700-704`), so a finite reset in the past walks and answers `exhaustAt: null, walkAbsent: null` — strategy 3 reads a
  stale, already-reset window as "qualifies". → Add a row to the L46 table: `resetsAt` in the past → "projection unknown" (and the window's figures treated as
  stale), so the null never counts as headroom.

- **[I] spec:136-137 — "a server-owned settings file with one writer … `jira.json` and `tick.json` follow" implies tokens typed in the browser.** Both of those
  files are written from client POSTs (`server/src/jira/jira-write.controller.ts`, `server/src/tick/`), and neither holds a secret: Jira's credentials are env
  (`server/src/jira/env.util.ts:21, 34-53`), as is `BM_AGENTS_TOKEN` (`server/src/agents/config.util.ts:31-41`). A dashboard token entered on Settings reaches
  the browser first, against L83 and L137's own last sentence. → Say the tokens are env-only in either shape, and a settings file (if chosen) holds names,
  order, machine names and URLs only — and then it needs the CLAUDE.md headline form and a `.claude/rules/` home (`test/claude-rules.test.ts`).

## Minor

- spec:32 — the quoted refusal is a paraphrase; the exact copy is `<id> is held on <host>, not this one (<machine>)`, with `a machine the claim did not
  record` standing in for a missing `host` (`items-abort.service.ts:100-101`). Also, that path first refuses when THIS server has no `BM_MACHINE_NAME`
  (`items-abort.service.ts:96-98`); the spec should say the home entry's machine name replaces that read, or keep the refusal.
- spec:34 — "the weekly projection the dashboard already reads" exists only while that dashboard's "Record usage history" setting is on: the profile is
  derived from recorded history (`claude-agents-dashboard/server/lib/usage.ts:335-372`), and `walkAbsent: 'recording-off'` otherwise (`api.ts:700-701`). Say
  strategy 3 needs recording on at every listed dashboard, or it degrades to strategy 1 by L52.
- spec:50 — with `SHOW_USAGE` off the `usage` key is ABSENT from `GET /api/sessions`, not null (`api.ts:209-213`), and `GET /api/usage/profile` answers
  `walkAbsent: 'no-rate'`; the reader should accept both shapes as "no usage".
- spec:112-113, 140-141 — `GET /api/sessions` runs a full transcript scan per call (`api.ts:147-176, 184-188`), which is a heavy poll for two numbers.
  `GET /api/account` returns the same `usage` + `usageStatus` from the cache without a scan (`api.ts:987-996`), so "if no existing route is cheap enough"
  already has an answer; name it so the builder does not add a route.
- spec:98-99 — `projectDispatchGate` compares a registry PATH (`shared/agent.ts:369`) and its reason names that path (`shared/agent.ts:383`); for a remote
  dashboard the comparison is against the remote path from L138-139, and the copy should name the machine and the repo, not a path on another disk.
- spec:107-108 — the dashboard side matches: its Host guard admits `.ts.net` by default (`claude-agents-dashboard/server/lib/request-guard.ts:19`), and a write
  from a non-loopback peer needs `Authorization: Bearer <answerToken>` (`api.ts:540-548`), plus remote answers on (`api.ts:1604`, already named by
  `environmentBlock`, `shared/agent.ts:337-338`). Worth one line that the remote dashboard's `ALLOWED_HOSTS`/token are that machine's dashboard settings.
- spec:132 — a remote starting entry outside `starting` means a local card dispatch of an item the starting remote run will queue is NOT blocked
  (`runClaimBlock`, `shared/agent.ts:466-474`, reads `runs` and `starting` only). That is consistent with today — a live `remote` run does not block local
  dispatch either; the claim does (`itemClaimBlock`) — but say so, since L85 reads as a stronger promise than the protocol makes.
- spec:124 — say where the remote backlog-manager client lives (review 1 suggested `agents/`, one module per machine), so the "ONLY three" count in
  CLAUDE.md:47 changes by a known amount.
- spec:55-56 — true as stated: `finish` is validated only on execute and `--finish`/`--base` in an execute body is a 400 (`agents.service.ts:439-480`,
  `FINISH_FLAG` `shared/agent.ts:857`); the remote forcing is a new check beside those.
- Facts confirmed: spec:8-9 (`config.util.ts:31-41`); spec:26 matches `AGENT_ACTIONS` (`shared/agent.ts:28`); spec:30 "ignores claims outside a run"
  (`remote-runs.util.ts:301`); spec:57-59 `prUrl: null`, PR-ness from `mergeMode` (`remote-runs.util.ts:376-379`); spec:104-105 `fetchUsage` fails open
  (`usage.ts:206-252`); spec:125-128 drop-don't-reject (`claude-agents-dashboard/server/lib/spawn.ts:174-179`); spec:142-144 both launch surfaces reach
  `proveBaseBranch`'s `show-ref` (`server/src/items/base-branch.util.ts:39-73`; orchestrate via `resolveBase`, `agents.service.ts:822`); spec:118 "Shared
  Settings" is the page's name.

## Scope check

Non-goals (L61-76) are named and nothing in Goals depends on one. The two soft edges: L28-30's "history" row for a card dispatch (Important above) is a
mechanism the spec does not have, and L121-124's remote backlog-manager read needs a configuration field the entry lacks (Important above). Neither pulls
a non-goal in; both are a sentence of scope the spec already means.

## Hard rules checked

Tokens never leave the server (L92-93) — kept, with the settings-file caveat above. Browser never talks to the dashboard (L94) — kept. Agents POST guards,
`/api`, Host allowlist (L95) — kept. Dispatch derives the action (L96-97) — kept. Remote runs ride beside `runs` (L100-102) — kept; see the second-launch
finding. Server never writes git (L143-144) — kept. Outbound-calling modules "ONLY three" (CLAUDE.md:47) — the amendment is named (L124). A starting entry
blocks what a run file blocks (bug-21) — the remote entry deliberately does not enter `starting`; consistent with `remote` rows not blocking today.
`jira.json`/`tick.json` one-writer rule — invoked by L136, see the settings-file finding.
