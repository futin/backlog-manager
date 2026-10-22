# Review 1 — `docs/superpowers/specs/2026-10-22-tick-breaker-design.md`

Date: 2026-10-22. Reviewer: fresh subagent (Fable), checklist review, read-only. Doc lines cite the uncommitted spec in the worktree (236 lines).
External source checked: `claude-agents-dashboard/server/lib/usage.ts` exists (doc:19).

## Verdict: REVISE

One Critical: the spec's own fallback for an unreadable `tick.json` (N = 3) un-halts a project whose configured N was 1 or 2, which is the anti-goal at doc:29
word for word. Six Important: no `.claude/rules/` file covers `server/src/tick/` so the "where the bullets go" instruction has no target and the one-home rule
needs a decision; a "no-op" claim about Reset that the page copy two sections later contradicts; and four places an implementer has to guess (reset body
validation, the garbage-`at` test value and the unknown-outcome entry, the empty-state condition, the sort key for projects with no history). Every one is a
sentence or two; the Critical is a design call, which is why this is REVISE.

## Critical

- **C-1 — doc:63, doc:65 (and the anti-goal at doc:29).** The table says an unreadable / non-JSON / non-object `tick.json` reads as "N = 3, no resets", and
  line 65 claims "a broken file can keep a project halted, never un-halt one". That holds only when the written N was ≥ 3. With `haltAfter: 1` on file and a
  project at streak 1 or 2 (halted), one stray comma makes `decide` read N = 3, streak < N, not halted — the project ticks again, and spends, until someone
  notices. That is "a halt that clears … by a malformed settings file" (doc:29). The same holds for `haltAfter: 2` at streak 2. The reset fallback IS safe
  (no resets → nothing un-halted); the N fallback is not. → Make the unreadable case refuse to tick, the posture the spec already takes for an unreadable
  `state.json` (doc:98–100): `decide` answers `idle` with a reason naming `tick.json` and "fix or remove it by hand", no unit runs, and the table row reads
  "no unit runs" instead of "N = 3". (Falling back to N = 1 is the other safe direction, but it halts every project at its first failure, which a person
  would then read as the breaker misfiring.) `status` and the server keep reporting `unreadable` as written.

## Important

- **I-1 — doc:192.** "the files whose `paths:` cover `server/src/tick/`" — no rules file does. The ten files' globs are `client/src/**`,
  `server/src/agents/**` + `shared/agent.ts`, `server/src/items/**` + `git-run.util.ts` + `server/src/releases/**`, `server/src/jira/**` +
  `server/src/agents/jira-*.ts` + `skills/jira/**`, `skills/backlog-orchestrate/**` + `server/src/orchestrator/**` + `shared/agent.ts`, `scripts/**` +
  `package.json` + `pnpm-workspace.yaml`, `server/src/*.ts` + `vite.config.ts` + `docker-compose.yml`, `skills/**` + `agents/**`, `test/**` +
  `.claude/rules/**`, `server/src/tracker/**` (`.claude/rules/*.md` frontmatter). And `test/claude-rules.test.ts:340` requires one home per anchor, so each of
  the two new headlines' mechanism bullets lives in exactly ONE file — the spec's plural "files" leaves which one open. → Name them: e.g. the `tick.json`
  headline's bullet in a new `.claude/rules/tick.md` with `paths: ["server/src/tick/**"]` (the glob must match a tracked file, `claude-rules.test.ts:310`,
  so the file lands with the module), and the halt-derivation headline's bullet in `.claude/rules/skills.md`, which already carries the `tick/` writer rule.
- **I-2 — doc:136 vs doc:154 and doc:159.** "the reset is a no-op for it" is false under the spec's own streak rule (doc:69): a Reset on a project that is
  not halted with streak 2 sets `resetAt` after both failures, and the next read says streak 0 — which is what the policy figure's line says ("a reset
  clears the count", doc:154) and what the not-halted row then shows (doc:159). The premise "a halted project takes no lock" also fails in the case doc:83
  describes: lower N while a tick holds the lock and the project reads halted with a lock beside it. → Replace the sentence with: a Reset is allowed in
  every state; it zeroes the project's streak whatever that was, touches no lock, and a tick already running records after it as doc:85 says.
- **I-3 — doc:133.** `POST /api/ticks/reset` states only the `404` for an unknown root. A non-object body, a missing `project`, or a non-string / relative
  `project` is unspecified; the sibling route says `400` for a non-object body (doc:132). The jest list (doc:212) does not cover it either. → State `400`
  for a non-object body or a `project` that is not an absolute-path string, `404` only for a well-formed path with no directory under the tick home, and
  add the `400` case to the tests.
- **I-4 — doc:200 and doc:69–71.** "an entry with `at: "garbage"` in the middle stops the walk" names no expected value, so the test cannot be written from
  the table. And the walk rule names `ok`, `failed` and an unparseable `at`, but not an entry whose `outcome` is neither (a hand-edited or future value) —
  `record` only ever writes `ok` or `failed` (`skills/backlog-tick/tools/tick.mjs:630`), but the file is JSON on disk and the server reads it too. →
  Write the case as `[failed, failed(at: "garbage"), failed]` (oldest→newest) → 1, and say what an unknown `outcome` does — "skipped: neither counts nor
  stops" keeps the halt direction safe — and add it to the table on both sides.
- **I-5 — doc:163.** "no tick history at all" is ambiguous against doc:128, which lists a directory with no `state.json` (a first tick holding the lock) as a
  project with `recent: []`. Is that the empty state or a Projects row with the "ticking" pill? → Define the empty state as `projects` being empty; a
  lock-only project draws the Projects sheet.
- **I-6 — doc:156.** "then by last tick newest first" has no key for a project with `recent: []` (doc:128) or an unreadable `state.json` (doc:160, no
  `recent` worth sorting on). → Say where they sort — e.g. after every project with history, unreadable rows last.

## Minor

- **M-1 — doc:146.** "the Watchdog page's 5 s" is the armed poll; idle it already polls at 15 s (`client/src/hooks/useWatchdog.ts:25,35`). The call is
  right, the comparison is off.
- **M-2 — doc:174.** The Watchdog group's scope label is `this server` (`client/src/components/settings/WatchdogGroup.tsx:205`); `this machine` is Trackers'
  and Claude Agents' (`TrackersGroup.tsx:76`, `SettingsView.tsx:462`). `this machine` is the right label for a machine-wide file — say it follows those two.
- **M-3 — doc:98–99.** `readState`'s "left untouched; fix or remove it by hand" tail is on the not-JSON and wrong-shape errors only; an I/O failure (EACCES)
  throws "cannot be read" without it (`skills/backlog-tick/tools/tick-state.mjs:186,192,196`). "the same message" overstates it slightly.
- **M-4 — doc:103.** "the reason ends `(tick.json unreadable — using 3)` instead" — instead of which part of the string at doc:102? Give the full
  alternative string. (Moot under C-1's fix.)
- **M-5 — doc:94–95.** `recover` can also answer `busy: another tick` when it loses the claim race (`tick.mjs:596,610`); "never `idle`" is true, but the
  order list should show the third exit.
- **M-6 — doc:131, doc:134.** Two concurrent POSTs (two browsers, Reset and a Select change) are read-merge-write with no serialisation; the loser's write is
  dropped. `jira.json` has the same posture (`server/src/jira/config.util.ts:489–496`), so this is accepted precedent — name it as accepted rather than leave
  it unmentioned.
- **M-7 — doc:48 vs doc:63.** "Same posture as `jira.json`" — `jira.json`'s reader treats a parsed non-object (`[1, 2]`, `null`) as empty and replaceable,
  not unreadable (`server/src/jira/config.util.ts:30,40,256`); the table makes it a `409`. The table's stricter rule is fine; drop "same posture" or qualify.
- **M-8 — doc:55.** `BM_TICK_SETTINGS_FILE` — the siblings are `BM_WATCHDOG_FILE` (`server/src/orchestrator/watchdog-config.util.ts:65`) and `BM_JIRA_FILE`
  (`config.util.ts:53`); `BM_TICK_FILE` would match the family. Taste.
- **M-9 — doc:123.** The lock carries `host` (`tick.mjs:436`), which `status` prints (`tick.mjs:709`); the GET's `{ kind, id, at }` drops it. Taste.
- **M-10 — doc:69.** A hand-set `resetAt` in the future (clock skew, a typo in the year) masks every record until the clock passes it — a valid file, so not
  C-1's case. Worth one sentence, or clamp `resetAt` to the read time.
- **M-11 — doc:116.** The new module needs an `AppModule` import (`server/src/app.module.ts:16`); builder detail, one word.
- **M-12 — doc:164.** The Watchdog sentence is "Could not reach the watchdog — … This page will fill in once the API answers `GET /api/agents/watchdog`
  again." (`client/src/components/runs/WatchdogMonitor.tsx:168`); give the Ticks sentence verbatim rather than by pattern, since copy is the contract.

## Checked and true

- doc:3 PR #330 is the tick's merge (`git log`). doc:4 the per-item skip is by item + hash (`tick-state.mjs:259`).
- doc:36–39 path, shape, `RECENT_MAX = 50`, `recent` entry fields, `recover`'s `killed at timeout` record (`tick-state.mjs:17,210`, `tick.mjs:614`).
- doc:48–49 `jira.json` writer refuses with `409` on unreadable (`jira-write.controller.ts:124,204`). doc:50 `settings/` is the rw mount under a `:ro`
  `~/.backlog-manager` (`docker-compose.yml:166,178`); `HOME` is passed so `homedir()` resolves (`:54`) — "Docker: no change" (doc:138) holds.
  `orchestrator-control/` is under `settings/` (`pause-control.util.ts:91`).
- doc:52 `clampAttempts`: non-number or non-integer → default, else clamped (`watchdog-config.util.ts:110–113`; the file is in `server/src/orchestrator/`).
- doc:86 `forget` drops `items[id]` only (`tick-state.mjs:216–222`). doc:91, doc:98 step order and `readState` after busy (`tick.mjs:362–389`).
- doc:103 `idle` → no `record`, reason is the final message (`SKILL.md:47`). doc:112 `status --json` is `{lock, recent}` (`tick.mjs:703`).
- doc:120 `BM_ORCH_HOME` read per call (`orchestrator.service.ts:24`). doc:131 `SameOriginPostGuard` checks content-type and origin (`origin.guard.ts:66,76`).
- doc:144 `RunsMode = 'runs' | 'watchdog'`, tree labels in `RAIL_SUB_LABEL` (`runs-mode.ts:32`, `SideRail.tsx:376`). doc:145 `watchdog-table` /
  `watchdog-kind-*` exist (`styles.css:1986,2012–2016`). doc:146 `useCoalescedFetch` takes `{ armed, intervalMs }` (`useCoalescedFetch.ts:23`).
- doc:149 "Runs · Watchdog" band and "Policy in Settings ›" chip (`WatchdogMonitor.tsx:210,215`). doc:176–177 `WatchdogGroup` uses Selects, has
  `saveErrorSlot`, reads `useWatchdog({ live: false })` (`WatchdogGroup.tsx:160,191`).
- doc:122 registry entries carry `name` and `path` (`registry.service.ts:62`). doc:128 the lock write creates the directory (`tick-state.mjs:7`).
- doc:197, doc:206 test placement matches the runner globs (CLAUDE.md conventions).
