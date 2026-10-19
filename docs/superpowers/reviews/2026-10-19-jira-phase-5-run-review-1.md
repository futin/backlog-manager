# Review 1 — `docs/superpowers/plans/2026-10-19-jira-phase-5-run.md` against `docs/superpowers/specs/2026-10-15-jira-integration-design.md`

Reviewer: Fable 5.1 subagent, 2026-10-19. Read-only: neither document was edited. Every code claim below was checked against the checkout at `4018891`.

## Verdict: APPROVE WITH FIXES

The plan covers every spec section and every spec test suite but one (`use-jira`'s reload after Start and Stop), its values match the spec where the spec
fixes them, its interfaces chain in task order, and it follows its own conventions (behaviour and test cases, never literal code; soft size budgets). The
five Important findings are each a missing step or a wrong name that an implementer would otherwise discover mid-task — none changes the design.

## Checklist

### 1. Coverage — spec section → task

| spec section                                        | task(s)                    | note                                                        |
| --------------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| §2 settings (`jiraDefaultAction`, clampSettings)     | T8                         | plan adds a 64-char cap the spec (L46-60) does not state — see Minor M10 |
| §3 prompt composition (`prompt.util.ts`)             | T2                         | placeholders, cap, built-ins, `{description}` rules all present |
| §3 live map in server memory (cap 100, 8 h, starting) | T3                         | "starting entry never evicted" is a plan ruling, spec silent — M10 |
| §3 reconciler (60 s, grace 2 min)                    | T6                         |                                                             |
| §4 shared types (`JiraDispatchRequest`, `live`, `session`) | T2 (JiraAction), T3 (live), T5 (request/result) | `shared/types.ts:533-537` header says the two are deliberately absent — T5 must flip that header; it does (L190) |
| §5 `POST /api/jira/skills`, `/skills/delete`         | T1                         | 404 wording — Important I2                                  |
| §5 `GET /api/jira/prompt`                            | T4                         | pinned 404 case not removed — Important I1                  |
| §5 `POST /api/agents/dispatch-jira`                  | T5                         | 400/409/502/503 mapping matches §5 L183 and §7              |
| §5 `POST /api/agents/jira-stop` + `session-stop.util.ts` hoist | T5 (route), T6 (hoist) | abort suite misnamed — Important I5                         |
| §6.1 Skills card on Settings › Local                 | T8                         |                                                             |
| §6.2 `Run ▾` on the card                             | T9                         |                                                             |
| §6.3 launch sheet                                    | T10                        |                                                             |
| §6.4 live strip                                      | T10                        |                                                             |
| §6.5 modal Stop + session fact                       | T10                        | "confirmed entry" ruling — M10                              |
| §7 Start order                                       | T5                         | order check → gate → live → cap → assign → transition → spawn, earlier writes stand |
| §9 built-in prompt texts                             | T2 L108-111                | byte-equal with spec L312-325                               |
| §10 docs                                             | T7, T11                    |                                                             |
| §11 test suites                                      | T1-T6, T8-T10              | `use-jira` reload case absent — Important I4                |
| §12 widenings                                        | T7, T11                    | §12 L379 says "six"; plan L366 "six to seven" is right — M9 |
| §13 new invariant headlines                          | T7 (`jira.md`), T11 (`board.md`) | rule-file scope — M11                                 |

Spec test suites (§11 L346-362) → plan tests: `jira-config-write` T1, `jira-write-routes` T1, `jira-prompt` T2, `jira-live` T3, `jira-routes` T4,
`agents-dispatch-jira` T5, `agents-jira-stop` T5, `agents-stop` T6, `agents-jira-live` T6, `settings` T8, `settings-view` T8, `jira-lib` T8/T9,
`jira-board` T9, `jira-launch` T10, `jira-modal` T10, `dialog-count-docs` T11. **`use-jira` ("the reload after Start and Stop", spec L357): no task.**

### 2. Values

Checked against the spec and the code they must agree with:

- `JIRA_PROMPT_MAX = 4000` (plan L39) = dashboard `PROMPT_CAP` (`/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard/server/lib/spawn.ts:66`). OK.
- Session name `jira <KEY>` cut to 60 mirrors `sessionName` in `server/src/agents/prompt.util.ts:158`. OK.
- Built-in labels `Work it end to end` / `Open with the ticket loaded`, texts L108-111 = spec L312-325. OK.
- Skill `name` 1-60, `prompt` 1-2000, id `s_` + 8 hex = spec L176-177 and `mintJiraId(kind: 'b' | 'q' | 's')` (`server/src/jira/config.util.ts:339`, already accepts `'s'`). OK.
- Error mapping L203/L217-219: `no identity` → 503, `transition not offered` → 400, Jira 400 → 409 `Jira refused: <message>` — matches `written()`
  (`server/src/jira/jira-write.controller.ts:132-138`) and `server/src/jira/errors.util.ts`. OK.
- 502 vs 409 gate rule (plan L203) = `agents.service.ts:458` (`status.enabled && !status.reachable ? 502 : 409`). OK.
- `JIRA_TRANSITION_ID_MAX_CHARS` (L199) exists, `= 64`, in `jira-write.controller.ts:14` — not in `config.util.ts`; plan does not say where it lives (M2).
- Dialog count six → seven (L366): `.claude/rules/board.md:11-26`, `test/dialog-count-docs.test.ts:41`, `client/src/hooks/useDialogEscape.ts:28,39`,
  `.claude/DESIGN.md` §8.7 L394-411 all say six today. Plan right; spec §12 L379 stale (M9).

### 3. Reality

Create targets — all absent, correctly: `server/src/jira/prompt.util.ts`, `server/src/jira/live.service.ts`, `server/src/agents/jira-dispatch.service.ts`,
`server/src/agents/jira-agents.controller.ts`, `server/src/agents/session-stop.util.ts`, `server/src/agents/jira-live.service.ts`,
`client/src/components/jira/JiraSkillsGroup.tsx`, `JiraLaunchSheet.tsx`, `JiraRunMenu.tsx`, and the six new test files.

Modify targets — all present, with these exceptions:

- L249 "the items-abort suite": no `test/items-abort.test.ts`; the suite is `test/tracker-abort.test.ts` (I5).
- L277 "the Settings › Local › Dispatch section component": no such file — `DispatchGroup()` is an inline function in
  `client/src/components/settings/SettingsView.tsx:509` (M6).
- L279 "the Settings render suite that covers the Dispatch rows": `test/settings-view.test.tsx` (M6).
- L334 "the Jira stylesheet": there is one `client/src/styles.css`, no `client/src/styles/jira.css` (M7).
- L110 anticipates reusing `COMMIT_RULE`; it is private in `server/src/agents/prompt.util.ts:61` (M1).
- L178 `normaliseRepoPath` is exported (`config.util.ts:306`) but takes `(raw, home)` — the caller must pass `homedir()` (M3).

Names that exist as claimed: `JiraUnknownIdError` (`config.util.ts:239`), `idsIn` (393), `parseReposWrite` (324), `writeBoard` (413), `deleteBoard`
(451), `writeRepos` (463), `written()`/`requireConfigured()`/`writing()` (`jira-write.controller.ts:132-153`), `JiraIssueWriteOutcome`
(`poller.service.ts:150`), `assignToMe` (483), `transitionIssue` (504), `gate()` (948), `me` via `boot.answered() ? boot.me : null` (337),
`renderTicketBlock(detail)` (`block.ts`), `environmentBlock` (`shared/agent.ts:319`), `projectDispatchGate` (356), `modesUpTo` (227), `clampMode` (246),
`ItemsAbortService.stopSession` private (`items-abort.service.ts:121-137`), `dispatch()` tail 502-533 (`agents.service.ts`), `useAgents(): { status, reload }`
(`client/src/hooks/useAgents.ts:36`), `sessionUrl(linkBase, sessionId)` (`client/src/lib/agents.ts:475`), `JiraState.reload` (`useJira.ts:39`),
`transitionOptions` local to `JiraIssueModal.tsx:123`, `JiraCard` role=button + Enter/Space (`JiraCard.tsx:71`), `stubDashboard(spawn)`
(`test/agents-dispatch.test.ts:56`), `FakeJira.calls` (`test/helpers/jira.ts:117`).

### 4. Interfaces

T1 produces `parseSkillWrite`/`writeSkill`/`deleteSkill` → T5 consumes skill lookup by id. T2 produces `composeJiraPrompt`, `JiraAction`,
`JIRA_PROMPT_MAX` → T4 (prompt route) and T5 (dispatch) consume them with the same spelling. T3 produces `JiraLiveService` (`get/start/confirm/clear/
all`) → T5 and T6. T5 produces `JiraDispatchRequest`, the result shape `AgentDispatchResult & { assigned, transitioned, session }` → T9/T10 client. T6's
`session-stop.util.ts` is consumed by T5's `jira-stop` — T5 lists it as a Create (L196) and T6 says "hoist" (L229); one owner would be cleaner but both
tasks name the same path and signature, so it builds either way (M4 covers the `arm()` forward reference, the one real cross-task lean). T8 produces
`jiraDefaultAction`, `jiraSettingOf` → T9 `resolveJiraAction`/`defaultModeFor` → T10 sheet. Consistent.

### 5. Order

Tasks 1-7 server, 8-11 client; no task consumes a later task's product except T5 L212 citing "Task 6's reconciler arm()" — a forward reference the
implementer of T5 cannot call yet (M4). T7 docs comes after every server change it describes; T11 after every client one. PR 5a merges before 5b (L31).

### 6. Tests

Each task's listed cases would be red before the task: new routes 404 today (`test/jira-routes.test.ts:307` pins exactly that), new modules do not exist,
`live` is `Record<string, never>` (`shared/types.ts:676`), `JiraIssueDetail.session` is typed `null` (636). Review Focus items:

- RF1 (order of writes, earlier writes stand) — T5 L213-216. OK.
- RF2 (prompt cap at 4000, same number as the dashboard) — T2 L120, T4 L175. OK.
- RF3 (dispatch never accepts an action / default from Settings) — the plan says "Pinned in Tasks 5 and 7" (L57-58) but Task 7 is docs only; the
  cases live in T8 L297 and T9 L326 (I3).
- RF4 (live entry lifecycle: starting → confirmed → cleared, cap and TTL) — T3 L150-156, T6 L245-249. OK.
- RF5 (Stop clears on 200 and on the dashboard's 404) — T5 L220-221. OK.

### 7. Conventions

The plan describes behaviour and names exact expected values; no literal code blocks. Size budgets are phrased "target ≤" (L45-46). The reviewer dispatch
rule (file the report, return the verdict) is stated in each PR's merge step (L270, L374).

## Findings

### Critical

None.

### Important

- **[I1] plan:160-180 (Task 4)** — `test/jira-routes.test.ts:307` pins `it('GET /api/jira/prompt is 404', …)`, and the headers of
  `server/src/jira/jira.controller.ts:12-26` ("six read routes … `GET /api/jira/prompt` is a 404 until then (pinned by `test/jira-routes.test.ts`)") and
  `server/src/jira/jira.module.ts` ("six read routes") describe the pre-phase-5 state. Task 4 adds the route but never says to delete the pinned case or
  update those two headers, so the suite goes red and the comments lie. → Add to Task 4: remove the 404 case (replace it with the route's own cases),
  and reword both headers to seven read routes; `docs/overview.md:81` ("six read routes under `/api/jira`, plus five guarded POSTs") must follow in Task 7
  (it does count routes — L256's "if it counts routes" is answered: yes, and it becomes seven + seven).
- **[I2] plan:75, 82, 85 (Task 1)** — the plan has `deleteSkill` throw `JiraUnknownIdError` and the routes "mirror saveBoard/deleteBoard (guard,
  HttpCode(200), writing())", but `writing()` (`server/src/jira/jira-write.controller.ts:145-153`) maps that error to the literal `'unknown board'`, and the
  error's own message is `` `no board with id ${id}` `` (`server/src/jira/config.util.ts:239`). Mirrored as written, an unknown skill id answers 404
  `unknown board`. → State the 404 sentence for skills (`unknown skill`), either by giving `JiraUnknownIdError` a kind (`board` | `skill`) that `writing()`
  reads, or by a second error class, and pin the wording in `test/jira-write-routes.test.ts` (plan L82 says only "→ 404").
- **[I3] plan:57-58 (Review Focus 3)** — "Pinned in Tasks 5 and 7": Task 7 (L253-268) is the server docs task and lists no test; the cases that pin
  "`Run ▾` resolves from Settings, dispatch takes `action`, not a free prompt" are Task 8's `jiraSettingOf` case (L297) and Task 9's `resolveJiraAction`
  case (L326). → "Pinned in Tasks 5, 8 and 9."
- **[I4] plan:357-372 and 378-380 (Tasks 10-11, self-review)** — spec §11 L357 lists `use-jira` with "the reload after Start and Stop"; no task names
  `test/use-jira.test.tsx` and no case covers the hook reloading after the two POSTs (Task 10 L349 says the sheet calls `reload` but tests only the sheet).
  The self-review R3 (L380) claims every spec suite has a task. → Add to Task 10's tests: in `test/use-jira.test.tsx`, after a resolved `dispatch-jira`
  the hook re-reads `GET /api/jira` once and the card gains the live chip; after `jira-stop` the same, chip gone; and name the file in the Modify list.
- **[I5] plan:249 (Task 6)** — "the items-abort suite stays green (run it)": there is no `test/items-abort.test.ts`; the suite that exercises
  `ItemsAbortService.stopSession` is `test/tracker-abort.test.ts`, and it is absent from Task 6's test list although the hoist to
  `server/src/agents/session-stop.util.ts` changes the code it covers. → Name `test/tracker-abort.test.ts` in Task 6's Test list and in the "run it" line.

### Minor

- **[M1] plan:110** — `COMMIT_RULE` is private to `server/src/agents/prompt.util.ts:61`; the plan reads as if it can be imported. Say "export it" or
  restate the rule text in `jira/prompt.util.ts` (the module direction `agents → jira` forbids `jira/` importing from `agents/` — L43 — so restating
  is the one that honours the plan's own rule).
- **[M2] plan:199** — `JIRA_TRANSITION_ID_MAX_CHARS` lives in `server/src/jira/jira-write.controller.ts:14`, not `config.util.ts`; say where to import it
  from (or hoist it to `config.util.ts` so `jira-dispatch.service.ts` does not import a controller).
- **[M3] plan:178** — `normaliseRepoPath(raw, home)` (`config.util.ts:306`) needs the home directory; note the caller passes `homedir()` as
  `parseReposWrite` does (324).
- **[M4] plan:212** — "Task 6's reconciler `arm()`" is a forward reference: Task 5 cannot call it. Say "Task 6 adds the `arm()` call here" or move the
  line to Task 6.
- **[M5] plan:255** — "find it by its anchor": the two rules are `.claude/rules/dispatch-watchdog.md:15` ("Dispatch derives the action…") and `:31`
  ("The orchestrate spawn prompt is composed server-side"); `invariants.md` anchors at L1286 and L1310. Name them so `test/claude-rules.test.ts`'s
  byte-equal check (headline in CLAUDE.md = headline in the rule file) is on the implementer's radar when widening either headline.
- **[M6] plan:277, 279** — the component is the inline `DispatchGroup()` at `client/src/components/settings/SettingsView.tsx:509`; the suite is
  `test/settings-view.test.tsx`. Name both.
- **[M7] plan:334** — "the Jira stylesheet" is `client/src/styles.css` (the only stylesheet; no per-section file).
- **[M8] plan:366 vs spec §12 L379** — the spec says the composer count "moves to six (the launch sheet)"; six is today's count (`useDialogEscape.ts:28`,
  `test/dialog-count-docs.test.ts:41`), so the plan's "six to seven" is right. Say so in the plan to stop the implementer trusting the spec.
- **[M9] plan:258 and spec §13** — the new headline "A Jira session is remembered in server memory only…" goes to `.claude/rules/jira.md`, whose
  `paths:` are `["server/src/jira/**", "skills/jira/**"]`; the reconciler and the two routes live under `server/src/agents/**`, which that file does not
  cover, so a session editing `jira-live.service.ts` never loads the rule. Either widen `jira.md`'s `paths:` or put the bullet in `dispatch-watchdog.md`.
- **[M10] plan:152, 282, 347-348** — three rulings the spec does not make: a starting entry is never the one evicted (spec §3 silent), `jiraDefaultAction`
  capped at 64 chars (spec §2 L46-60: "keeps it a non-empty string"), and Stop needs a *confirmed* entry (spec §6.5: "while agents are enabled"). All
  three are sound; list them in the plan's rulings block so the spec reviewer sees the deltas.
- **[M11] plan:301-355** — the client-side POST helpers for `dispatch-jira` and `jira-stop` are not placed (`client/src/lib/agents.ts` beside
  `dispatchAgent`, or `client/src/lib/jira.ts`); name the file so `test/jira-lib.test.ts` and `test/jira-launch.test.tsx` mock the right module.
- **[M12] plan:196 / 229** — `server/src/agents/session-stop.util.ts` is listed under Create in Task 5 and "hoist" in Task 6; give it one owner (Task 5
  creates, Task 6 switches `ItemsAbortService` to it) to avoid two tasks writing the same new file.
