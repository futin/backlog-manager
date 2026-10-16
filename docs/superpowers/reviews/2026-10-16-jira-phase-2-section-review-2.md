# Review 2 (re-check) — `docs/superpowers/plans/2026-10-16-jira-phase-2-section.md`

**Scope:** the changed hunks only (`plan-review-1.diff`, 10 hunks: R8–R11, the constants line, Task 1 Files and `parseBoardWrite` cases, Task 2 Test line and
the long-sweep case, Task 5's `cardAgeStamp`/`bandSub`/`boardRowLine` strings, Task 7's DESIGN.md stub and `nav.test.tsx`, Task 8's projects-fetch ownership
and `3 s`/`0 s` strings, Task 9's one-initial chip). Spec: `docs/superpowers/specs/2026-10-15-jira-integration-design.md`.

**Verdict: APPROVE.** No Critical, no Important. Five Minor.

## What was verified (claim → evidence)

| Changed line | Claim | Evidence |
| --- | --- | --- |
| plan:61–62 (R9) | `pollAge` in `lib/tracker.ts` prints `12 s` under a minute, `elapsedSince` above | `client/src/lib/tracker.ts:36-43` — `if (ms < MS_PER_MINUTE) return \`${…} s\`; return elapsedSince(…)` |
| plan:61–62 (R9) | the spec writes both `Xs` and `3 s` | spec:214 `polled Xs ago`; spec:244 `checked 3 s ago` — the ruling is needed and lands on the existing formatter |
| plan:63–64 (R10) | `TrackerChip` draws one initial; spec §6.5 says `initial` | `client/src/components/TrackerChip.tsx:48` — `plat.login?.[0]?.toUpperCase()`; spec:255 "initial, `Jira · <name>`" |
| plan:63–64 (R10) | two-letter `initialsOf` is the card's reading | spec:218 "the assignee's initials and name" (card); Task 5 keeps `initialsOf` for the card |
| plan:65–66 (R11) | spec leaves a non-string `id` undefined | spec:175 covers only "client-supplied id on create is ignored" and "unknown id on upsert → 404"; R11 fills the gap in the same shape as the other 400s (plan:76 guard → validate 400 → 503 → 404/409) |
| plan:91 | `BOARD_TRACKER_POLL_MS` lives in `client/src/hooks/useBoard.ts` | `client/src/hooks/useBoard.ts:21` `export const BOARD_TRACKER_POLL_MS = 15_000` |
| plan:152 | Task 1 must also touch `poller.service.ts` `status()` for `armed`/`home` | `shared/types.ts:642-660` `JiraStatusPayload` has neither field; `server/src/jira/poller.service.ts:223-239` returns a literal in the unconfigured branch, so adding the fields breaks `typecheck` until `status()` follows |
| plan:169 | `id: 7` / `id: {}` → `ok: false` naming `id` | consistent with R11 and with Task 3's `{}` → 400 naming `id` (plan:260) |
| plan:203–204 | the poller suite drives sweeps with `await poller.tick()` and real timers | `test/jira-poller.test.ts:26` (header), `:135,:159,:190,…` — no `useFakeTimers` anywhere in the file |
| plan:221–224 | the client's own 10 s deadline would abort one stalled call | `server/src/jira/jira.client.ts:30` `JIRA_TIMEOUT_MS = 10_000`; `:165-175` setTimeout + AbortController race; a `jest.spyOn(client, 'search')` bypasses that wrapper, so held promises are not aborted — the suggested build is sound |
| plan:221–224 | `search` is spy-able on the client | `server/src/jira/jira.client.ts:121` `async search(` is a prototype method |
| plan:309 | `formatCreated` is `lib/item-age.ts`'s formatter | `client/src/lib/item-age.ts:112` `export function formatCreated(created, now)` |
| plan:332–335 | `polled 12 s ago`, `last polled 12 s ago` | follow R9; spec:239 gives the Boards row shape with `polled <age>` and `sync off · last polled …` |
| plan:390 | `.claude/DESIGN.md` has no §8.9 yet; Task 13 writes four subsections | `.claude/DESIGN.md` headings end at `### 8.8 Motion` (line 404); plan:30 and plan:601 name §8.9.1–§8.9.4 with the same four titles |
| plan:411 | `test/nav.test.tsx` ~388 pins the four names | `test/nav.test.tsx:388` `expect(SECTIONS).toEqual(['board', 'runs', 'archive', 'settings'])`; `client/src/lib/sections.ts:30` |
| plan:411 | `jira` between `archive` and `settings` | spec:192, plan:85, plan:383 agree |
| plan:497 | Setup fetches `/api/jira/projects` once per mount | spec:157 "fetched when the Setup page opens — never on the poll"; Task 11's test at plan:560 pins "once per Setup mount" |
| plan:510, 524 | `checked 3 s ago` / `checked 0 s ago` | spec:244 `checked 3 s ago`; `0 s` follows `pollAge` |
| plan:580, 588 | chip reads `A` for `Ada Lovelace`, `?` for `me: null` | R10 + `TrackerChip.tsx:48` |

Checklist items 1 (coverage), 5 (order) and 6 (tests) are unchanged by these hunks except where noted above; nothing in the diff adds or removes a spec
section's task, and the two new test cases (R11's `id: 7`, the multi-call long sweep) each fail before their implementation.

## Findings

### Critical
None.

### Important
None.

### Minor

- [M] plan:91, plan:169, plan:412 — three lines this diff touched now run 190, 181 and 173 columns; the plan's own convention (plan:30 "New prose wraps at
  160") applies. → rewrap those three lines.
- [M] plan:411 — `Modify: test/nav.test.tsx (~line 388 …)` sits between Step 3 and Step 4 of Task 7 instead of in Task 7's **Files** block (plan:383–391). →
  move the bullet up to Files; Step 4 already names the suite.
- [M] plan:578 — Task 9's Consumes still lists `initialsOf` (5), but after R10 (plan:63) the chip draws `me.name[0]`, not `initialsOf`; the test at plan:580 pins
  `A`, so no wrong build, only a stale interface entry. → drop `initialsOf` from Task 9's Consumes (Task 10's card keeps it).
- [M] plan:497 vs plan:502 and plan:540 — the new sentence makes `JiraSetupView` the one `/api/jira/projects` fetcher that "hands the list to the sheet and to
  Task 11's Repositories card", but `JiraBoardSheet({ board, onClose, onSaved })`'s Produces carries no projects prop and Task 11's Consumes names none; a Task 11
  implementer reading plan:547 alone ("project `Select` over `/api/jira/projects` (fetched when the Setup page mounts…)") could add a second fetch, which the
  plan:560 case ("fetched once per Setup mount") would then catch. → add the list to `JiraBoardSheet`'s Produces and to Task 11's Consumes, by whatever prop
  name the implementer picks.
- [M] plan:222 — `jest.spyOn(client, 'search')` presumes a handle on the client; the suite builds it inline today
  (`test/jira-poller.test.ts:63` `new JiraPollerService(new JiraClient(fake.fetch))`). → say "hold the client in a `let` beside `poller`" or prefer the
  `delay` hook on `FakeJira` the same line already offers.
