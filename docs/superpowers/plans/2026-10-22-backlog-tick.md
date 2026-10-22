# backlog-tick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **How to read this plan.** It specifies behaviour, signatures, exact values and exact test *cases* — never literal function bodies or test scaffolding. That
> overrides writing-plans' "code blocks required" rule on purpose (global CLAUDE.md, Learnings): handed code gets transcribed, and a bug in the plan becomes a
> bug in the branch. Where the code you find disagrees with a fact stated here, the code wins — do the right thing and say what differed in the commit body.
> Any size target below is soft.

**Goal:** A `backlog-tick` skill a dashboard schedule fires per repo: each tick checks the project is idle, then does at most one unit of work — execute one
ready item into a PR, or groom one item into a plan the user must approve by removing a `plan-review` mark.

**Architecture:** A deterministic CLI, `skills/backlog-tick/tools/tick.mjs` (`decide` / `record` / `status` / `forget`), makes every decision and prints one
JSON verdict; the skill only acts on it through the Skill tool (`backlog-execute … --finish pr` or `backlog-groom …`) and records the outcome. A new
`plan-review` gate — a frontmatter line on files projects, an eleventh label on tracker projects — is read by every execute gate (orchestrate's queue, the
board's dispatch ladders, execute's refusal gate, the tick itself).

**Tech Stack:** Node ESM skill CLIs (`node --test`), NestJS server, React client (jest + jsdom), GitHub via the existing tracker module.

**Spec:** `docs/superpowers/specs/2026-10-22-backlog-tick-design.md` (reviews in `docs/superpowers/reviews/2026-10-22-backlog-tick-design-review-{1,2}.md`)

## Global Constraints

- Skill name `backlog-tick`, trigger `/backlog-tick`, directory `skills/backlog-tick/` — never under `.claude/skills/`.
- Tool `skills/backlog-tick/tools/tick.mjs`; state under `~/.backlog-manager/tick/<project-key>/` (`lock`, `state.json`), overridable by `BM_TICK_HOME`.
  Project key = `encodeURIComponent(<absolute main-checkout path>)`, the same key `orchestrate.mjs`'s `projectDir` uses.
- Trigger flags: `--max-prs M` (default 2), `--max-plans N` (default 3), `--base <ref>`, `--lock-ttl <minutes>` (default 180), `--dry-run`.
- Tick marker text: `[backlog-tick]`, appended after the id. Groom prompts are exactly `<id>, plan the fix [backlog-tick]` (bug) and
  `<id>, promote it to a task [backlog-tick]` (refactor). Execute args are exactly `<id> --finish pr [backlog-tick]`, or `<id> --finish pr --base <ref>
  [backlog-tick]` when the tick was given `--base`.
- The plan-review reason string, everywhere it is shown: `this plan awaits review`.
- Label name `plan-review`; description `A plan written unattended — remove this label to approve it for execution`; colour is the builder's (one not
  already in `TRACKER_LABELS`).
- Files frontmatter line `plan-review: true`. Read by *presence*, exactly as `runner-fix:` is: any value but `false` (trimmed, case-insensitive) counts.
- Open execute PRs: `gh pr list --state open --limit 500 --json headRefName`, counting `headRefName` starting with `execute/`. A non-zero exit, a missing
  `gh`, unparseable output, or 500 results → execute capped with reason `cannot count open PRs`.
- A tick never merges, never commits a groom, never promotes an idea, never rejects, never asks a question, never runs anything in the background.
- `tick.mjs` imports nothing from another skill's `tools/` and nothing from `server/` or `shared/`. Every function it needs that exists elsewhere is a
  **twin**, with a comment naming each original (the `skills/backlog-retro/tools/lib/paths.mjs` pattern). It does not shell out to `orchestrate.mjs` or
  `backlog.mjs` either: a prune of one skill must never break another.
- Every skill CLI ends with `process.exitCode = main(...)` (or the awaited form), never `process.exit(main(...))`.
- Node tests sit flat in `skills/backlog-tick/tools/*.test.mjs` — the `test:skills` glob does not descend into `tools/lib/`.
- New text wraps at 160 columns; commit bodies at 72. Match the surrounding comment density (long *why* comments are the house style).

## Review Focus

1. **Two ticks fire at the same moment on one project** (a double-fired schedule, or a hand `/backlog-tick` beside the scheduled one) → exactly one gets the
   lock; the other prints `busy: another tick`. Pinned in Task 8 (`two decides racing for one lock`).
2. **A files plan whose `plan-review` line was deleted in the working tree but not committed** → still not an execute candidate (step 3 reads `<base>`); the
   same item still counts toward the N cap only if the line is in the working tree. Pinned in Task 8 (`uncommitted approval is not an approval`).
3. **`gh` present but failing** (unauthenticated, non-zero exit, 500 results) → execute capped with `cannot count open PRs`, and the groom branch still runs.
   Pinned in Task 8 (`gh failure caps execute but not groom`).
4. **A failed item whose only change is start/stop bookkeeping** (`updated:`, `started:`, `phase:`, `groomed-at:`, `*-elapsed:`, `*-tokens:`) → still
   skipped; a one-character body edit → eligible again. Pinned in Task 7 (`bookkeeping keys never move the hash`).
5. **A files project with the stack down** → the tick never needs the API: the starting-run check is skipped and the tick still reaches a verdict. Pinned in
   Task 8 (`files project decides with the stack down`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/src/tracker/labels.ts` | `PLAN_REVIEW_LABEL` constant and the eleventh `TRACKER_LABELS` entry |
| `server/src/tracker/map-issue.ts` | `planReview` flag on a mapped tracker item; label consumed out of `tags` |
| `shared/types.ts` | `BacklogItem.planReview?: true`; `planReview?: boolean` on the create and body request shapes; `ItemPlanReviewRequest` |
| `server/src/items/sources/source.ts`, `github.source.ts` | `planReview(...)` writer method; `planReview` on create and patchBody |
| `server/src/items/items-write.controller.ts` | `POST /api/items/plan-review`; `planReview` validated on `create` and `body` |
| `skills/backlog/tools/backlog.mjs` | `plan-review <id> on\|off` verb; `--plan-review` on `new` and `body` (tracker only) |
| `server/src/items/scan.util.ts` | `planReview` parsed from a files item's frontmatter |
| `shared/agent.ts` | `PLAN_REVIEW_REASON`, `planReviewBlock(item)` |
| `server/src/agents/agents.service.ts`, `client/src/components/board/DispatchButton.tsx` | the new rung in both dispatch ladders |
| `skills/backlog-orchestrate/tools/orchestrate.mjs` | queue gates a `plan-review` item out, both sources; hand-kept reason copy |
| `skills/backlog-groom/SKILL.md`, `skills/backlog-execute/SKILL.md` (+ `references/`) | the `[backlog-tick]` marker; execute refuses `plan-review` |
| `skills/backlog-tick/tools/tick-lib.mjs` | twins and pure readers: homes, project source, frontmatter, `deriveGroomed`, item listing and ordering |
| `skills/backlog-tick/tools/tick-state.mjs` | lock, `state.json`, content hash — the directory's one writer |
| `skills/backlog-tick/tools/tick.mjs` | the CLI: `decide`, `record`, `status`, `forget` |
| `skills/backlog-tick/SKILL.md` | the skill: run `decide`, act, `record`, one-paragraph report |
| `CLAUDE.md`, `.claude/rules/*.md`, `docs/subsystems/*.md`, `docs/overview.md`, `skills/backlog/SKILL.md`, `.claude-plugin/plugin.json` | counts, Layout, invariants |

---

### Task 1: The `plan-review` tracker label and the `planReview` item flag

**Files:**
- Modify: `server/src/tracker/labels.ts:67-88` (constant beside `IN_REVIEW_LABEL`, eleventh entry last, header comment "ten" → "eleven")
- Modify: `server/src/tracker/map-issue.ts:147-162,247-254`
- Modify: `shared/types.ts:318-324` (beside `inReview`)
- Test: `test/tracker-labels.test.ts`, `test/tracker-map.test.ts`

**Interfaces:**
- Produces: `export const PLAN_REVIEW_LABEL = 'plan-review'` (labels.ts); `BacklogItem.planReview?: true` — `true` or absent, never `false`, by the same rule
  and the same conditional spread as `inReview`. Every later task reads the flag by this name. Unlike `inReview`, it has two writers — `map-issue.ts` here
  and `scan.util.ts` for files (Task 4) — and its doc comment says so.

- [ ] **Step 1: Write the failing tests**
  - `tracker-labels.test.ts`: rename `describe('the ten labels')` → `describe('the eleven labels')`; `toHaveLength(10)` → `toHaveLength(11)`; new case
    `the last label is plan-review, after in-review`: `TRACKER_LABELS.at(-1).name === 'plan-review'` and `TRACKER_LABELS.at(-2).name === 'in-review'`,
    `PLAN_REVIEW_LABEL === 'plan-review'`.
  - `tracker-map.test.ts`, three cases: an issue labelled `plan-review` maps with `planReview: true`; an unlabelled issue has no `planReview` key at all
    (`'planReview' in item === false`); `plan-review` never appears in `tags`. Use an issue carrying both `in-review` and `plan-review` for the first case
    and assert both flags, so a swapped mapping fails.
- [ ] **Step 2: Run** `pnpm run test:jest -- tracker-labels tracker-map` — expect the new cases to FAIL.
- [ ] **Step 3: Implement** the constant, the entry, the type and the mapping (`names.includes(PLAN_REVIEW_LABEL)`, consumed in the `tags` filter, spread like
  `queued`). Extend the "All six are CONSUMED" comment's count.
- [ ] **Step 4: Run** the same command plus `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(tracker): plan-review label and planReview item flag`.

### Task 2: The `plan-review` write route and the `planReview` flag on create/body

**Files:**
- Modify: `shared/types.ts:2494` (create request), `:2683` (body request), new `ItemPlanReviewRequest` beside `ItemReviewRequest`
- Modify: `server/src/items/sources/source.ts:227-230`, `server/src/items/sources/github.source.ts:243,828-858,922-945`
- Modify: `server/src/items/items-write.controller.ts:80-120,209-227,267-282` (+ the file header's route count)
- Test: `test/tracker-write.test.ts`

**Interfaces:**
- Consumes: `PLAN_REVIEW_LABEL` (Task 1).
- Produces: `POST /api/items/plan-review` with body `{ project: string, id: string, planReview: boolean }` → `{ id: string, planReview: boolean }`;
  `ItemWriter.planReview(project, marker, req: ItemPlanReviewRequest): Promise<WriteOutcome<{ id: string; planReview: boolean }>>`; `planReview?: boolean`
  accepted on `POST /api/items/create` and `POST /api/items/body`.

Semantics mirror the neighbours exactly: the new route copies `review` (guards, per-item serialisation, refusal for a `files` project, `planReview` must be a
literal boolean else 400 `planReview must be a boolean`); the create/body flag copies `runnerFix` (body: `true` adds the label, `false` removes it, absent
leaves it; non-boolean → 400 `planReview must be a boolean`; create: `planReview === true` adds the label at creation). Any non-tracker `ItemWriter`
implementation gets the same refusal its `review` has.

- [ ] **Step 1: Write the failing tests** in `tracker-write.test.ts`, beside the `review` cases, copying their fixture style:
  - `plan-review on adds the label` / `plan-review off removes it` — assert the GitHub call made (label add / label delete on that issue number) and the
    answer `{ id, planReview }`.
  - `plan-review refuses a non-boolean` — `planReview: 'true'` → 400 with `planReview must be a boolean`, and no GitHub call.
  - `plan-review is refused for a files project` — same status and sentence the `review` refusal case asserts.
  - `body with planReview true adds the label in the same write`, `body with planReview false removes it`, `body without planReview leaves labels alone`.
  - `create with planReview true creates the issue already labelled plan-review` — the label is in the create call's labels, not a second request.
- [ ] **Step 2: Run** `pnpm run test:jest -- tracker-write` — FAIL.
- [ ] **Step 3: Implement** types, writer method, create/patchBody handling, controller route and validation; update the controller header's route count.
- [ ] **Step 4: Run** `pnpm run test:jest -- tracker-write tracker-origin` and `pnpm run typecheck` — PASS. (`tracker-origin` covers the guard on every
  route; if it enumerates routes, add `plan-review` there.)
- [ ] **Step 5: Commit** `feat(items): plan-review write route and planReview on create/body`.

### Task 3: `backlog.mjs plan-review` and `--plan-review`

**Files:**
- Modify: `skills/backlog/tools/backlog.mjs:2187-2240` (usage strings), `:2308-2381` (`new` flags), `:3029-3131` (`body` flags), new verb beside `review`
  (`:3655-3685`), and the help/command list that names `review`
- Test: `skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: `POST /api/items/plan-review`, `planReview` on create/body (Task 2).
- Produces: `backlog.mjs plan-review <id> on|off` (tracker only); `--plan-review` on `new` (tracker call shape) and on `body`. Groom (Task 6) and the user use
  these.

Behaviour: the verb copies `review` line for line — usage `usage: backlog.mjs plan-review <id> on|off`, checked before `requireStore`; a files project →
exit 1 with `plan-review is for tracker projects: in a files project the mark is a \`plan-review: true\` frontmatter line — delete it and commit to approve`;
success prints `gh:<repo><id> awaiting plan review` / `gh:<repo><id> plan approved`; stack down → exit 5. `--plan-review` on `new`/`body` sends
`planReview: true`; in files mode it is refused the way `--runner-fix` is, with `--plan-review is a tracker flag: in a files project the mark is a
\`plan-review: true\` frontmatter line, written into the item file`. No `--no-plan-review`: approval is the verb's `off`.

- [ ] **Step 1: Write the failing tests**, beside the `review` and `--runner-fix` cases, using the same fake-API harness:
  - `plan-review on posts planReview true` (assert route `/api/items/plan-review`, payload `{ project, id, planReview: true }`, stdout line, exit 0);
    `plan-review off posts planReview false`.
  - `plan-review with a bad state prints usage and makes no request` (`plan-review #3 maybe` → exit 1, usage on stderr, zero requests).
  - `plan-review in a files project is refused` (exit 1, the sentence above).
  - `body --plan-review sends planReview true`; `new … --plan-review sends planReview true`; `--plan-review in files mode is refused` (exact sentence).
- [ ] **Step 2: Run** `node --test skills/backlog/tools/backlog.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `feat(backlog): plan-review verb and --plan-review flag`.

### Task 4: Files `planReview`, and the dispatch ladders' new rung

**Files:**
- Modify: `server/src/items/scan.util.ts:60-95` (beside the other frontmatter fields)
- Modify: `shared/agent.ts:477-494` (beside `IN_REVIEW_REASON` / `inReviewBlock`)
- Modify: `server/src/agents/agents.service.ts:23,418-421,500-504`
- Modify: `client/src/components/board/DispatchButton.tsx:1,45,170-172`
- Test: `test/items.test.ts`, `test/agents-shared.test.ts`, `test/tracker-dispatch.test.ts`, `test/agents-dispatch.test.ts`, `test/dispatch-button.test.tsx`

**Interfaces:**
- Consumes: `BacklogItem.planReview` (Task 1).
- Produces: `export const PLAN_REVIEW_REASON = 'this plan awaits review'`; `export function planReviewBlock(item: BacklogItem): string | null`.

Behaviour: scan sets `planReview: true` for a files item whose frontmatter has `plan-review` with any value but `false` (presence, like `runner-fix:`), and
omits the key otherwise. The board reads the **working tree** here, deliberately — a line deleted but not yet committed still disables Run, the conservative
direction (the tick and orchestrate read `<base>`). Ladder order: `inReviewBlock` then `planReviewBlock`, in all three places (`agents.service.ts:421`, the
re-check at `:503`, `DispatchButton.tsx:172`).

- [ ] **Step 1: Write the failing tests**
  - `items.test.ts`: `plan-review: true` → `planReview: true`; `plan-review: yes` → `true`; `plan-review: false` → key absent; no line → key absent.
  - `agents-shared.test.ts`: `planReviewBlock({ planReview: true })` → `'this plan awaits review'`; absent → `null`.
  - `tracker-dispatch.test.ts`, beside the in-review pair at `:257-265`: a `plan-review`-labelled issue → `/api/agents/plan` answers `blocked: 'this plan
    awaits review'`, `/api/agents/dispatch` 409s with it and spawns nothing; an issue with both labels → the **in-review** reason (order pinned).
  - `agents-dispatch.test.ts`: a files item whose fixture frontmatter has `plan-review: true` → dispatch 409 with `this plan awaits review` — the one
    end-to-end proof of the `scan.util.ts` read.
  - `dispatch-button.test.tsx`: a `planReview` item renders Run disabled with the reason as its title/tooltip, the way the in-review case asserts.
- [ ] **Step 2: Run** `pnpm run test:jest -- items agents-shared tracker-dispatch agents-dispatch dispatch-button` — FAIL.
- [ ] **Step 3: Implement**; extend `DispatchButton.tsx`'s header comment (line ~45) to name the new rung and its DESIGN.md subsection as the in-review one does.
- [ ] **Step 4: Run** the same plus `pnpm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(agents): plan-review blocks dispatch on board and server`.

### Task 5: Orchestrate's queue honours `plan-review` on both sources

**Files:**
- Modify: `skills/backlog-orchestrate/tools/orchestrate.mjs:1292-1355` (`parseItemForGate`, and `readItemForGate` if it has its own parse), `:1700-1735`
  (`gateEntry`), `:2016-2036` (tracker candidates, `inReviewGate`)
- Test: `skills/backlog-orchestrate/tools/orchestrate.test.mjs` (beside the in-review block at ~7587)

**Interfaces:**
- Consumes: tracker item field `planReview` (Task 1); frontmatter `plan-review:` (presence rule).
- Produces: a hand-kept `const PLAN_REVIEW_REASON = 'this plan awaits review'` with a comment naming its twin in `shared/agent.ts`; `planReviewGate(flag,
  verdict)` mirroring `inReviewGate` (gate `ungroomed`, reason prepended, `questions: []`, membership untouched).

Behaviour: `parseItemForGate` returns `planReview: boolean` read off the same bytes as `runnerFix` (so the files path reads it **at `<base>`**, and an
uncommitted item stays the existing `not committed on <base>` verdict). Both files branches of `gateEntry` and the tracker map apply the gate. When an item
carries both marks the reasons read `[IN_REVIEW_REASON, PLAN_REVIEW_REASON, …]`.

- [ ] **Step 1: Write the failing tests**
  - `plan on a files project gates a plan-review item out of the ready queue` — a groomed task committed on base with `plan-review: true` →
    `gate: 'ungroomed'`, `reasons[0] === 'this plan awaits review'`; a sibling task without it stays `ready`.
  - `plan reads plan-review at base, not the working tree` — line committed, then deleted only in the working tree → still gated; line absent at base but
    added in the working tree → `ready`.
  - `plan on a tracker project gates a planReview issue` — `apiItem(project, 3, { planReview: true })` gated with the reason first; `apiItem(project, 4)`
    ready.
  - `in-review and plan-review together list both reasons, in-review first`.
  - The twin guard lives in jest, beside the in-review one at `test/agents-shared.test.ts:826-838`: add `is the same sentence the orchestrator gate carries
    by hand` for `const PLAN_REVIEW_REASON = '${PLAN_REVIEW_REASON}';` in `orchestrate.mjs`. Run it with `pnpm run test:jest -- agents-shared` in Step 4.
    (Its SKILL.md sibling belongs to Task 6, so no commit carries a red test.)
- [ ] **Step 2: Run** `node --test skills/backlog-orchestrate/tools/orchestrate.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `pnpm run test:jest -- agents-shared` — PASS.
- [ ] **Step 5: Commit** `feat(orchestrate): queue gates out plan-review items`.

### Task 6: The `[backlog-tick]` marker in groom and execute

**Files:**
- Modify: `skills/backlog-groom/SKILL.md` (the `runner-fix` flag paragraph at ~76-85, the verdicts section, the files-promote frontmatter carve-out)
- Modify: `skills/backlog-execute/SKILL.md` (marker reading at ~20, refusal gate at ~144-165), `skills/backlog-execute/references/pr-mode.md` if the story
  needs it
- Test: `test/skill-plugin-root.test.ts`, `test/skills-plugin-root.test.ts` (existing guards — must stay green)

Per the "one statement in SKILL.md, story in `references/`" invariant: each SKILL.md gains **one** short marker paragraph; anything longer goes into a
`references/backlog-tick.md` beside it (create `skills/backlog-groom/references/` if needed).

Groom, under `[backlog-tick]` anywhere after the id:
- Only two verdicts: plan a bug's fix, or promote a refactor to a task. Never reject, never out-of-scope, never promote an idea.
- Never ask. Do not invoke `superpowers:brainstorming` or `superpowers:writing-plans`; settle open questions inline and list each, with the answer chosen,
  under a `## Assumptions (unattended)` heading in the plan.
- Write the mark **in the same write as the plan**: files — `plan-review: true` in the frontmatter (bug: its own file; promote: the new task's printed
  frontmatter block, carved out the way `runner-fix: true` already is); tracker — `--plan-review` on the `body` call (bug) or on `new` (promote).
- Cannot find a bug's cause with confidence, or the item should be rejected → write no verdict, run its own `stop` as usual, end with one line starting
  `failed:` and the reason.
- Never take over another session's `started:` marker on a files project.

Execute:
- Refusal gate, either source, either finish mode: refuse an item carrying the mark — files `plan-review:` with any value but `false`; tracker `show <id>
  --json` with `"planReview":true` — with `this plan awaits review`.
- Under `[backlog-tick]`: the `pr` finish exactly as typed, never ask, never override, never background; a stop ends with one line starting `failed:` and
  the reason; success ends with the PR URL on its own line.
- `[backlog-tick]` is not `[orchestrator-run`: execute owns its git here.

- [ ] **Step 1: Edit** both SKILL.md files (and references) as above; every command path written as `${CLAUDE_PLUGIN_ROOT}/skills/...`.
- [ ] **Step 2: Add** to `test/agents-shared.test.ts`, beside `:836-838`, `is the same sentence backlog-execute refuses with` for `PLAN_REVIEW_REASON`
  against `skills/backlog-execute/SKILL.md` (whitespace-collapsed, as the sibling does). Run `pnpm run test:jest -- skill-plugin-root skills-plugin-root
  agents-shared` — PASS.
- [ ] **Step 3: Commit** `feat(skills): [backlog-tick] marker in groom and execute; execute refuses plan-review`.

### Task 7: `tick-lib.mjs` and `tick-state.mjs`

**Files:**
- Create: `skills/backlog-tick/tools/tick-lib.mjs`, `skills/backlog-tick/tools/tick-state.mjs`
- Test: `skills/backlog-tick/tools/tick-lib.test.mjs`, `skills/backlog-tick/tools/tick-state.test.mjs`

**Interfaces (Produces — Task 8 uses exactly these names):**

`tick-lib.mjs` — pure or read-only; every twin's comment names its originals:
- `tickHome(): string` — `BM_TICK_HOME` or `~/.backlog-manager/tick`.
- `orchHome(): string` — twin of `orchestrate.mjs:267`. `projectDir(root: string, project: string): string` — twin of `orchestrate.mjs:280`.
- `apiBase(): string` — `http://127.0.0.1:${BM_API_PORT || 4322}`, twin of `backlog.mjs`'s.
- `projectSource(root: string): 'files' | 'github' | 'unsupported'` — from `backlog/source.json` (absent → `files`).
- `readFrontmatter(text: string): { fields: Record<string, string>, body: string }` — the narrow `key: value` splitter, the shape `parseItemForGate` reads.
- `isMarked(value: string | undefined): boolean` — the presence rule (absent → false; trimmed, lowercase `false` → false; anything else → true).
- `deriveGroomed(section: 'bugs'|'tasks'|'ideas'|'refactors', body: string): boolean | null` — twin of `server/src/items/parse.util.ts`'s, including its
  `UNKNOWN` sentinel regex and section-text helper, copied byte for byte.
- `itemNumber(id: string): number` — `bug-7` → 7, `#12` → 12.
- `orderExecute(items: Array<{ id, section, runnerFix }>): same[]` — bugs by number, then tasks by number, runner-fix items hoisted to the front, stable.
- `orderGroom(items): same[]` — bugs by number, then refactors by number.

`tick-state.mjs` — the only writer under `tickHome()`; every write is tmp-file + rename:
- `type Lock = { host: string, verdict: { kind: 'execute' | 'groom', id: string }, base: string, at: string /* ISO */ }` — `base` is the resolved `<base>`
  `decide` read, so `record` and recover hash the same blob `decide` compared against.
- `lockState(dir: string, now: number, ttlMs: number): { state: 'free' } | { state: 'held', lock: Lock } | { state: 'stale', lock: Lock }` — an unreadable
  or malformed lock file reads as `stale` (with whatever fields parsed), never as free.
- `writeLock(dir: string, lock: Lock): boolean` — exclusive create (`wx`); `false` when a lock already exists. Creates `dir` as needed.
- `releaseLock(dir: string, id: string): boolean` — removes the lock only when its `verdict.id === id`; `false` otherwise (and when absent).
- `removeLock(dir: string): void` — unconditional, for a stale lock.
- `readState(dir: string): { items: Record<string, ItemRecord>, recent: RecentEntry[] }` — missing file → empty; malformed file → throws (never replaced
  silently, the `jira.json` rule).
- `type ItemRecord = { outcome: 'ok' | 'failed', kind: 'execute' | 'groom', reason: string, at: string, hash?: string }` — `hash` only on `failed`.
- `recordOutcome(dir, id, rec: ItemRecord): void` — sets `items[id]`, appends `{ at, id, kind, outcome, reason }` to `recent`, trims `recent` to the last 50.
- `forgetItem(dir, id): boolean`.
- `contentHash(text: string): string` — sha256 hex over the body plus the frontmatter lines whose key is **not** `updated`, `started`, `phase`, `groomed-at`,
  or ends in `-elapsed` / `-tokens`. Text with no frontmatter hashes as body only (the tracker case).
- `isSkipped(rec: ItemRecord | undefined, currentHash: string): boolean` — true only for `failed` with an equal hash.

- [ ] **Step 1: Write the failing tests**
  - `tick-lib.test.mjs`:
    - `deriveGroomed matches the server's` — table: bug with Cause+Fix filled → true; Fix `unknown` → false; Fix `**Unknown.** maybe X` → false; Cause empty
      → false; task with Plan → true; task without → false; idea → null; refactor → null.
    - `deriveGroomed is a byte copy of parse.util.ts` — read `server/src/items/parse.util.ts` as text and assert it contains the twin's `UNKNOWN` regex
      source verbatim.
    - `isMarked`: `undefined` → false, `'false'` → false, `' FALSE '` → false, `'true'` → true, `'yes'` → true, `''` → true.
    - `orderExecute`: input `[task-2, bug-9, task-1 (runnerFix), bug-3]` → `[task-1, bug-3, bug-9, task-2]`; tracker ids `#10`, `#2` order numerically.
    - `orderGroom`: `[ref-5, bug-4, ref-1, bug-2]` → `[bug-2, bug-4, ref-1, ref-5]`.
    - `projectSource`: no `source.json` → `files`; `{ "kind": "github", "repo": "a/b" }` → `github`; `{ "kind": "gitlab" }` → `unsupported`.
  - `tick-state.test.mjs` (every case under a fresh `BM_TICK_HOME` temp dir):
    - `writeLock is exclusive` — first call true, second false, the file still holds the first lock.
    - `lockState` — free with no file; `held` at `at + ttl - 1ms`; `stale` at `at + ttl + 1ms`; a file holding `not json` → `stale`.
    - `releaseLock only releases its own id` — lock for `bug-3`: `releaseLock(dir, 'bug-4')` → false and the file remains; `releaseLock(dir, 'bug-3')` → true.
    - `bookkeeping keys never move the hash` — base item vs the same item with changed `updated:`, `started:`, `phase:`, `groomed-at:`,
      `groom-elapsed:`, `execute-tokens:` → equal hashes; change one body character → different; change `title:` → different.
    - `recordOutcome keeps the last 50` — 55 records → `recent.length === 50`, the oldest kept is the 6th written; `items` keyed by id holds the latest.
    - `readState refuses a malformed file` — throws, and the file is untouched.
    - `isSkipped` — failed + same hash → true; failed + other hash → false; ok → false; undefined → false.
- [ ] **Step 2: Run** `node --test skills/backlog-tick/tools/tick-lib.test.mjs skills/backlog-tick/tools/tick-state.test.mjs` — FAIL (modules missing).
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** the same, then `pnpm run test:skills` once to confirm the glob picks both files up — PASS.
- [ ] **Step 5: Commit** `feat(tick): state, lock and twin readers for backlog-tick`.

### Task 8: `tick.mjs` — `decide`, `record`, `status`, `forget`

**Files:**
- Create: `skills/backlog-tick/tools/tick.mjs`
- Test: `skills/backlog-tick/tools/tick.test.mjs`

**Interfaces:**
- Consumes: everything Task 7 produces; `planReview` on API items (Task 1); `plan-review:` frontmatter (presence rule).
- Produces the CLI the skill (Task 9) calls:
  - `tick.mjs decide [--max-prs M] [--max-plans N] [--base <ref>] [--lock-ttl <minutes>] [--dry-run]` → one JSON line on stdout, exit 0 for every verdict;
    exit 1 with a usage line for a bad flag (non-integer or negative cap, unknown flag).
  - Verdict shape: `{ verdict: 'execute' | 'groom' | 'recover' | 'busy' | 'idle', reason: string, id?: string, skill?: 'backlog-execute' | 'backlog-groom',
    args?: string, stop?: boolean, caps: { openPrs: number | null, maxPrs: number, planReview: number | null, maxPlans: number }, dryRun: boolean }`.
    `args` is the exact text after the skill name (Global Constraints). `recover` carries `id` and `stop` (true → the skill runs `backlog.mjs stop <id>
    --abandon`).
  - `tick.mjs record <id> ok|failed --kind groom|execute [--reason <text>]` → writes the outcome (hash for `failed`), releases the lock if it is this id's,
    prints one line; exit 0. Exit 1 on usage error.
  - `tick.mjs status [--json]` — the lock (or `no lock`) and the last 50 outcomes, newest first.
  - `tick.mjs forget <id>` — drops the item's record, so the next tick may pick it again (the escape hatch for a failure that was the environment's fault);
    exit 1 when there was nothing to forget.

`<root>` throughout: the nearest directory at or above `path.resolve(process.cwd())` that holds a `.git` entry — a twin of `resolveProjectRoot`
(`orchestrate.mjs:762`), **never realpath'd** and never `git rev-parse --show-toplevel` (which realpaths, `/var` → `/private/var` on macOS), because the
registry `projectPath` and the run-state key are compared as raw strings everywhere in this app.

`decide`, in this order (first match wins):

1. `git rev-parse` fails → `idle`, `not a git repository`. `--git-dir` ≠ `--git-common-dir` → `idle`, `not a main checkout`. No `backlog/` → `idle`, `no backlog
   store`. `projectSource` `unsupported` → `idle`, `unsupported backlog source`.
2. Tracker: `GET /api/health` fails or times out (2 s) → `idle`, `stack down`.
3. `lockState`: `held` → `busy`, `another tick`. `stale` → **recover** (below) and return.
4. Busy, each its own reason: `run.json` under `projectDir(orchHome(), root)` with status `running`/`paused` → `orchestrator run <status>`; with the API
   reachable, a `starting` entry whose project is `root` → `orchestrator run starting`; tracker only, a `remote` entry with `fresh: true`, this repo, status
   `running`/`paused` → `remote run`; files: any open item, in the main checkout or in a linked worktree other than the spec's two skipped kinds — `<root>/.worktrees/<id>` (the orchestrator's, `<id>` an item id) and
   `<root>/.worktrees/execute-<id>` — whose `started:`
   is non-empty → `started marker on <id>` (tree path in the reason when not the main checkout); tracker: an item of this project with a `holder` whose
   `heartbeat` is younger than 15 minutes → `live claim on <id>`.
5. Execute, when `openPrs < M`: the first item of `orderExecute(open bugs + tasks)` that is groomed, unmarked (`plan-review`, `in-review`), has no branch
   `refs/heads/execute/<id>` and no `<root>/.worktrees/execute-<id>`, and `!isSkipped(record, hash)`. **Files read `<base>`**: the item's blob via `git show
   <base>:<rel path>` (absent → not a candidate), and `groomed`, `runner-fix`, `plan-review` and the hash all come off that blob. Tracker reads `GET
   /api/items` (filtered on `projectPath === <root>`, never the display name) and the hash from `GET /api/items/body`. `<base>` = `--base`, else `origin/HEAD`'s branch, else `main`. The `<id>`
   in the branch and path checks is execute's own: a files id as is (`bug-1`), a tracker id as the **bare issue number** (`#12` → `execute/12`,
   `.worktrees/execute-12`; `skills/backlog-execute/references/pr-mode.md:15`).
6. Groom, when `planReview < N`: count = open items of any section carrying the mark (files: **working tree**; tracker: API `planReview`); candidate = the
   first of `orderGroom(open bugs + refactors)` that is an ungroomed bug or a refactor, has no `started:` (files) and `!isSkipped` (files: working-tree hash).
7. Otherwise `idle`, reason joining what each step said: e.g. `nothing to do: 2 open execute PRs (cap 2); no ungroomed bug or refactor`.
8. For `execute`/`groom` without `--dry-run`: `writeLock` — `false` → `busy`, `another tick`.

**Recover** (stale lock): `recordOutcome(id, failed, kind, 'killed at timeout', hash)`; `removeLock`; `stop` = files **and** lock kind `groom` **and** the
item in the main checkout has `started:` with `phase: groom`; verdict `recover`, reason `recovered a killed <kind> on <id>`. Nothing else this tick (one unit
per tick). `--dry-run` reports the same verdict and writes nothing. A stale lock without a parseable `verdict.id` and `verdict.kind` is `removeLock` only:
nothing recorded, `stop: false`, no `id`, reason `removed an unreadable lock`.

`--dry-run`: every branch above, but no lock write, no record, no lock removal; `dryRun: true`.

Which text is hashed, wherever a hash is taken (`decide`'s skip check, `record`, recover): files `execute` → the item's blob at `<base>` — for `record`
and recover, the `base` stored in the lock, never a re-resolved default; a `record` with no lock for its id (another tick already recovered it) resolves
`<base>` as `decide` does without `--base` and says so on stderr; a blob absent at that ref hashes as the empty string — files `groom` → the
working-tree file; tracker, either kind → the issue body from `GET /api/items/body`. A Jira live session is never consulted (spec: not a busy signal).

Test harness: each case builds a temp git repo (main + optional linked worktree), sets `BM_TICK_HOME`, `BM_ORCH_HOME`, `BM_API_PORT` (a local
`http.createServer` fake serving `/api/health`, `/api/items`, `/api/items/body`, `/api/orchestrator/runs`, or no server for "stack down"), and prepends a
temp dir holding a fake `gh` script to `PATH` (prints a JSON list, or exits non-zero). Spawn `tick.mjs` with `cwd` at the repo. Copy the fake-server shape
from `orchestrate.test.mjs:7290-7380`.

- [ ] **Step 1: Write the failing tests** (exact verdict/reason asserted in each):
  - Not-a-project: a non-git dir → `idle`/`not a git repository`; a linked worktree → `not a main checkout`; a repo without `backlog/` → `no backlog store`.
  - `tracker project with the stack down is idle before any lock` — no fake server → `idle`/`stack down`, no lock file afterwards.
  - `files project decides with the stack down` — no fake server, one ready committed bug, fake `gh` returning `[]` → `execute`, `args` `bug-1 --finish pr
    [backlog-tick]`.
  - `fresh lock → busy another tick`; `idle and busy verdicts leave no lock`; `dry-run leaves no lock`.
  - `two decides racing for one lock` — spawn two concurrently on a project with one candidate: exactly one `execute`, the other `busy`/`another tick`.
  - Busy: `run.json` `running` → `orchestrator run running`; `paused` → `orchestrator run paused`; `starting` entry for this root → `orchestrator run
    starting`; tracker remote fresh `running` → `remote run`, and a remote with `fresh: false` → not busy; files `started:` in main → `started marker on
    bug-2`; `started:` in a linked worktree at `<tmp>/other` → busy naming that tree; `started:` only in `<root>/.worktrees/execute-bug-2` → not busy; only in `<root>/.worktrees/bug-2` → not busy;
    only in `<root>/.worktrees/other` → busy naming that tree;
    tracker holder with heartbeat 5 min old → `live claim on #4`, 20 min old → not busy.
  - Execute candidate:
    - `runner-fix item is picked first` (task-1 `runner-fix: true` committed, bug-1 ready → `task-1`).
    - `uncommitted approval is not an approval` — bug-1 committed with `plan-review: true`, the line deleted only in the working tree → not picked;
      verdict falls through to groom/idle.
    - `uncommitted item is not a candidate` — ready bug present only in the working tree → not picked.
    - `existing execute branch or worktree skips the item` — `refs/heads/execute/bug-1` exists → `bug-2` picked; same with only `.worktrees/execute-bug-1`.
    - Tracker `#12` with `inReview: true` skipped; `planReview: true` skipped; branch `execute/12` exists → `#12` skipped (and a branch `execute/#12`
      does not skip it).
    - `failed record with the same hash skips; an edited item is eligible again`.
    - `--base develop` → `args` `bug-1 --finish pr --base develop [backlog-tick]`, and the candidate is read from `develop`, not `main`.
    - `record hashes at the lock's base` — bug-1 differs between `main` and `develop`; `decide --base develop` → `record bug-1 failed --kind execute` →
      `decide --base develop` skips bug-1.
  - Caps: `gh` lists 2 `execute/*` heads and 1 `feature/x` with M=2 → execute capped (`openPrs: 2`), groom runs; M=3 → execute.
    `gh failure caps execute but not groom` — fake `gh` exits 1 → reason contains `cannot count open PRs`, verdict `groom`; a 500-element list → same.
  - Groom: `ungroomed bug before refactor` → `groom`, `args` `bug-4, plan the fix [backlog-tick]`; only a refactor → `ref-2, promote it to a task
    [backlog-tick]`; ideas and ungroomed tasks never picked; `plan-review` count reads the working tree — 3 uncommitted `plan-review: true` items with N=3
    → no groom, reason names the cap; N=4 → groom.
  - `nothing to do` — all caps full → `idle`, reason naming both caps.
  - Recover: stale `groom bug-3` lock + `bug-3` has `started:`/`phase: groom` → `recover`, `stop: true`, `state.json` has `bug-3` failed `killed at timeout`,
    no lock; same with `phase: execute` → `stop: false`; stale `execute bug-3` → `stop: false`; tracker stale `groom #3` → `stop: false`; `--lock-ttl 1`
    with a 2-minute-old lock → `recover`; dry-run recover writes nothing; a lock file holding `not json` → `recover`, reason `removed an unreadable lock`,
    `state.json` untouched, no lock afterwards.
  - `record` — `record bug-1 failed --kind execute --reason "tests red"` stores the hash of the `<base>` blob and releases a `bug-1` lock; `record bug-2 ok
    --kind groom` with a `bug-1` lock leaves the lock and says so on stderr; `record bug-1 failed --kind execute` with no lock at all hashes the `main`
    blob and stderr names the default base; bad outcome word → exit 1.
  - `status --json` lists newest first; `forget bug-1` → exit 0 and the next `decide` may pick it; `forget` on an unknown id → exit 1.
- [ ] **Step 2: Run** `node --test skills/backlog-tick/tools/tick.test.mjs` — FAIL.
- [ ] **Step 3: Implement** `tick.mjs`, ending in `process.exitCode = await main(process.argv.slice(2))` (or the sync form). Read-only git calls only; no
  `git` write anywhere in this file.
- [ ] **Step 4: Run** the same, then `pnpm run test:skills` — PASS.
- [ ] **Step 5: Commit** `feat(tick): decide, record, status and forget`.

### Task 9: `skills/backlog-tick/SKILL.md`

**Files:**
- Create: `skills/backlog-tick/SKILL.md`
- Modify: `test/skill-plugin-root.test.ts:29` (`toBe(7)` → `toBe(8)`), `test/skills-plugin-root.test.ts:38-40` (add `'backlog-tick'` to the `it.each` list,
  "seven" → "eight" in its comment)

Frontmatter `name: backlog-tick`, a description that says: one unattended unit of backlog work per scheduled tick, run by a dashboard job, idle-gated,
execute first then groom, never merges or asks; `Trigger: /backlog-tick`. Body, in this order:

1. Never ask, never background, never edit anything but through the two skills and the two tools named here.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/backlog-tick/tools/tick.mjs" decide <the trigger's flags>` and parse its one JSON line.
3. `idle` / `busy` → final message is the reason, done. `recover` → if `stop`, run `backlog.mjs stop <id> --abandon`; report; done.
4. `execute` / `groom` → invoke the named skill through the Skill tool with `args` exactly as printed; when it ends, decide `ok` (execute: a PR URL; groom: the
   plan written with its `plan-review` mark) or `failed` (anything else, reason = the skill's `failed:` line or a one-line summary).
5. Always run `tick.mjs record <id> ok|failed --kind <kind> [--reason …]`, even after an error — the lock is released only there.
6. Final message: one short paragraph — what was done, the PR URL or the item groomed, or why nothing was done.

Builder calls recorded in the skill (spec "Left to the builder"): a `failed` tick still ends as an ordinary result — the run log is the signal, and a push per
failed night would be noise; there is no `blocked` outcome — a failure that was the environment's fault is cleared with `tick.mjs forget <id>`.

- [ ] **Step 1: Write** the SKILL.md (target ≤ 120 lines; the story behind each rule belongs in the spec, not here), and bump the two guards above.
- [ ] **Step 2: Run** `pnpm run test:jest -- skill-plugin-root skills-plugin-root` — PASS.
- [ ] **Step 3: Try it by hand** in this repo: `node skills/backlog-tick/tools/tick.mjs decide --dry-run` prints one JSON line and leaves no lock under
  `~/.backlog-manager/tick/`.
- [ ] **Step 4: Commit** `feat(skills): backlog-tick skill`.

### Task 10: Counts, Layout and invariants

**Files:**
- Modify: `CLAUDE.md` (line 3 skill count and list; Layout `skills/` bullet — add `skills/backlog-tick/` and that `tick.mjs` owns `~/.backlog-manager/tick/`;
  line 39 "nine guarded write routes" → "ten"; lines 117/119/120 "ten" → "eleven" and the anchor; the three new invariant headlines)
- Modify: `.claude/rules/items.md:7,12,29`, `.claude/rules/tracker.md:80`, `.claude/rules/skills.md:30` (and the frontmatter-keys rule's mechanism text naming
  `plan-review:` as a non-lifecycle gate key); the three new rules' home is `.claude/rules/skills.md`, whose `paths: ["skills/**", "agents/**"]` already
  covers `skills/backlog-tick/**`
- Modify: `docs/subsystems/invariants.md:473,3076,3171,3448,3464,4067` + three new sections; `docs/subsystems/api.md:53,113`; `docs/subsystems/skills.md`
  (a `backlog-tick` section, and its line 3 "Seven skills … four CLIs"); `docs/overview.md:22`; `README.md:3` ("six backlog skills"); `skills/backlog/SKILL.md` ("a closed ten" → eleven, and the `plan-review` verb); `.claude-plugin/plugin.json`
  description
- Test: `test/claude-rules.test.ts`

New headlines (byte-equal in CLAUDE.md and the rules file; reasoning in `invariants.md`, from the spec's "Invariants this touches"):
- **`~/.backlog-manager/tick/` has exactly one writer, `tick.mjs`, and `backlog-tick` never writes the orchestrator's run-state directory.**
- **A tick does at most one unit of work, only when the project is idle, and never executes a plan that still carries `plan-review`.**
- **The only `started:` marker a tick clears is the one a killed tick left, identified by the verdict in its own stale lock.**

Renaming the "ten item-write routes" heading changes its anchor slug: `grep -rn 'the-ten-item-write-routes' .` and update every link.

- [ ] **Step 1: Run** `grep -rn -i -E '\b(nine|ten)\b' CLAUDE.md .claude/rules docs/subsystems skills/backlog/SKILL.md | grep -i -E 'route|label'` and fix each
  hit that counts item-write routes or tracker labels (the Jira route counts are not this change's).
- [ ] **Step 2: Edit** the rest of the list above.
- [ ] **Step 3: Run** `pnpm run test:jest -- claude-rules tracker-labels` and `pnpm run typecheck` — PASS.
- [ ] **Step 4: Commit** `docs: backlog-tick invariants, counts and layout`.

### Finish

- [ ] Push and let CI run the full suite (CLAUDE.md: never re-run `pnpm test` locally just before a push).
- [ ] After merge: `pnpm run plugin:sync` — `skills/` changes reach no machine before it.
- [ ] Then add the dashboard job file from the spec ("How it is triggered") in `claude-agents-dashboard` — that repo's change, not this branch's.
