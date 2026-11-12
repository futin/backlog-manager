## Verdict: APPROVE WITH FIXES

Plan: `docs/superpowers/plans/2026-11-11-jira-run-on-parent.md` (reviewed at `c8c677b3`)
Spec: `docs/superpowers/specs/2026-11-11-jira-run-on-parent-design.md`

## What this proposes

A client-only change in four tasks. Task 1 adds `client/src/lib/jira-parent.ts`: a module-level, in-memory read of a sub-task's parent issue keyed by
parent key (pending reads joined, failures never cached, landed reads dropped when no hook holds them) plus two pure helpers for the parent-live line.
Task 2 gives `JiraRunMenu` a `Run on` two-segment toggle on sub-tasks, changes `onPick` to `(issue, action)` and rewires its four callers, so a row picked
on the parent segment opens the launch sheet as the parent's, gated by the parent's own `runChipState`. Task 3 turns the Detail's parent crumb and
`Parent` fact into a link that reads the parent and pushes it onto the walk, adds the read's own alert line, and draws a `Parent <KEY> · <state> · <repo> →`
line in the Agent band. Task 4 is `/ui-verify` against the two picked mocks.

## How the existing system works, per this document

`JiraRunMenu` is one split `Run | ▾` control drawn in four homes (Detail, board card, List cell, Sessions row); each caller closes over its own issue and
forwards a picked action to `onRun(issue, action)`, which `JiraView` turns into the launch sheet. The menu's gate is `runChipState(issue, status, sessions)`
(`no-repo` / `live` / `ready`), keyed by the issue's own `project.key`. `JiraDetail` shows the parent as plain text in the head crumbs and a `Parent`
fact, guards writes through `useAction` with one `writeError` line, and uses `keyRef` to drop a settle that lands after the reader swapped issues; a
Children-row click pushes onto `JiraView`'s walk through `onOpenIssue`. `fetchJiraDetail` is the one reader of `GET /api/jira/issue/:key`, and the sessions
payload already carries every key's links, split per ticket by `ticketSessions`.

Every section of the plan could be paraphrased.

## Checklist results

1. **Coverage** — every spec section has a task; spec §6 cases 1–17 are all assigned (4–10, 13, 16 and 12 to Task 2; 1–3, 11, 14, 15, 17 to Task 3).
   Two cases are only partly covered: case 13 (I3) and case 16 (I4).
2. **Values** — copy strings in plan:25-27 match spec §4.2/§4.3 verbatim. `Work it end to end` matches `shared/types.ts:824`; `Working` matches
   `shared/jira-sessions.ts:47`; the no-repo title matches `JiraRunMenu.tsx:78`; `p-1-<slug>` matches `shared/jira-branch.ts:130`. One wrong test value (I5).
3. **Reality** — all Modify paths and anchors exist: `JiraRunMenu.tsx:60` (props), `:156-165` (panel), `JiraDetail.tsx:306`, `:247-250`, `:453`, `:312-334`,
   `:336-354`, `:472-476`, `JiraCard.tsx:179`, `JiraIssueList.tsx:177`, `JiraSessionList.tsx:372`, `lib/jira.ts:963` and `:836`, `ui/RunOn.tsx`,
   `styles.css:4211`, `.jira-detail-agent-child` (`styles.css:1501`), `Segmented`'s string `label` (`ui/Segmented.tsx:32`), design guard 7
   (`test/design-guards.test.ts:310`, `.ui-seg` at `:340`), DESIGN.md §8.9.1/§8.9.2. Create paths (`client/src/lib/jira-parent.ts`,
   `test/jira-parent.test.tsx`, `test/jira-run-menu.test.tsx`) do not exist. No `jira-run-target` class exists. Two anchors are off by one (Minor).
4. **Interfaces** — `useParentRead`, `ParentRead`, `parentLiveLine`, `parentLineText` are produced in Task 1 and consumed with the same spelling in
   Tasks 2 and 3. `SessionLink` (`lib/jira-sessions.ts:170`) carries `state` and `repo`. `onRun` is already `(issue, action)` (`JiraView.tsx`, `run`).
5. **Order** — no task depends on a later one; Task 3's link-then-menu test needs Task 2, which precedes it. No external prerequisite.
6. **Tests** — see I2, I3, I4, I5, I6, I7. Review Focus 1–5 each have a named test.
7. **Conventions** — the plan stays at behaviour/signature/test-case level; no literal code.

## Critical

None.

## Important

- **I1 — plan:62-64 — the landed read's lifetime is "while a `useParentRead` for that key is mounted", but where the hook mounts in the menu is not
  said.** `JiraRunMenu` is mounted for as long as its card, List row or Sessions row is drawn (`JiraCard.tsx:179`), not only while its panel is open, and
  several sibling sub-task cards share one parent key. With the hook at the component's top level the reference count never reaches zero while the
  board is on screen, so a landed parent is reused indefinitely. Spec §7 (spec:167-169) says a landed read "is reused while the Detail or menu that asked
  is open". The plan's lifetime test (plan:72) is hook-level only and passes either way. Fix: state that the menu's hook lives only while the panel is open
  (a child mounted with the `Popover`, or a release on close), and add a menu-level case: pick the parent, read lands, close, reopen, pick the parent →
  a second fetch.

- **I2 — plan:57-58, 64, 70-74 — the hook's behaviour when `parentKey` changes on a live instance is unspecified, and every Task 1 read test uses the
  single key `P-1`.** `JiraView` renders `JiraDetail` without a `key` (`JiraView.tsx`, the `<JiraDetail issue={openIssue.issue} …>` block), so a walk from
  one sub-task to another keeps the same `JiraDetail` and `JiraRunMenu` instances and only changes the hook's argument. If `read` is not reset, sub-task
  S-2's parent segment can show `ready` with S-1's parent and call `onPick` with the wrong issue. Separately, a map "keyed by parent key" (plan:62) is
  per-key logic that no test exercises with two keys, so a single module-level slot passes every Task 1 case. Fix: state that `read` returns to `idle` and
  the mount count moves when `parentKey` changes; add (a) two hooks for `P-1` and `P-2` asking concurrently → two fetches, each resolving its own issue,
  and (b) one hook rerendered from `P-1` (ready) to `P-2` → `idle`, and `ask()` fetches `/api/jira/issue/P-2`.

- **I3 — plan:114 — spec §6 case 13 is only half mapped.** The spec (spec:144-145) asks for the toggle on a sub-task in the List cell and on a Sessions row
  holding a `stubIssue`, and for a pick there to call `onPick(parentIssue, action)` after the read. The plan's case renders a stub issue and stops at the
  fetch; nothing renders `JiraIssueList` or `JiraSessionList`, and nothing asserts the picked issue. Those are two of the four rewired closures
  (`JiraIssueList.tsx:177`, `JiraSessionList.tsx:372`); a closure written `(_issue, a) => onRun(top, a)` passes typecheck and every planned test while
  starting the session on the sub-task, which is the spec's first anti-goal (spec:36-37). Fix: extend the stub case to assert `onPick` receives the read
  `P-9` issue, and add one List-cell and one Sessions-row case asserting `onRun` is called with the parent issue.

- **I4 — plan:115 (and plan:64, 71) — per-surface failure display has no test.** Spec §6 case 16 (spec:149-150) includes "no Detail alert line", and §4.2
  (spec:88-90) requires both directions: a menu failure never draws the Detail's alert, a failed link click never pre-fills the menu note. The plan's
  case asserts the menu's title and note only, and Task 1's failure case (plan:71) uses one hook. An implementation that stores the failure in the shared
  map passes. Fix: in Task 1 add two hooks on `P-1`, A's `ask()` fails → A is `failed`, B stays `idle`; in Task 3 add the Detail-hosted case: menu parent
  read fails → no `role="alert"` in the ticket pane, and link read fails → opening the menu shows no note.

- **I5 — plan:107 — the expected skill action `{ skill: '/x' }` uses the slash command as the id.** A skill row's action is `{ skill: k.id }`, its label is
  `k.name` and the slash command is only the sub-line (`JiraRunMenu.tsx:88`); the existing fixture keeps the three distinct
  (`test/jira-board.test.tsx:887`: `s_0a1b2c3d` / `Groom ticket` / `/jira-groom {key}`). As written the fixture needs id = command, which does not
  discriminate which field the action carries. Fix: name a skill with distinct id, name and prompt and expect `onPick(P-1 issue, { skill: <that id> })`.

- **I6 — plan:152-153 — the live-band case does not require distinguishable sessions.** It asserts "text for the newer `P-1` session", but the text is
  only state and repo basename; if the two parent sessions and the sub-task's own session share state and repo, an implementation that picks the older
  parent link, or the sub-task's own link, passes. Fix: give the three sessions distinct state and repo (for example sub-task `working` in `/r/web`,
  older parent `quiet` in `/r/api`, newer parent `working` in `/r/microservice`) and assert the exact line `Parent P-1 · Working · microservice →`.

- **I7 — plan:28-29, 69, 91 — two new `.tsx` suites are created without the fixture-clock rule or its guard in the run list.**
  `test/fixture-clock.test.ts:63-70` reads every `test/*.test.tsx` and fails on a literal `created:` / `updated:` date; every `JiraIssue` fixture carries
  both (`shared/types.ts:767`), and the existing Jira suites use `daysAgoStamp` (`test/jira-detail.test.tsx:53-54`). `.claude/rules/tests.md` makes this a
  rule, and CLAUDE.md's "touched includes the source guards" applies, but the symbol `grep -l` in plan:28-29 cannot find this guard. Fix: add to Global
  Constraints that issue fixtures take `created`/`updated` from `test/helpers/dates.ts`, and add `test/fixture-clock.test.ts` to Task 1 and Task 2's
  Step 4 runs.

## Minor

- plan:69 — the `global.fetch` mock is at `test/jira-detail.test.tsx:223`, not `:222`.
- plan:86 — the built-in rows are at `JiraRunMenu.tsx:84-87`, not `:83-86`; the panel ends at `:165`.
- plan:106 — the parent fixture's type is `Story`, the spec's own example, so a hard-coded `parent story` passes; a second type (`Bug` → `parent bug`)
  would pin the lower-casing. The `parent`-alone sub-line before the read lands is not asserted either.
- plan:98 — the left `Run` half staying on the sub-task while the parent segment is picked (spec §3.4, an anti-goal) is stated but has no test.
- plan:107-108 — the execute sub-line staying `Work the ticket end to end` on the sub-task segment is not asserted.
- plan:119 — Step 2 runs only the new suite; case 12 lives in `test/jira-board.test.tsx` and should be shown failing too.
- plan:138 — spec §4.1's "marked busy" and §7's shared busy state for crumb, fact and line are covered only by reference; no test names the mark.
- plan:139 — "cleared by … a key swap" for the read's alert line has no test.
- plan:140 — the plan does not say whether the link's parent key comes from `issue` or `src` (`JiraDetail.tsx:236`), while the line uses `issue`.
- plan:144 — "a link named `P-1 S`" leaves the element open (an in-board navigation with no href has no `link` role by default).
- plan:150-151 — the line's click asserts the issue but not that `childrenOf` is the Detail's own (spec:170-171).
- plan:166 — the 375×812 shot is beyond the spec's 1440 px; harmless.

## Rulings

| id | outcome | evidence |
| --- | --- | --- |
| 1-1 | FIX | `JiraCard.tsx:179` mounts the menu with the card; plan now puts the menu's hook in the open panel and adds a close/reopen re-read case. |
| 1-2 | FIX | `JiraView.tsx:107` renders `JiraDetail` without a `key`; plan states reset-on-key-change and adds two-key and P-1→P-2 cases. |
| 1-3 | FIX | Stub case now asserts the read P-9 reaches `onPick`; List-cell and Sessions-row closure cases added. |
| 1-4 | FIX | Per-surface failure cases added to Task 1 (hook B stays idle) and Task 3 (menu fail → no Detail alert; link fail → no menu note). |
| 1-5 | FIX | `JiraRunMenu.tsx:88` builds `{ skill: k.id }`; fixture now has distinct id/name/prompt. |
| 1-6 | FIX | Live-band case gives the three sessions distinct state and repo and asserts the exact line. |
| 1-7 | FIX | `.claude/rules/tests.md:25-28`; constraint added: `daysAgoStamp`, run `test/fixture-clock.test.ts` per `.tsx` task. |
