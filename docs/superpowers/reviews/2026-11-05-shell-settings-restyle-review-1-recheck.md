# Review 1 recheck — Shell and Settings restyle plan (4 of 4)

Plan: `docs/superpowers/plans/2026-11-05-shell-settings-restyle.md` (working tree after the round-1 fixes). Spec:
`docs/superpowers/specs/2026-11-05-app-restyle-design.md`. Round 1: `docs/superpowers/reviews/2026-11-05-shell-settings-restyle-review-1.md`. Scope: only the
lines the recheck diff changed, each checked against the round-1 finding it targets, against the code (every cite grepped), and against the spec and the
plan's unchanged lines.

## Verdict: APPROVE WITH FIXES

The round-1 Critical is resolved: Task 4 is now the site-wide sweep only, Task 7's Jira row keeps #472's `/api/jira/boards/sweep { id }` callback with its
`off`-board semantics, and only the site-wide button answers 429. All six round-1 Importants are addressed. What remains is one contradiction the fix
introduced against an unchanged line (Task 6 :213), one test-file cite that spans cases the new route cannot join, a spec §5 deviation the plan makes
without reporting it, a Task 3 test that asserts a rail prop Task 6 adds, and a grep that lists nothing.

## Round-1 findings, one by one

| Round-1 finding | Changed lines | Resolved? |
| --- | --- | --- |
| [C] second Jira sweep path | :150-166, :168-170, :230-231, :238-245 | Yes — site-wide only; row keeps `boards/sweep`; 429 scoped to Sync now; `jira-chip.test.tsx:214,253` listed with what moves; `:101-123` cited. `off`-board override stated (#472's semantics). |
| [I] `working: undefined` has no source | :89, :95-96, :100, :110-112 | Yes — `useOrchestratorRuns.ts:109-117` in Modify, `answered` produced, hook case named. |
| [I] RF3 vs Task 3 gate | :47-49, :131-132 | Yes — RF3 rewritten to "still mounts", no-token case added (but see I4 below). |
| [I] `aria-current` | :219-220 | Yes on the changed line — section row keeps `page`, sub row keeps `true`, `rail.test.tsx:160-161,253-259,268` unchanged — but :213 still says the sub row carries `page` (I1). |
| [I] Task 10 tests pass today | :321-325 | Yes — the passing cases are marked regression, failing-first cases added (status dot, meters with `data-tone`, `this machine` tag, tiles, pill rows, four facts, 1100 px stack); `DashboardsPage.tsx:175,221-224` and `lib/dashboards.ts:233-236` verified. |
| [I] `GET /api/jira/status` | :164 | Yes — `GET /api/jira` (`jira.controller.ts:45,63-66` verified: `@Controller('api/jira')`, `@Get()`). |
| [I] `:65+` cite and Modify list | :150-152 | Yes — `:101-123`, `test/jira-write-routes.test.ts`, `docs/subsystems/jira.md:139,350` listed (both verified). The `it.each` cite is wrong, I2. |
| Minors taken: `rail-bar-style` four cases (:248), 3-calls flush note (:109-110), `readFileSync.*DESIGN` grep (:339), empty checkboxes removed | | Yes, with I5 on the grep and a cite-drift Minor on the flush note. |

## Important

**[I1] plan:213 vs plan:219-220 (Task 6) — the unchanged Header/Rows line still gives the current sub-list row `aria-current="page"`.** :213 reads "sub-list
rows are 28 px at 12.5 px, the current one a white row at 600 carrying `aria-current="page"` (was a dot)"; the changed Step 1 at :219-220 says the section
row keeps `page` and the current sub-page row keeps `aria-current="true"` (`SideRail.tsx:319-326`, `rail.test.tsx:160-161,253-259,268` unchanged). Built
from :213 the tree entries flip to `page`, `rail.test.tsx:160,253,258,268` go red and the SideRail comment is wrong — exactly the round-1 finding, now
split across two lines. → :213 reads `aria-current="true"` (kept) and "(was a dot)" refers to the white-row styling alone.

**[I2] plan:151 (Task 4) — "the new route joins the guarded-path `it.each` :86-137" spans cases a body-less route that answers 409 cannot join.**
`test/jira-write-routes.test.ts:86-116` is the guard describe (three `it.each` over the seven paths: no content type, other origin, unknown Host — all 403,
all sendable with `{}`), which the new route can join. `:118-147` is the `unconfigured` describe: its first `it.each` (:124-133) is "a malformed POST is 400
before the 503" — the plan's route reads no body (:164), so it has no 400 — and its second (:134-146) expects `503 Jira is not configured`, where the plan
answers `409 Jira is not being polled` when unconfigured (:168). → Cite `:86-116` and say the route is NOT added to the `unconfigured` describe's two
`it.each`; its own 409 case lives in `test/jira-sweep-route.test.ts` as :168 already says.

**[I3] plan:155-157 and :162-165 (Task 4) — a spec §5 deviation the plan does not report.** Spec :234 defines `POST /api/jira/sweep` with "optional
`{ boardId }`", :240 "an unknown `boardId` is a 404 `unknown board`", :241-242 a malformed body → 400, and §8 :293 repeats the 404/400 cases. The changed
lines drop the target, the 404 and the 400 ("no body read"), for a good reason (#472's `boards/sweep` is the per-board path), but plan :21 says "Where the
plan and the spec differ, the spec wins; report the difference", and neither the Task 4 block nor Task 11's override list (:336-338, which names only spec §3
overrides) records this one. → Add one sentence to the SITE-WIDE paragraph: "Deviation from spec §5 (`boardId`, 404, 400): the per-board target is #472's
`POST /api/jira/boards/sweep`; report it with the plan's deviations", and either list it under Task 11's edits or in the deviation report Task 12 produces.

**[I4] plan:131-132 (Task 3) — the no-token case asserts "the rail's GitHub count hidden", which Task 3 cannot test.** `SideRail` takes `working`,
`chipSlot`, `releases`, `provisional` today (`client/src/components/SideRail.tsx:99`); the `counts` prop is Task 6's (:209). A Task 3 suite can only assert the
provider: `enabled === true`, `data.token === false`, `needsYouCount(data) === 0`. → Drop "the rail's GitHub count hidden" from the Task 3 case; Task 6's
"GitHub … 0 → none" (:219) already pins the hidden pill.

**[I5] plan:339 (Task 11) — `grep -l 'readFileSync.*DESIGN' test/` lists nothing.** Run from the repo root it matches no file (`test/` is a directory and
the grep is not `-r`; recursive, it still matches nothing because no suite has `readFileSync` and `DESIGN` on one line). The two suites that matter are
already named on the same line, so nothing is lost, but the sentence states a fact that is false. → Drop the grep clause, or write what the suites do:
"`design-guards` and `dialog-count-docs` are the two suites that read the docs".

## Minor

- plan:50 (RF4, unchanged) vs :95-96 — `answered` "STAYS `true` when a later fetch fails", so "a tab whose runs request fails … `working` undefined" holds only
  while no request has ever succeeded. Say "has never answered (first request failed or pending)".
- plan:110-111 — "an empty `{ runs: [] }` answer": `OrchestratorRunsPayload` also carries `starting`, `remote`, `remoteStarting`
  (`test/orchestrator-hook.test.tsx:25-26` builds the full shape). Say "an empty payload".
- plan:109 — the flush note cites `board.md:151-153`; the "re-armed `intervalMs` after the LAST request of a chain settles" sentence is at
  `.claude/rules/board.md:154`.
- plan:230 — "the `now` button" — its accessible name is `Sweep <board> now` (`JiraChip.tsx:215`), which is what `jira-chip.test.tsx:211,258` query; say the
  aria-label moves from `Sweep <board> now` to `Sync <board>`.
- plan:170 — "`boards/sweep` cases (:200-216)": the describe runs :200-224 (the `%j is 400 naming id` `it.each` at :220-223 is part of it).
- plan:238-239 — `postSweep(service, target?)`: a `target` with `'jira'` is unreachable now (:240). Say "`target` is GitHub-only" or type it as an overload.
- Width: changed lines :89 (231 cols), :220 (265), :230 (171), :244 (225), :247 (177) exceed the plan's 160-column prose convention.
- plan:47-49 — RF3's `pulls.service.ts:171-178` resolves (comment :169-175, `if (token === null) return { token: false, repos: [] }` :178). ✓
- plan:150 — `poller.service.ts` (jira) `boardSaved :272` still resolves; `jira-write.controller.ts:101-123` is `sweepBoard` ✓; `jira.md:139` is the
  `boards/sweep` table row and `:350` the chip paragraph's `now` sentence ✓.

## Checklist record (changed lines only)

1. Values match the spec: `aria-current="page"` on the section row (spec :289) ✓; 409 not-armed, concurrent join, floor, Jira 429 in window (spec :292-294) ✓;
   the `boardId`/404/400 rows of spec §5 and §8 are deviated from (I3).
2. Reality: every path and line cite in the changed lines was grepped; all resolve except the `it.each` range (I2), `board.md:151-153` (Minor), `:200-216`
   (Minor) and the `readFileSync.*DESIGN` grep (I5).
3. Interfaces: `answered: boolean` spelled the same at :89, :95, :100, :110; `postSweep` signature unchanged across :238 and :292; `sweepNow()` now
   target-less in Task 4 while Task 5's `sweepNow(repo?)` keeps its own union (`unknown` stays there, correct for GitHub) ✓.
4. Tests fail first: Task 2 hook case (no `answered` today) ✓; Task 4 cases ✓; Task 6 keeps today's `'true'` assertions ✓ (I1 aside); Task 10 now has
   failing-first cases ✓; Task 3 no-token case partly untestable in its task (I4).
5. Convention: behaviour and cases, no literal code ✓; width exceeded on five changed lines (Minor).
