# Jira skills: user-set order — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, signatures, exact values and exact test CASES — never literal implementation
> code. Write the bodies yourself; if a case here looks wrong against the spec or the code, say so rather than transcribing it.

**Goal:** let the person reorder Jira skills with ↑/↓ in Jira › Setup › Skills; the order is stored in `jira.json` and the Run menu follows it.

**Architecture:** one new config writer + parser in `server/src/jira/config.util.ts`, one new guarded route `POST /api/jira/skills/order` in
`jira-write.controller.ts`, and ↑/↓ `Chip`s on each skill row of `client/src/components/jira/JiraSkillsGroup.tsx` posting the whole distinct-id order.

**Tech Stack:** NestJS, React, jest (supertest for routes, Testing Library for the card), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-17-jira-skill-order-design.md` — read it in full; it is the source of every value below.

## Global Constraints

- Copy, verbatim from the spec:
  - 400 `ids must be an array of non-empty strings`
  - 400 `ids holds <id> twice` (`<id>` = the repeated id)
  - 409 `the skill list changed since this page loaded — reload and try again; nothing was written`
  - card fallback `the order was not saved`
  - aria-labels `Move <name> up` / `Move <name> down`
- Every route under `/api`, behind `SameOriginPostGuard`; validate (400) → `requireConfigured()` (503) → `writing()`.
- The server never writes a file when there is nothing to move, and never creates `jira.json`.
- The card draws only what `GET /api/jira` returns — no optimistic local order.
- Comments explain why at the repo's existing density; new prose wraps at 160 columns.

## Review Focus

1. A hand-edited `jira.json` holding an entry `readSkill` drops (empty name / bad id) — the reorder must still work and keep that entry after the ordered ones.
   → Task 1 test.
2. Two clicks in a row before the reload lands — the second must not act on the stale list. → Task 2 test.
3. A duplicated id in the file — the card posts each id once and both rows mirror one another. → Task 2 test.
4. A missing `jira.json` with `ids: []` — 200, and no file is created. → Task 1 test.
5. The new route reached cross-origin or without JSON content type — 403, nothing written. → Task 1 test (guard tables).

---

### Task 1: Server — `parseSkillOrder`, `writeSkillOrder`, `POST /api/jira/skills/order`

**Files:**
- Modify: `server/src/jira/config.util.ts` (parser beside `parseSkillWrite` ~:375; writer + error class beside `deleteSkill` ~:614; writers banner ~:270)
- Modify: `server/src/jira/jira-write.controller.ts` (route beside `skills/delete` ~:195; `writing()` ~:250; header ~:30)
- Modify: `server/src/jira/jira.module.ts` (header route count ~:12-15)
- Test: `test/jira/jira-config-write.test.ts` (new `describe('parseSkillOrder')`, `describe('writeSkillOrder')` after `deleteSkill` ~:423)
- Test: `test/jira/jira-write-routes.test.ts` (route tables at :98, :106, :111, :127-134, :138-146, ~:420-426; skills describe ~:236)

**Interfaces:**
- Produces: `parseSkillOrder(body: unknown): Parsed<string[]>` (the file-local `Parsed<T>` at `config.util.ts:328`, `{ ok: true; value } | { ok: false; error }` — export it if the test needs the type).
- Produces: `writeSkillOrder(ids: string[], file: string = jiraConfigFile()): void` — throws `JiraConfigUnreadableError` (existing), or the new
  `JiraSkillOrderStaleError` (name is the builder's call) when the set differs.
- Produces: route `POST /api/jira/skills/order`, body `{ ids: string[] }`, answers `{ ok: true }`.

- [ ] **Step 1: failing parser tests** (`jira-config-write.test.ts`)
  - `{ ids: ['s_00000001', 's_00000002'] }` → `{ ok: true, value: ['s_00000001','s_00000002'] }`; `{ ids: [] }` → ok, `[]`.
  - `{}`, `{ ids: 's_00000001' }`, `{ ids: [7] }`, `{ ids: [''] }`, `null` → `{ ok: false, error: 'ids must be an array of non-empty strings' }`.
  - `{ ids: ['s_00000001', 's_00000002', 's_00000001'] }` → `{ ok: false, error: 'ids holds s_00000001 twice' }`.
- [ ] **Step 2: failing writer tests** (temp file, the suite's existing helpers)
  - File `{ interval: 60, skills: [A, B, C] }` (A/B/C valid, ids `s_00000001..3`, A carrying an extra key `x: 1`), `writeSkillOrder([C, A, B].ids)` → file
    `skills` is `[C, A, B]` in that order, A still has `x: 1`, `interval` still 60.
  - Missing id (`[A, B]`) → throws the stale error; file byte-identical. Extra id (`[A, B, C, 's_0000000f']`) → same. Unknown swap (`[A, B, 's_0000000f']`) → same.
  - File `[A, BAD, B]` where `BAD = { id: 's_00000009', name: '', prompt: 'p' }` (dropped by `readSkill`) plus `{ name: 'no id' }`: `writeSkillOrder([B, A])` →
    `[B, A, BAD, {name:'no id'}]` (dropped entries after, in their original relative order). `[B, A, 's_00000009']` → stale error.
  - Duplicate raw id: `[A, B, A2]` where `A2 = { ...A, name: 'A again' }`: `writeSkillOrder([B, A])` → `[B, A, A2]`.
  - Unchanged order `[A, B, C]` → file mtime/bytes unchanged (assert the content string is identical and no write happened — e.g. write a sentinel
    formatting the writer would not produce, and assert it survives).
  - Missing file, `[]` → no throw, file still does not exist. `skills: 'oops'` with `[]` → no throw, file unchanged.
  - Unparsable file → `JiraConfigUnreadableError`, file byte-identical.
- [ ] **Step 3: run** `pnpm exec jest test/jira/jira-config-write.test.ts` — expect the new cases FAIL (not defined).
- [ ] **Step 4: implement** `parseSkillOrder`, the stale error class, and `writeSkillOrder` per spec §Design "Route" bullets: current ids = distinct ids of
  `readSkill`-accepted entries in raw order; set mismatch → stale error; same order → return without writing; else place every raw entry whose `id` equals
  each `ids[i]` (relative order kept), then every other raw entry, write via `writeJsonAtomic({ ...current, skills })`. Update the writers banner to seven.
- [ ] **Step 5: run** the same jest file — PASS.
- [ ] **Step 6: failing route tests** (`jira-write-routes.test.ts`)
  - Add `['/skills/order']` to the three 403 tables (:98, :106, :111).
  - Add `['/skills/order', { ids: 'x' }]` to the 400-before-503 table and `['/skills/order', { ids: [] }]` to the 503 table.
  - Add `['/skills/order', { ids: ['s_0123abcd'] }]` to the unparsable-file 409 table (~:420).
  - In `describe('skills')` (its `jira.json` is SHARED with earlier cases, which leave skills behind — never assume only the two you create): create two
    skills via `POST /skills`, read the full id list from `GET /api/jira`, `POST /skills/order` with that whole list reversed → 200 `{ ok: true }`, and
    `GET /api/jira`'s skill ids equal the reversed list; the whole list minus one id → 409 with body `{ error: 'the skill list changed since this page loaded — reload and try again; nothing was written' }`;
    `{ ids: [id, id] }` → 400 `{ error: 'ids holds <id> twice' }`.
- [ ] **Step 7: run** `pnpm exec jest test/jira/jira-write-routes.test.ts` — new cases FAIL (404 route).
- [ ] **Step 8: implement** the route (`@Post('skills/order')`, `@HttpCode(200)`, `@UseGuards(SameOriginPostGuard)`), parse → 400, `requireConfigured()`,
  `this.writing(() => writeSkillOrder(ids))`; map the stale error to 409 `{ error: err.message }` in `writing()` and update its doc comment ("three named
  refusals"). Update the controller and module header counts.
- [ ] **Step 9: run** both jest files, then `grep -rl "skills/delete\|writeSkill\|deleteSkill" test/` and run every hit not already run. Then
  `pnpm run typecheck`. All PASS.
- [ ] **Step 10: commit** `feat(jira): POST /api/jira/skills/order stores a user-set skill order` (git add by path).

### Task 2: Client — ↑/↓ on each skill row

**Files:**
- Modify: `client/src/components/jira/JiraSkillsGroup.tsx` (`row()` ~:110, skills map ~:133, header comment ~:30-55)
- Test: `test/jira/jira-setup.test.tsx` (fetch router ~:181-205: add `/api/jira/skills/order` → `skillsOrderAnswer`; `describe('the Skills card')` ~:1171)

**Interfaces:**
- Consumes: `POST /api/jira/skills/order` `{ ids: string[] }` → `{ ok: true }` (Task 1).

- [ ] **Step 1: failing tests** in `describe('the Skills card')`. Add `skillsOrderAnswer` defaulting to: reorder `statusAnswer.skills` by `body.ids`, answer
  `{ ok: true }`. Use a third fixture `REVIEW: JiraSkill = { id: 's_0123abcf', name: 'Review MR', prompt: '/review {key}' }`.
  - Skills `[GROOM, SUMMARISE, REVIEW]`: `Move Groom ticket up` and `Move Review MR down` disabled; the others enabled. Built-in rows have no `Move` buttons.
  - Click `Move Groom ticket down` → exactly one POST to `/api/jira/skills/order` with body `{ ids: ['s_0123abce', 's_0123abcd', 's_0123abcf'] }`; after the
    reload the drawn order is `Summarise changes, Groom ticket, Review MR`.
  - Click `Move Review MR up` on `[GROOM, SUMMARISE, REVIEW]` → body `{ ids: ['s_0123abcd', 's_0123abcf', 's_0123abce'] }` (pins the up direction).
  - Stale window: make `/api/jira`'s answer a held promise after the first move lands; every `Move …` button is disabled until it resolves, then enabled.
    A second variant: the held reload rejects / answers 500 → the arrows re-enable (via `error`).
  - Refusal: `skillsOrderAnswer` answers 409 `{ error: 'the skill list changed since this page loaded — reload and try again; nothing was written' }` → that
    sentence shows in the card's alert row; the drawn order is unchanged.
  - Network failure (fetch rejects for that URL) → alert `the order was not saved — the server did not answer`.
  - Duplicated id: skills `[GROOM, SUMMARISE, { ...GROOM, name: 'Groom again' }, REVIEW]` → click `Move Groom ticket down` posts
    `{ ids: ['s_0123abce', 's_0123abcd', 's_0123abcf'] }`; `Move Groom again up` is disabled exactly like `Move Groom ticket up`.
  - With the remove `Confirm` open on a row, that row's arrows are disabled.
- [ ] **Step 2: run** `pnpm exec jest test/jira/jira-setup.test.tsx -t "Skills card"` — new cases FAIL.
- [ ] **Step 3: implement** in `JiraSkillsGroup`: a `move(id, by: -1 | 1)` over the distinct-id list that calls the existing `write()` with
  `'/api/jira/skills/order'`, `{ ids }`, fallback `'the order was not saved'`; on a landed move store the current `data` object in state, and derive
  `stale = movedAgainst !== null && data === movedAgainst && !error` (read `error` from `useJiraContext()`); arrows are `Chip size={28} variant="flat"`
  placed before the default slot via `row()`'s trailing/leading args (builder's call how `row()` grows), disabled when `busy || stale || asking === id ||`
  first/last in the distinct list. Update the header comment's bullet list with the arrows and the stale rule.
- [ ] **Step 4: run** the same jest filter, then `grep -rl "JiraSkillsGroup\|jira-setup-skill\|useJiraContext" test/` and run each hit
  (`test/guards/design-guards.test.ts` at least). `pnpm run typecheck`. All PASS.
- [ ] **Step 5: commit** `feat(jira): reorder skills with ↑/↓ in Setup` (git add by path).

### Task 3: Docs and rule files

**Files (all Modify):** `.claude/rules/jira.md` (writers paragraph ~:14-21), `docs/subsystems/invariants.md` (the jira.json writers section ~:3760),
`docs/subsystems/jira.md` (:35, :54, :69, :140 "Six config POSTs" and the route table under it ~:146-154 — add a `/skills/order` row, :304, :667),
`docs/subsystems/invariants.md` also at :3755 ("through six routes") and :3766 ("Six writers, one contract"), `docs/subsystems/api.md` (:229 guarded-POST count), `.claude/DESIGN.md` §8.9.3 Skills paragraph (~:675).

- [ ] **Step 1:** in each, "six writers/config routes" → seven, add `writeSkillOrder` / `/skills/order`, and state its contract once in the rule file:
  reorders the whole `skills` array by the ids `readSkill` accepts, keeps every other raw entry after, writes nothing when there is nothing to move, 409
  on a stale set. DESIGN.md: the two arrows, before the default slot, disabled on the first/last skill, while busy, while a remove asks, and until the
  reload after a move lands. Docs only — do not reflow untouched prose.
- [ ] **Step 2:** `grep -rni "six writers\|six config\|six routes\|sixteen guarded\|ten POST" docs .claude CLAUDE.md server/src` — every hit either updated or genuinely about
  something else. Run `test/guards/` suites that read docs (`grep -l "invariants.md\|DESIGN.md" test/guards`).
- [ ] **Step 3: commit** `docs(jira): the seventh config writer, skills/order`.

### Task 4: `/ui-verify`

- [ ] Run `/ui-verify` against Jira › Setup › Skills with ≥3 skills (no mock — the spec's text design is the reference): arrows sit before
  `Make default`/`default`, first ↑ and last ↓ disabled, a move redraws the order, the Run ▾ menu on a card shows the new order, no overflow at the
  narrowest settings width. Fix defects on the branch.
