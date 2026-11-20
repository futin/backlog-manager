# Jira review skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, signatures, exact values and exact test CASES — never literal implementation
> code. Write the bodies yourself; if a case here looks wrong against the spec or the code, say so rather than transcribing it.

**Goal:** skills carry a `run | review` group; Setup › Skills shows them apart with an inline editor; an open MR's Delivery row offers `Review ▾` with the bot
plus the user's review skills, which run on the MR's source branch.

**Architecture:** one `group` field on `JiraSkill` (`jira.json`, existing routes); the `{ skill }` action gains an optional five-field MR that the preview
shapes and dispatch re-checks against the GitLab cache; the client filters Run surfaces to run skills and adds a chevron/ghost `Review ▾` popover on
`NextRow`.

**Tech Stack:** NestJS, React, jest (supertest, Testing Library), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-20-jira-review-skills-design.md` — read it in full; it is the source of every value below. Mocks:
`docs/superpowers/specs/2026-11-19-jira-detail-tabs-mockups/` — `Review-Skills.dc.html`, `Main.dc.html`, `B-Modal.dc.html` (static copies under `html/`);
grep the relevant block (`YOUR REVIEW SKILLS`, `Edit skill`, `Review &#9662;`), never read one whole. The spec's "Mock differences" table says what is
taken.

## Global Constraints

- Copy, verbatim from the spec's §Copy (every string there is exact; tasks below quote the ones they own).
- 400 `group must be run or review`; 400 `<name> is a review skill and needs an MR`; 400 `<name> is a run skill and takes no MR`; 400 `half is the review
  bot's only`; 400 `mr must be { project, iid, url, source, target }`; 409 `!<iid> changed since the sheet opened — reopen the sheet`; reused 400
  `!<iid> is not an open merge request of <KEY>`.
- `jira/` never imports the GitLab poller (`.claude/rules/jira.md`); only dispatch (`server/src/agents/`) reads the GitLab cache.
- Every route stays under `/api` behind its existing guard; no new route.
- The bot review's wire, prompt, gate and state checks are byte-for-byte unchanged; every existing bot-review test stays green unedited.
- Escape has one owner: any new Escape handling goes through `useDialogEscape` (`.claude/rules/board.md`).
- Before editing a file under a `.claude/rules/` glob without `Read`ing it, read the rule file (CLAUDE.md §Rule files).
- Comments explain why at the repo's density; new prose wraps at 160 columns.
- Tests: jest suites under `test/<feature>/`; run only touched suites plus source-guard hits (`grep -l <symbol> test/` for each symbol gaining a caller).

## Review Focus

1. An existing `jira.json` with no `group` key: every skill is Run; Run ▾, the default action and Setup behave exactly as before — Task 1, Task 5.
2. An older client posting `/api/jira/skills` without `group` to UPDATE a review skill must not move it to Run — Task 1.
3. MR retargeted or its branch renamed between preview and Start: dispatch refuses with the 409, never spawns a prompt the preview did not show — Task 4.
4. A stored `jiraDefaultAction` naming a skill that became a review skill: Run ▾'s left half starts `execute`, never the review skill — Task 5.
5. Escape inside the inline skill editor while the Settings page sits under a dialog-less page: one press cancels the editor only — Task 6.

---

### Task 1: Skill group in the type, the reader and the writer

**Files:**
- Modify: `shared/types.ts` (`JiraSkill`, ~line 974)
- Modify: `server/src/jira/config.util.ts` (`readSkill` ~221, `JiraSkillWrite` ~334, `parseSkillWrite` ~387, `writeSkill` ~622)
- Test: `test/jira/jira-config.test.ts`, `test/jira/jira-config-write.test.ts`, `test/jira/jira-write-routes.test.ts`

**Interfaces:**
- Produces: `export type JiraSkillGroup = 'run' | 'review'`; `JiraSkill = { id; name; prompt; group: JiraSkillGroup }`; `JiraSkillWrite` gains
  `group?: JiraSkillGroup`.

- [ ] **Step 1: Failing tests**
  - reader: entry without `group` → `group: 'run'`; `'review'` → `'review'`; `group: 'x'` / `group: 3` → entry dropped (warned), siblings kept.
  - `parseSkillWrite`: absent `group` → ok, `group` undefined; `'review'` → ok; `'Review'`, `''`, `1` → `{ ok: false, error: 'group must be run or review' }`.
  - `writeSkill` create without `group` → file entry has `group: 'run'` literally; create with `review` stores `review`.
  - `writeSkill` update of a stored `review` skill without `group` → stored `group` stays `review`, id and index unchanged; update with `group: 'run'` →
    `run`, id and index unchanged.
  - routes: `POST /api/jira/skills` with `group: 'nope'` → 400 `group must be run or review`, file unchanged; `POST /api/jira/skills/order` over a mixed
    list (run, review, run) reorders and round-trips groups.
- [ ] **Step 2:** run the three suites; the new cases fail.
- [ ] **Step 3:** implement. Update merge must not inject a default `group` (only spread `group` when the write carries one).
- [ ] **Step 4:** suites pass; `pnpm run typecheck` — fix every `JiraSkill` literal the new required field breaks (tests' fixtures included: give each
  fixture an explicit `group`).
- [ ] **Step 5:** commit `feat(jira): skills carry a run or review group`.

### Task 2: The review-skill MR shape and the compose

**Files:**
- Modify: `shared/types.ts` (add `ReviewSkillMr`)
- Modify: `server/src/jira/prompt.util.ts` (`JiraComposeAction` ~51, `skillPrompt` ~226, `PLACEHOLDER_RE`, `resolveJiraActionOrThrow` ~264)
- Test: `test/jira/jira-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1's `JiraSkill.group`.
- Produces: `export interface ReviewSkillMr { project: string; iid: number; url: string; source: string; target: string }` (shared);
  `export function parseReviewSkillMr(raw: { project: unknown; iid: unknown; url: unknown; source: unknown; target: unknown }, iidFrom: 'query' | 'body'): ReviewSkillMr | null`
  in `prompt.util.ts` (query: digit string per `parseReviewMr`; body: JSON number only); `JiraComposeAction`'s skill variant becomes
  `{ kind: 'skill'; skill: JiraSkill; mr: ReviewSkillMr | null }`; `resolveJiraActionOrThrow(action, skills, mr: ReviewSkillMr | null)` applies the two
  group/MR 400s after finding the skill.

- [ ] **Step 1: Failing tests**
  - `parseReviewSkillMr`: valid five → object; `url` `ftp://x` / 2 001 chars / non-string → null; `http://gitlab.local/a/-/merge_requests/3` → ok; `source`
    `a..b` (a `branchNameProblem` refusal) → null; `target` missing → null; body `iid: '7'` → null, query `iid: '7'` → 7.
  - `resolveJiraActionOrThrow({ skill: rev.id }, skills, null)` → 400 `<rev name> is a review skill and needs an MR`; `({ skill: run.id }, skills, mr)` →
    400 `<run name> is a run skill and takes no MR`; unknown id still `unknown skill <id>`.
  - compose, review skill `"/code-review high {mr.url} {mr.iid} {mr.source}->{mr.target} {mr.project} {branch} {base}|"` with mr
    `{ project: 'grp/app', iid: 42, url: 'https://gl/grp/app/-/merge_requests/42', source: 'timify-1-x', target: 'develop' }` and a workspace on
    `timify-1-y` (deliberately not the MR's source, in this pure-compose case) → body
    `/code-review high https://gl/grp/app/-/merge_requests/42 42 timify-1-x->develop grp/app timify-1-y |` then `\n\nJira ticket: <KEY>`
    (no `{key}` in template).
  - compose, run skill with `{mr.url}` in its template and `mr: null` → `{mr.url}` stays literal.
  - `{key}` named → no key line appended (both groups).
- [ ] **Step 2:** fail. **Step 3:** implement; `{mr.*}` substituted only when `mr !== null`. **Step 4:** pass, typecheck (both callers of
  `resolveJiraActionOrThrow` pass `null` for now). **Step 5:** commit `feat(jira): review skills compose against one MR`.

### Task 3: The preview route takes a review skill's MR

**Files:**
- Modify: `server/src/jira/jira.controller.ts` (`GET /api/jira/prompt`, ~170-235)
- Test: `test/jira/jira-routes.test.ts` (it already covers `GET /api/jira/prompt` and the bot review's `mrProject`/`mrIid`/`half`)

**Interfaces:** Consumes Task 2's `parseReviewSkillMr(…, 'query')` and `resolveJiraActionOrThrow(…, mr)`.

- [ ] **Step 1: Failing tests**
  - `action=skill:<review id>` + all five `mr*` → 200, prompt contains the URL and branches.
  - same without `mrUrl` (and, separately, with `mrSource=a..b`) → 400 `mr must be { project, iid, url, source, target }`.
  - `action=skill:<review id>` with no `mr*` → 400 `<name> is a review skill and needs an MR`; `skill:<run id>` with the five → 400 `<name> is a run skill
    and takes no MR`; `skill:<review id>` + five + `half=request` → 400 `half is the review bot's only`.
  - `action=review` requests unchanged (existing cases untouched).
- [ ] **Step 2–4:** fail, implement (an `mr*` key present on a skill action means "an MR was sent": any of the five present → parse all five), pass.
- [ ] **Step 5:** commit `feat(jira): preview a review skill on an MR`.

### Task 4: Dispatch a review skill

**Files:**
- Modify: `shared/types.ts` (`JiraDispatchRequest.mr` → `{ project; iid } | ReviewSkillMr`, doc comment)
- Modify: `server/src/agents/jira-agents.controller.ts` (~60-76), `server/src/agents/jira-dispatch.service.ts` (`dispatch` ~130-190, `reviewOrThrow` ~215,
  `launch` ~293)
- Test: `test/jira/agents-dispatch-jira.test.ts`

**Interfaces:** Consumes Tasks 2–3. Produces nothing new for the client beyond the widened request type.

- [ ] **Step 1: Failing tests** (fixture: a cached open MR `!42`, keys `[KEY, KEY2]`, `webUrl` W, source S, target T, plus a second cached open MR `!43` on another branch so
  the lookup is scoped; a review skill R; a run skill U)
  - body `{ action: { skill: R }, mr: { project, iid: 42, url: W, source: S, target: T }, choice continue S }` → spawns; prompt contains W; the link stores
    branch S; works with `mr.review === null` and with a `clean` review state.
  - each of `url`, `source`, `target` differing from the cache → 409 `!42 changed since the sheet opened — reopen the sheet` (three cases), nothing spawned;
    the `source` case sends `mr.source` and `choice.branch` both on the OLD name (what a stale sheet sends), and still gets the 409, not `a review continues`.
  - MR not cached / `merged` / keys without KEY or parent → 400 `!42 is not an open merge request of KEY`.
  - repo not a candidate → 400 `<repo> is not a review candidate for !42`; choice `new` or branch ≠ S or `openMr` → 400 `a review continues S`.
  - malformed five-field body (iid as string; url missing) → 400 `mr must be { project, iid, url, source, target }`; `half` with a skill → 400
    `half is the review bot's only`; R without `mr` → 400 needs-an-MR; U with `mr` → 400 takes-no-MR.
  - strict gate: a quiet live `run` link on KEY blocks R (409, today's sentence) though it would yield to a Run; R on KEY and R on KEY2, both on S, raced → one spawns, the
    other 409 `a session is live on S` (different keys, so only the branch hold can refuse).
- [ ] **Step 2:** fail. **Step 3:** implement — controller parses `mr` with `iidFrom: 'body'` when the action is a skill and `body.mr` is present; service
  runs a `reviewSkillOrThrow` sharing `reviewOrThrow`'s candidate / `continue` / `notOpen` checks (extract the shared part; no state or half checks), with the
  three-field comparison placed right after the cache / `opened` / keys check and BEFORE the candidate and `continue` checks, then composes from the cache
  values; `strict` true for `review` and for a review skill; the branch hold applies to both.
- [ ] **Step 4:** pass + the whole suite (bot cases unchanged). **Step 5:** commit `feat(jira): dispatch a review skill on an MR's branch`.

### Task 5: Client libraries — run-only resolution, labels, wire, reason tail

**Files:**
- Modify: `client/src/lib/jira.ts` (`resolveJiraAction` ~1116, `fetchJiraPrompt` ~1283, `dispatchJira` ~1664), `client/src/lib/jira-sessions.ts`
  (`runLabel` ~251), `client/src/lib/jira-list.ts` (`runOptionLabel` ~228), `client/src/lib/review-copy.ts` (`reviewBlockedTail` ~113),
  `client/src/components/settings/SettingsView.tsx` (Jira default action select)
- Test: `test/jira/jira-lib.test.ts`, `test/jira/jira-sessions-lib.test.ts`, `test/jira/jira-list.test.tsx`, `test/settings/settings-view.test.tsx` (its `the Jira default action row` block)

**Interfaces:**
- Produces: `fetchJiraPrompt(key, action, repo, branch, review?: { half; mr: { project; iid } } | { skillMr: ReviewSkillMr })` (query names `mrProject`,
  `mrIid`, `mrUrl`, `mrSource`, `mrTarget`); `dispatchJira` sends `mr: ReviewSkillMr` for a skill review; `reviewBlockedTail(label: 'Fix review' |
  'Request review' | 'Review')`; `isReviewSkill(action: JiraAction, skills: readonly JiraSkill[]): boolean`.

- [ ] **Step 1: Failing tests**
  - `resolveJiraAction(R.id, skills)` with R a review skill → `'execute'`; a run skill id → `{ skill }` as today.
  - `runLabel` for a link with R's action → `Review the MR · <R name>`; run skill → bare name; deleted id → bare id (no prefix).
  - `applyListFilters(...).runs` over a link whose action is `{ skill: R }` → the option labelled `Review the MR · <R name>` (`runOptionLabel` is
    module-private; the `skills` parameters of `applyListFilters`, `runOptionLabel` and `runLabel` widen to `{ id; name; group }`).
  - `reviewBlockedTail('Review')` → ` — Review waits until it ends or you stop it.`
  - `fetchJiraPrompt` with `{ skillMr }` → query has the five names, no `half`.
  - Settings › `Jira default action` select (in `settings-view.test.tsx`) lists run skills only.
- [ ] **Step 2–4:** fail, implement, pass. **Step 5:** commit `feat(jira): client libraries know review skills`.

### Task 6: Setup › Skills — switch, groups, inline editor

**Mock:** `Review-Skills.dc.html` (switch, heads, rows, Edit block) — with the spec §2 and Mock-differences table deciding what is drawn.

**Files:**
- Modify: `client/src/components/jira/JiraSkillsGroup.tsx` (+ its CSS where the card's styles live), `client/src/hooks/useDialogEscape.ts` (header list only),
  `.claude/rules/board.md` (Escape bullet's non-dialog entries)
- Test: `test/jira/jira-setup.test.tsx`, `test/board/dialog-escape.test.tsx`

**Interfaces:** Consumes Task 1 (`group`), Task 5 (`reviewBlockedTail` not needed here). Posts `POST /api/jira/skills` `{ id?, name, prompt, group }`.

- [ ] **Step 1: Failing tests** (fixture: run A, review R1, run B, review R2, run C — interleaved on purpose, groups unequal)
  - scope line is the spec's; switch shows `Run 3` / `Review 2`, Run pressed; explainer per segment exact.
  - Run segment: heads `Built in` (two built-in rows), `Your run skills · 3`, hint `↑↓ to reorder · order = menu order`; rows A, B, C in that order; A's ↑ and
    C's ↓ disabled.
  - Review segment: built-in row `Review bot` / `request a review, or fix what it found` with no `Make default`; `Your review skills · 2`; rows R1, R2; Review
    hint `Fills in: …` exact; no `Make default` on R1/R2.
  - ↓ on R1 posts `/skills/order` with `[A, R2, B, R1, C]` (whole list, only the review slice moved).
  - empty Review group → `No review skills yet.`, no `Your review skills` head, no order hint; a group with one skill draws no order hint.
  - add row on Review segment with placeholders `Claude code review` / `/code-review high {mr.url}` posts `group: 'review'`.
  - `Edit` on R1: row becomes name+prompt pre-filled, Group with `Review` pressed and its sub-line, `Save` / `Cancel`; switching Group to Run hides the
    sub-line; Save posts `{ id: R1, name, prompt, group: 'run' }`; on 400 the alert row shows the error and the editor stays; opening `Edit` on R2 closes
    R1's editor; pressing `×` on a row closes an open editor.
  - remove confirm text per group (spec Copy).
  - Escape with the editor open closes the editor only (in `dialog-escape.test.tsx`, beside the `ui/Confirm` case).
- [ ] **Step 2–4:** fail, implement (segment state local, not persisted; editor calls `useDialogEscape` while open), pass; also run
  `test/guards/dialog-count-docs.test.ts` and the `claude-rules` guard (the step 5 doc edits).
- [ ] **Step 5:** update the `useDialogEscape.ts` header and `board.md`'s Escape bullet to name the skill editor as a non-dialog entry; commit
  `feat(jira): Setup › Skills shows Run and Review skills apart`.

### Task 7: Run surfaces and the launch sheet

**Mock:** `Main.dc.html` (none new for Run ▾); `B-Modal.dc.html` for the sheet tile wording only.

**Files:**
- Modify: `client/src/components/jira/JiraRunMenu.tsx` (~216), `client/src/components/jira/JiraLaunchSheet.tsx` (`review` prop ~116, tiles ~322-370, preview
  call ~206, Start), `client/src/components/jira/JiraBranchSection.tsx` (lock ~138, `useBranchState` `locked`)
- Test: `test/jira/jira-run-menu.test.tsx`, `test/jira/jira-launch.test.tsx`

**Interfaces:**
- Produces: `JiraLaunchSheet` prop `review?: { half: ReviewHalf; mr: { project; iid; sourceBranch }; repos: string[] } | { skill: string; mr: GitlabMr;
  repos: string[] }`.

- [ ] **Step 1: Failing tests**
  - Run ▾ lists run skills only; `Skills on this machine · N` counts run skills; a machine with only review skills draws no skills head.
  - non-review launch sheet: `A skill` tile sub-line `<n> on this machine` counts run skills; select options run skills only; only review skills → tile
    disabled with `no skills on this machine`.
  - skill-review sheet: one pressed inert tile, title R's name, sub-line `on !42 · timify-1-x`; branch section shows `Continue` + source branch, no picker,
    no MR switch; preview query carries the five `mr*` names and no `half`; Start posts `action: { skill: R }`, `mr` five-field, no `half`; Desktop seeded
    when available (as the bot sheet).
  - bot review sheet unchanged (existing tests).
- [ ] **Step 2–4:** fail, implement, pass. **Step 5:** commit `feat(jira): launch a review skill from its MR`.

### Task 8: `Review ▾` on the Delivery row

**Mock:** `Main.dc.html` target row (`▶ Request review ▾`, its menu: `BUILT IN` · bot row · `default`); spec §4 table for the ghost.

**Files:**
- Modify: `client/src/components/jira/ReviewRow.tsx` (`ReviewSplit` chevron, header comment), `client/src/components/jira/NextRow.tsx` (control table, header
  comment), `client/src/components/jira/JiraDeliveryTab.tsx` (the one renderer of `NextRow`: thread `onReviewSkill(skillId, mr, repos)` beside
  `onReview`, and on up to wherever `onReview` opens the launch sheet — follow `onReview`'s callers)
- Modify (composer count): `.claude/rules/board.md` ~25, `client/src/hooks/useDialogEscape.ts` ~52, `test/guards/dialog-count-docs.test.ts:114`
- Create: `client/src/components/jira/ReviewMenu.tsx` (the `ui/Popover` menu, `label="Review menu"`)
- Test: `test/jira/jira-delivery-tab.test.tsx` (and `jira-delivery-pane.test.tsx` where it already covers the split)

**Interfaces:** Consumes Task 5 (`reviewBlockedTail('Review')`, `skillCommand`), Task 7 (sheet's skill variant). Produces
`ReviewMenu({ mr, half: ReviewHalf | null, skills: JiraSkill[], blocked: string | null, onBot?: () => void, onSkill: (id: string) => void, ghost: boolean })`.

- [ ] **Step 1: Failing tests** (two review skills unless stated)
  - `request` row: split + chevron (aria-label `More reviewers`); menu head `Built in`, row `Review bot — request review` / `Posts the review request on !42`
    with `default`, head `Your review skills`, two skill rows with command sub-lines; bot row = left half's action; skill row opens the sheet's skill variant
    for that MR.
  - `fix` row: bot row `Review bot — fix findings` / `Fixes the open findings on !42`.
  - zero review skills: split exactly as today, no chevron, no ghost on any kind.
  - `fix` with a live bot review link: `Open session`, then ghost `Review ▾` (aria-label `Review with a skill`) whose menu has no bot row.
  - `fix` with a live review-SKILL link (not the bot's) on that branch: still the split + chevron, never `Open session` (a skill session is not
    `liveReviewLink`).
  - `run` row: Run ▾ then ghost; `merge` and `gitlab`: chip then ghost; no next kind on an OPEN MR (row `null` today): the row draws with the ghost alone;
    a merged lead and a closed lead (also `button: null`, `client/src/lib/delivery.ts:370`) draw no ghost — the ghost requires `mr.state === 'opened'`.
  - gate held (live run link on KEY): chevron, ghost and skill rows disabled with the gate sentence as title; ghost reason line ends ` — Review waits until it
    ends or you stop it.`; split reason line unchanged.
  - hidden when agents off / no candidate repo / no `onReview` (each).
  - Escape closes the menu only (it is a `ui/Popover`; add it to the composer lists in `board.md` ~line 25 and `client/src/hooks/useDialogEscape.ts` ~52, "ten composers" →
    eleven, and update `test/guards/dialog-count-docs.test.ts:114`'s `/ten composers/` to match).
- [ ] **Step 2–4:** fail, implement, pass; run source guards for `reviewGate`, `ReviewSplit`, `skillCommand`, `JiraRunMenu` (`grep -l` in `test/`), plus
  `test/guards/dialog-count-docs.test.ts` and the `claude-rules` guard.
- [ ] **Step 5:** commit `feat(jira): Review ▾ offers review skills on each open MR`.

### Task 9: Rules and docs

**Files:** `.claude/rules/jira.md`, `.claude/rules/board.md` (review-button bullet), `.claude/rules/dispatch-watchdog.md` (what a caller influences for
review), `docs/subsystems/invariants.md` (only sections those bullets link that say the review is the bot's alone), `.claude/DESIGN.md` §8.9.3 and §8.9.6,
the Jira subsystem doc's `jira.json` section (`grep -l "skills" docs/subsystems`), and the detail-tabs spec §4.4 "Reserved slot" sentence (add a pointer to
this spec).

- [ ] **Step 1:** edit each per the spec's "Rule and doc updates"; new prose at 160 columns; no reflow of untouched lines.
- [ ] **Step 2:** `pnpm run test:jest -- test/guards` (rule-file guards) and any `tests.md`-scoped suite the edits touch pass.
- [ ] **Step 3:** commit `docs(jira): review skills in the rules and design docs`.

### Task 10: `/ui-verify`

- [ ] Run `/ui-verify` against the three mocks with fixture data: Setup › Skills (both segments, one row in Edit), a Delivery target row with its menu open
  (request kind) and a ghost on a `merge` kind, the live card label `Review the MR · <name>`. Fix defects on the branch; the report goes to the final
  reviewer with the mock paths.
