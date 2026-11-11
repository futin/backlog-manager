# Jira: run a sub-task's parent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a Jira sub-task, reach and run its parent story: the parent link in Detail, a `Run on` toggle in `Run ▾`, and a parent-live line.

**Architecture:** Client only. One shared parent read (a small module over the existing `fetchJiraDetail`) feeds three surfaces; `JiraRunMenu.onPick` gains the
target issue; `JiraDetail` gains the link, its own read-failure line and the parent-live line. No server, route or `shared/` change.

**Tech Stack:** React 18 + TypeScript, jest + @testing-library/react (jsdom), plain CSS in `client/src/styles.css`.

**Spec:** `docs/superpowers/specs/2026-11-11-jira-run-on-parent-design.md` (read it whole; §4 is the behaviour, §6 the test cases this plan maps to tasks).

**This plan specifies behaviour, signatures and exact test cases — never literal code.** Where a step names a function, write the body yourself; where you
think a stated test value is wrong, check the spec and the code and say so in your report rather than transcribing it.

## Global Constraints

- Read `.claude/rules/board.md` before editing anything under `client/src/**` (rule-file table in `CLAUDE.md`).
- CSP: no `style=` attribute or `<style>` element in markup; new looks are classes in `client/src/styles.css`. Design guard 7 (`test/design-guards.test.ts`)
  forbids page rules over `.ui-seg button` — if the toggle is not `ui/Segmented` (whose `label` is a plain string and cannot draw the key over a sub-line), it
  is its own small markup with its own class family, not a restyle of `.ui-seg`. Do not name that family `ui-run-on*` or the component `RunOn`: both already
  exist (`client/src/components/ui/RunOn.tsx`, the machine picker; `styles.css:4211`). A `jira-run-target*` family is free.
- Comments explain *why*, at the file's existing density; each touched component's header comment gains a paragraph for what it now does.
- Copy, verbatim from the spec: segment sub-lines `this sub-task` / `parent <type lower-cased>` (`parent` alone until the type is known); toggle label `Run on`;
  loading title `loading <PARENT-KEY>…`; live title `a session is running on <PARENT-KEY>`; execute sub-line on the parent `Work <PARENT-KEY> end to end`;
  parent-live line `Parent <PARENT-KEY> · <STATE_LABEL[state]> · <repo basename> →` plus `+N more`.
- Tests are flat in `test/` (jest). Before pushing, `grep -l` in `test/` for every symbol this diff adds a caller of — at least `JiraRunMenu`, `fetchJiraDetail`,
  `ticketSessions`, `sessionTone`, `Popover`, `Segmented`, `useJiraSessionsContext` — and run every hit, plus `pnpm run typecheck`.
- Fixture dates (`created`, `updated`, …) in a `.tsx` suite use `daysAgoStamp` / `daysAgoDate` (`test/helpers/dates.ts`), never date literals
  (`.claude/rules/tests.md`). `test/fixture-clock.test.ts` scans every `test/*.test.tsx`: run it in Step 4 of every task that creates or extends one.
- Picked mocks: `docs/superpowers/specs/2026-11-11-jira-run-on-parent-mockups/run-on-toggle.png` (menu) and `parent-live-line.png` (band + link). The mock's
  inline styles and its `Running · 12m` / grey dot are drawing aids; the spec's §4.3 lists the intended differences.

## Review Focus

1. **Key swap mid-read** — reader opens sub-task A, clicks its parent link, then swaps to another issue before the read lands: the landed parent must not be
   pushed onto the walk (spec §5, `keyRef`). Test in Task 3.
2. **Toggle state leaks across issues** — one card's menu picked the parent, then another sub-task's menu opens: it must start on the sub-task segment. Test in
   Task 2 (reopen resets; different issue resets).
3. **Two surfaces, one parent** — the Detail's link and its menu ask for the same parent in one open: exactly one `GET /api/jira/issue/<parent>`. Test in Task 1
   (joined pending read) and Task 3 (link then menu → one fetch).
4. **Parent in another project** — the gate must read the parent's own `project.key` repos: sub-task in a mapped project, parent in an unmapped one → parent
   rows `no-repo`-disabled while sub-task rows stay enabled. Test in Task 2.
5. **Stub issue on the Sessions page** — a `stubIssue` with `parent.summary === ''` must still draw the toggle and read by key. Test in Task 2.

---

### Task 1: The shared parent read

**Files:**
- Create: `client/src/lib/jira-parent.ts`
- Test: `test/jira-parent.test.tsx`

**Interfaces:**
- Consumes: `fetchJiraDetail(key: string): Promise<JiraIssueDetail>` (`client/src/lib/jira.ts:963`; throws `Error(failureOf(res))` on a non-2xx).
- Produces:
  - `type ParentRead = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; issue: JiraIssue } | { state: 'failed'; error: string }`
  - `useParentRead(parentKey: string | null): { read: ParentRead; ask: () => Promise<JiraIssue | null> }` — `ask` starts (or joins) the read and resolves
    to the issue, or `null` on failure; `read` reflects it for this surface only.
  - `parentLiveLine(issue: JiraIssue, payload: JiraSessionsPayload | null): { lead: SessionLink; more: number } | null` and
    `parentLineText(parentKey: string, lead: SessionLink): string`.

Behaviour (spec §4.1, §4.2, §7): a module-level map of in-flight and landed reads keyed by parent key; a pending read is joined, never repeated; a failed one
is removed at once (never cached); a landed one is kept while at least one mounted `useParentRead` for that key is alive (reference count by mount) and dropped
when the last unmounts. Because a card's `JiraRunMenu` stays mounted as long as the card is drawn, the menu's hook must live in the OPEN panel only (a child
rendered while the menu is open), so closing the menu releases it (spec §7: "while the Detail or menu that asked is open"); the Detail's hook lives with the
Detail. `ask` never runs on mount — only when called. Each hook instance holds its own `read` state (per-surface failure display, spec §4.2). `JiraView`
renders `JiraDetail` without a React `key`, so a walk reuses the instance: on a `parentKey` change the instance's `read` resets to `idle` and its reference
moves to the new key. `parentLiveLine` returns `null` unless `issue.type.subtask && issue.parent !== null`, else the parent key's live links via `ticketSessions` —
lead = `live[0]` (newest start), `more = live.length - 1` — or `null` when none are live. `parentLineText` is `Parent <KEY> · <STATE_LABEL[lead.state]> ·
<basename of lead.repo> →`.

- [ ] **Step 1: Write the failing tests** — `test/jira-parent.test.tsx`, `global.fetch` mocked as in `test/jira-detail.test.tsx:222`:
  - two hooks for `P-1` both `ask()` while pending → `fetch` called once with `/api/jira/issue/P-1`; both resolve to the same issue; both `read.state` `ready`.
  - `ask()` after a 500 `{ error: 'boom' }` → resolves `null`, `read` is `{ state: 'failed', error: 'boom' }`; a second `ask()` fetches again (2 calls).
  - mount A, `ask()` lands; mount B, `ask()` → no new fetch; unmount both; mount C, `ask()` → fetches again.
  - a hook that never calls `ask` → no fetch, `read.state` `idle`.
  - `useParentRead(null)` → `ask()` resolves `null` without fetching.
  - two keys at once: hook on `P-1` and hook on `P-2` both `ask()` while pending → two fetches; each resolves to its own issue (distinct summaries).
  - rerender one hook `P-1` → `P-2` after `P-1` landed → `read.state` `idle`; `ask()` fetches `/api/jira/issue/P-2` and lands `P-2`, not `P-1`.
  - per-surface failure: hooks A and B on `P-1`; only A asks, read 500 `{ error: 'boom' }` → A `failed` `boom`, B still `idle`.
  - `parentLiveLine`: sub-task with parent `P-1`, payload with two live links on `P-1` started 10:00 and 10:05 and one ended → lead is the 10:05 link,
    `more === 1`; same payload on a story with epic parent `P-1` → `null`; sub-task with no live parent link → `null`.
  - `parentLineText('P-1', { state: 'working', repo: '/x/y/microservice', … })` → `Parent P-1 · Working · microservice →`.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-parent.test.tsx` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the three exports in `client/src/lib/jira-parent.ts` with a header comment saying why the read is shared and why failures are not cached.
- [ ] **Step 4: Run** the same command — PASS. `pnpm run typecheck` — clean.
- [ ] **Step 5: Commit** `feat(jira): a shared parent read for sub-tasks` (add the two files by path).

### Task 2: `Run on` in `JiraRunMenu`, four callers

**Files:**
- Modify: `client/src/components/jira/JiraRunMenu.tsx` (props at ~:60, rows at :83-86, panel at :156-164, header comment)
- Modify: the four callers' closures — `JiraDetail.tsx:306`, `JiraCard.tsx:179`, `JiraIssueList.tsx:177`, `JiraSessionList.tsx:372`
- Modify: `test/jira-board.test.tsx` (spec §6 case 12)
- Modify: `client/src/styles.css` (toggle classes, beside the `.jira-run-*` family)
- Modify: `.claude/DESIGN.md` §8.9.1 (the Run menu paragraph: the toggle, when it draws, its copy)
- Test: `test/jira-run-menu.test.tsx` (new; copy the provider harness from `test/jira-board.test.tsx`)

**Interfaces:**
- Consumes: `useParentRead`, `ParentRead` (Task 1); `runChipState(issue, status, sessions)` (`lib/jira.ts:836`).
- Produces: `JiraRunMenu` prop `onPick: (issue: JiraIssue, action: JiraAction) => void` (was `(action) => void`). Each caller passes `onRun` straight through
  (its type is already `(issue, action)`).

Behaviour: spec §4.2 in full. The left `Run` half still calls `onPick(issue /* the sub-task */, defaultAction)`. The toggle draws only when
`issue.type.subtask && issue.parent !== null`; its state lives in the menu and resets to the sub-task on every open. Picking the parent segment calls `ask()`;
picking it again while `failed` asks again and clears the note. Parent rows' gate = `runChipState(parentIssue, …)` once ready; `loading`/`failed`/`live`/
`no-repo` disable every row with the spec's title; the failed note sits under the toggle.

- [ ] **Step 1: Write the failing tests** (spec §6 cases 4–10, 13, 16 plus Review Focus 2, 4, 5):
  - story with an epic parent → no `Run on` group.
  - sub-task `S-1` (parent `P-1`): menu opens with `S-1` segment pressed; `Work it end to end` → `onPick(S-1 issue, 'execute')`.
  - pick `P-1` segment, fetch pending → every row disabled, title `loading P-1…`; resolve with a `P-1` detail (type `Story`) → segment sub-line `parent story`;
    `Work it end to end` → `onPick(P-1 issue, 'execute')`; a skill with distinct id, name and prompt (`{ id: 'sk-review', name: 'Review',
    prompt: '/review-it' }`, cf. `test/jira-board.test.tsx:887`) → its row `Review` → `onPick(P-1 issue, { skill: 'sk-review' })`; execute row's sub-line
    `Work P-1 end to end`.
  - sessions payload holding a live `run` link on `P-1` → parent rows disabled, title `a session is running on P-1`; switch back to `S-1` → rows enabled.
  - `P-1` detail's `project.key` is `OTHER`, which has no repo in status `repos` while `S-1`'s project has one → parent rows disabled with the no-repo title
    naming `OTHER`; `S-1` rows enabled.
  - close and reopen → `S-1` segment pressed again. Render a second sub-task's menu after picking `P-1` in the first → it opens on its own sub-task segment.
  - card home: rendering 3 sub-task cards fetches nothing; only picking the parent segment fetches.
  - a `stubIssue('S-9', { summary: 's', type: 'Sub-task', parentKey: 'P-9' }, '')` row → toggle shows `P-9`; pick → fetch `/api/jira/issue/P-9`; it lands
    → `Work it end to end` → `onPick` receives the read `P-9` issue (not the stub `S-9`).
  - caller closures (spec §6 case 13, anti-goal 1): one case in `test/jira-list.test.tsx` (a sub-task's List cell) and one in the suite that renders Sessions
    rows (`grep -l JiraSessionList test/`): parent segment, read lands, `Work it end to end` → the page's `onRun` receives the parent issue. A closure that
    drops the issue argument (`(_i, a) => onRun(top, a)`) must fail these.
  - menu re-read after close: card home, pick `P-1`, read lands, close, reopen, pick `P-1` → second fetch.
  - parent read 500 `{ error: 'boom' }` → rows titled `boom`, note `boom`; click the `P-1` segment again → note gone, second fetch; it lands → rows enabled.
  - spec §6 case 12, in `test/jira-board.test.tsx` beside the existing Run cases (rendered through `JiraView`, ~:1045): a sub-task card's menu, parent
    segment, `Work it end to end` → the launch sheet's title names `P-1` (not the sub-task), and with no stored name pattern for the repo the new-branch
    default is `p-1-<slug of P-1's summary>`.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-run-menu.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the toggle, the `onPick` signature, the four closures, the CSS and the DESIGN.md paragraph. Match `run-on-toggle.png`.
- [ ] **Step 4: Run** the new suite plus `test/jira-board.test.tsx test/jira-list.test.tsx test/jira-detail.test.tsx test/jira-setup.test.tsx
  test/design-guards.test.ts` (every current `JiraRunMenu` / `Run menu` hit) — PASS; `pnpm run typecheck` — clean.
- [ ] **Step 5: Commit** `feat(jira): run a sub-task's parent from its Run menu`.

### Task 3: Parent link, read-failure line and parent-live line in `JiraDetail`

**Files:**
- Modify: `client/src/components/jira/JiraDetail.tsx` — crumbs at :247-248, `Parent` fact at :453, band shapes at :312-333 (live) and :335-353 (empty), alert slot
  at :472-476, header comment
- Modify: `client/src/styles.css` (link inside `.jira-detail-crumbs` and the `Parent` fact; reuse `.jira-detail-agent-child` for the line)
- Modify: `.claude/DESIGN.md` §8.9.2 (head crumb link, `Parent` fact link, parent-live line)
- Test: `test/jira-detail.test.tsx` (extend, its existing harness)

**Interfaces:**
- Consumes: `useParentRead`, `parentLiveLine`, `parentLineText` (Task 1); `onOpenIssue(issue, childrenOf)` (existing prop, `JiraView.openChild`).
- Produces: nothing new for later tasks.

Behaviour: spec §4.1 and §4.3. Link click → `ask()`; inert while loading; on success `onOpenIssue(parent, childrenOf)` unless `keyRef.current` no longer
equals the key that asked; on failure the read's own alert line (after `writeError` when both), cleared by the next click or a key swap. The parent read does
NOT go through `useAction`. The line draws from `parentLiveLine(issue, sessions)`, under the sub-line in the empty band and directly under the label row in the
live band; its click is the same as the link's; `ui-stripe-dot` toned by `sessionTone`; `+N more` beside it.

- [ ] **Step 1: Write the failing tests** (spec §6 cases 1–3, 11, 14, 15, 17 plus Review Focus 1, 3):
  - sub-task with `parent: { key: 'P-1', summary: 'S' }`: head crumb and `Parent` fact each have a link named `P-1 S`; click twice quickly → one
    `/api/jira/issue/P-1` fetch; it lands → `onOpenIssue` called once with the P-1 issue and the same `childrenOf` the Detail was given.
  - fetch 500 `{ error: 'boom' }` → an alert reads `boom`; `onOpenIssue` not called.
  - `parent: null` → no link, no `Run on`.
  - click link, then rerender the Detail with another issue before the read resolves → resolve → `onOpenIssue` not called.
  - click the link, then open the Detail's `Run ▾` and pick the `P-1` segment while pending → still one fetch.
  - sessions payload with a live link on `P-1` (state `working`, repo `/r/microservice`), sub-task has none → `Parent P-1 · Working · microservice →`
    under the empty band's sub-line; click → `onOpenIssue` with the read P-1.
  - sub-task has its own live session (state `plan`, repo `/r/web`) AND `P-1` has two live ones (older: `quiet`, `/r/api`, started 10:00; newer: `working`,
    `/r/microservice`, started 10:05) → the line sits in the live band right after the label row and reads exactly `Parent P-1 · Working · microservice →`,
    with `+1 more`.
  - parent read fails, then an Assign is refused → two alerts, write first; click the link again → the read alert is gone.
  - per-surface failure (spec §4.2, §6 case 16): the Detail's menu picks `P-1`, read 500 `boom` → note in the menu, NO alert line in the Detail; separately,
    the link's read fails → alert in the Detail, and opening `Run ▾` and picking `P-1` shows no pre-filled `boom` note before its own read answers.
  - story whose epic `E-1` has a live session → no parent line.
- [ ] **Step 2: Run** `pnpm exec jest test/jira-detail.test.tsx` — the new cases FAIL, the old ones pass.
- [ ] **Step 3: Implement**, matching `parent-live-line.png` (link look) and the spec's §4.3 copy.
- [ ] **Step 4: Run** `test/jira-detail.test.tsx`, `test/jira-run-menu.test.tsx`, `test/design-guards.test.ts`, and every `grep -l` hit from Global
  Constraints — PASS; `pnpm run typecheck` — clean.
- [ ] **Step 5: Commit** `feat(jira): link a sub-task's parent and show its live session`.

### Task 4: `/ui-verify` against the picked mocks

**Files:** none changed unless a defect is found (fix it on the branch, in the task that owns the code, then re-run).

- [ ] **Step 1:** Invoke `/ui-verify` with the two mocks named above. Live views to shoot at 1440×900 and 375×812, `daylight` theme: the sub-task Detail (link
  visible; Agent band with the parent-live line, using `page.route('**/api/jira/sessions*')` fixture data for a live `P-1` session), and the open `Run ▾`
  with the parent segment picked (fixture `**/api/jira/issue/*` for the parent). Assert `scrollWidth <= clientWidth` on the dialog and the menu panel.
- [ ] **Step 2:** Record the report path for the final reviewer; commit any fix as `fix(jira): …`.
