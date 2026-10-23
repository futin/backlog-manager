# Review 1 — `docs/superpowers/specs/2026-10-22-multi-dashboard-design.md`

Reviewer: Fable 5.1 subagent, 2026-10-22. Checklist: facts vs code, internal consistency, edge cases, copy, scope, hard rules (CLAUDE.md, `.claude/rules/*.md`).
Every code claim below was read from the files cited; line numbers are as of this working tree.

## Verdict

**APPROVE WITH FIXES** — no finding breaks a hard rule or loses data, but five requirements are ambiguous or rest on a false premise and would be
guessed differently by two builders. All are a sentence or two each.

## Important

- **[I] spec:107-108 — "the server checks the chosen model and effort against what the picked machine's account can run, and refuses before the launch
  rather than letting the spawn fail after it" has no source and a false premise.** The dashboard exposes nothing about an account's models: `/api/health`
  returns `remoteAnswer` and `spawnMaxPermission` only, and its spawn parser (`claude-agents-dashboard/server/lib/spawn.ts:174-179`) does not fail an
  unknown model/effort — it silently drops the field to `undefined` ("drop-don't-reject"), so the spawn never "fails after it"; it runs on the default.
  This board's `MODELS`/`EFFORTS` are a flat list, "neither list is clamped against" (`shared/agent.ts:197-208`). → Either scope a read-only
  dashboard route that reports the account's allowed models/efforts (as L119-120 already does for usage), or drop the per-machine check and say the
  picker offers the shared list and a model the remote account lacks runs on that dashboard's default — and state which. Today's text gives the
  builder nothing to check against.

- **[I] spec:18-19, 41-42 — "comes back as a PR on GitHub, and its run shows up in this board's history" overstates what the existing `remote` array
  carries.** `deriveRemoteRuns` sets `prTarget: null, prUrl: null` for every remote run (`server/src/orchestrator/remote-runs.util.ts:376-378`, whose
  comment says the PR link "only the driving machine's run file holds, does not travel"). A remote run therefore appears in history WITHOUT its PR link,
  and a forced-PR run (L39-40) is exactly the run whose link matters. → Say so plainly under Goals or Non-goals ("the row shows the run, not its PR —
  the PR is found on GitHub"), or scope the one addition the claim protocol would need (the PR URL on the finishing claim) and say it is in scope.

- **[I] spec:27-28 — remote "Stop & release works from this board" silently stops working after a restart.** The route picks the dashboard from the
  in-memory dispatch record (`server/src/agents/items-abort.service.ts:65-116`, `DispatchRecordsService` is memory-only, TTL 24 h,
  `server/src/items/dispatch-records.service.ts:29-72`). With the record gone, case B requires `holder.host === BM_MACHINE_NAME` and otherwise answers
  409 "`<id>` is held on `<host>`, not this one" (`items-abort.service.ts:96-102`). The spec's own "Starting on <machine>" entry (L109-111) accepts
  the same volatility, but Stop is a user-facing promise the restart case breaks. → State the behaviour (after a restart a remote dispatch's Stop needs
  the claim's `host` to resolve to a configured dashboard), and pin the mapping: name each remote dashboard by that machine's `BM_MACHINE_NAME`, which
  the claim's `host` already carries (`shared/types.ts:2320-2422`), so the abort path can route from the claim alone and the record becomes an
  optimisation, not the only key.

- **[I] spec:33-38, 123 — the three strategies are not fully specified for partial usage, and the two sections name strategy 2 differently.** (a) L64
  covers "usage missing" only as the all-or-nothing case; nothing says what strategy 1 or 2 does when ONE dashboard's figures are `null` or older than
  the cache age (is it skipped, last, or does the whole suggestion stand down?). The dashboard's `usage` is also ABSENT, not null, when that
  dashboard runs with `SHOW_USAGE` off (`claude-agents-dashboard/server/api.ts:977`, `config.ts:140,325`) — a third shape. (b) Strategy 3 "fall back
  to strategy 1's order" is undefined when the user never set an order (the order is strategy 1's setting). (c) Strategy 3's projection is only
  available when the dashboard records usage history: `UsageProfileResponse.walkAbsent` is `'recording-off' | 'no-rate' | 'no-window'`
  (`claude-agents-dashboard/shared/types.ts:233`), and `exhaustAtMs` is null in those cases (`server/lib/usage-forecast.ts:154-204`). (d) L35 says
  "Most headroom … the lowest utilization, measured as the higher of its 5-hour and weekly"; L123 calls the tie rule "proportionally less used", a
  phrase that appears nowhere else. → One table: per strategy × {figures present, figures stale, figures null, usage absent (SHOW_USAGE off), profile
  absent}, the outcome (skip the machine / stand down with the plain "no usage" copy). Give strategy 3 a default order when none is configured (the
  configured list order, home first), and use one name for strategy 2's measure in both places.

- **[I] spec:121-122 — the base proof is named for remote EXECUTE only; remote ORCHESTRATE has the same local-branch check.** Orchestrate's base goes
  through `AgentsService.resolveBase` → `resolveBaseBranch` → `proveBaseBranch` (`server/src/items/base-branch.util.ts:39-73`), which runs
  `git -C <this machine's registry path> show-ref --verify refs/heads/<base>`; only `'main'`/absent/`''` skip git. A forced-PR remote orchestrate onto
  `feature/x` is proved against THIS clone, exactly as execute is. → Extend the bullet to both launch surfaces, and whichever answer the builder picks
  (this clone, or `origin`), note `.claude/rules/security.md:16-22`: every git verb the server runs is a read — `rev-parse`/`for-each-ref`/`show-ref`
  are fine, a `fetch` to refresh `origin` is not, so "check `origin`" means "check `refs/remotes/origin/<base>` as of the last fetch".

## Minor

- spec:87 — "The dashboard's usage endpoint is private and undocumented (`usage.ts`)" misattributes. The private endpoint is Anthropic's
  `/api/oauth/usage` on `api.anthropic.com`, which `usage.ts` CALLS (`claude-agents-dashboard/server/lib/usage.ts:43-66`); the dashboard's own routes
  this board would read (`GET /api/sessions`, `GET /api/usage/profile`) are ordinary dashboard routes. "Fails open to `null`" is true of `fetchUsage`
  (`usage.ts:205-252`). Reword to "the usage the dashboard reads comes from a private Anthropic endpoint, and the dashboard fails open to `null`".
- spec:103-106 — correct that the remote backlog-manager is a fourth outbound destination against CLAUDE.md:47 ("the ONLY three"). The spec already
  says the list must be amended; say where the client lives (in `agents/`, beside the dashboard client, is the natural home — one module per machine
  rather than one per protocol) so the invariant's count changes by zero or one, not by accident.
- spec:89-90 — names only the remote DASHBOARD's allowlist. The remote backlog-manager (L105) is reached the same way, and binds loopback by default
  with the tailnet published only by `pnpm run tailnet` on the WEB port (Vite proxies `/api`), per `scripts/tailnet.mjs:2-38` and
  `.claude/rules/security.md:7-15` (`.ts.net` hosts are admitted by default). Say the remote reads go to that machine's tailnet web port.
- spec:109-111 — "clears when the run's first claim appears" never fires for a `capture` dispatch (`AgentAction` includes `capture`,
  `shared/agent.ts:15`; capture creates a NEW issue and claims nothing on an existing one), so that entry lives until the timeout. Say capture is
  timeout-only, or exclude capture from the placeholder.
- spec:109-111 — make the placement explicit: the remote entry must NOT ride in the payload's `starting` array, because `runClaimBlock` reads
  `starting` by `s.project === item.projectPath` (`shared/agent.ts:466-474`) and `StartingRunsService.expired` is local-only by design
  (`server/src/orchestrator/starting-runs.service.ts:126-139`, bug-57). A sibling field (`startingRemote`) keeps "never blocks this machine's own
  Orchestrate" true by construction rather than by a filter.
- spec:47 — "the picker shows only the home machine (or is not drawn)" is two behaviours. Pick one. L69 (home-only unchanged) suggests the picker is
  not drawn whenever only one machine is offered, which also answers the zero-remotes case; say that.
- spec:98 — "drawn disabled with its reason" for an unreachable machine is a reasonable choice, but note it against CLAUDE.md's "an environment-level
  block hides the dispatch control; the per-item ones disable it": the rule is about the dispatch CONTROL, not a picker option, so the spec should say
  the control's own hide/disable logic is unchanged and only the option inside the picker is disabled.
- spec:81-82 — the per-dashboard gate copy: `projectDispatchGate`'s disabled reason is "the dashboard does not list ${projectPath} — most likely no
  Claude session there inside its LOOKBACK_HOURS" (`shared/agent.ts:383-385`), built from THIS machine's path. For a remote machine the path is the
  remote one (L99: identity is `owner/name`, path differs) — say the reason names the machine and the repo, not a path.
- spec:100 — "Shared Settings" is the right page name (`client/src/components/settings/TrackersGroup.tsx:16,35`).
- spec:25 — "groom / execute / capture" matches `AGENT_ACTIONS` (`shared/agent.ts:28`). spec:8-9 matches `readAgentsConfig`
  (`server/src/agents/config.util.ts:31-41`). spec:29 "ignores claims outside a run" is true (`remote-runs.util.ts:289-301`). spec:94-95 is true
  (`hub-widgets.ts:10-25` reads the cached usage state; `useUsageProfile.ts:29` fetches `/api/usage/profile`; `UsageProfile.tsx:420-423` carries
  `exhaustAt`).
- spec:115-116 — if the builder picks a settings file, CLAUDE.md requires the headline form "`~/.backlog-manager/settings/<x>.json` has exactly one
  writer, the server, and a file that cannot be read is never replaced" plus a `.claude/rules/` home (`.claude/rules/tests.md:7-15`,
  `test/claude-rules.test.ts`). Worth one line so the plan budgets it.

## Scope check

Out-of-scope items are named (L44-59) and nothing in Goals depends on one: remote Jira, ticks, pause/stop/resume of a remote orchestrator run, and
split queues are each cleanly outside. The one soft dependency is L19 "run shows up in this board's history" on the PR link (Important above).

## Hard rules checked

Tokens never leave the server (L75-77) — kept. Browser never talks to the dashboard (L77) — kept. Agents POST guards, `/api`, Host allowlist (L78) —
kept. Dispatch derives the action (L79) — kept. Remote runs ride beside `runs` (L83) — kept; see the `starting` placement note. Server never writes
git — see the base-proof finding. Outbound-calling modules "ONLY three" (CLAUDE.md:47) — the spec names the amendment.
