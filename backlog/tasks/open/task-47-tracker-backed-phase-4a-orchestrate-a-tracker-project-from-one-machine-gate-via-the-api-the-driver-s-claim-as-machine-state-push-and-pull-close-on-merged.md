---
id: task-47
title: Tracker-backed phase 4a: orchestrate a tracker project from one machine - gate via the API, the driver's claim as machine state, push and pull, close on merged
created: 2026-09-19
from: idea-12
tags: architecture, multi-machine, tracker, github, orchestrator, claim, git
---

## Goal

Phase 4a of the tracker-backed direction ([spec §7](../../../docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md)). Phase 3 (task-46) made
capture, groom, start and stop work against GitHub, and its live test ([2026-09-19 verification](../../../docs/superpowers/specs/2026-09-19-tracker-phase3-write-back-verification.md))
proved the whole single-item loop on a real repo. The orchestrator is still gated off a tracker project on both sides (`projectIsFiles` in the client,
`orchestrating a tracker project arrives in phase 4` in `AgentsService.orchestrate`). This item lifts that gate.

Visible result: **drain a tracker project's groomed queue from this machine.** Each item is claimed on its issue before its worktree exists, executed,
reviewed, verified and merged as today. The merge is pushed, and the issue is closed with the Outcome as its closing comment. A second machine draining
the same project skips what this one holds.

Phase 4 was split on 2026-09-19 (user's call). **This item is 4a, one machine orchestrating.** task-48 (4b) makes the run visible from other machines:
the server builds runs from claim comments, a remote run is read-only on the Runs page, attention becomes comments with an `@mention`, and `reconcile`
reads claims. 4b depends on the claim-state shape this item defines, so it is planned only after this one merges.

Not `runner-fix: true`. This item changes `orchestrate.mjs` and its SKILL.md, but it adds a mode rather than repairing machinery a run depends on. Every
files-project path must stay byte-for-byte what it is, and the test cases pin that. Flip the marker if you disagree; it is one frontmatter line.

## Plan

**How to read this plan.** It specifies behaviour, signatures and exact expected values. It deliberately does **not** give literal code, including for the
tests. This overrides `writing-plans`' "code blocks required" rule on purpose: handed code gets transcribed verbatim, so a defect in the plan becomes a defect
in the branch, and test scaffolding is the worst offender because it reads as boilerplate. **The `## Test cases` section is authoritative.** Implement
against its expected values, and disagree with anything here that contradicts them. Size figures are soft targets. Where this plan departs from spec §7's
wording, the departure is listed in **Decisions this plan takes**. Record what happened to each one in `## Outcome`, as task-46 did, so 4b reads it rather
than rediscovering it.

**Read before touching anything:**

- Spec §6.3 and §7 in full.
- task-46's `## Outcome`, especially "Eight deviations this branch took, for phase 4 to read".
- `docs/subsystems/invariants.md`'s tracker sections, plus "The merge happens in whichever tree holds the base…" and "All three skill CLIs exit through
  `process.exitCode`".
- `server/src/items/sources/github.source.ts`'s `claim`/`release`/`heartbeat`.
- `orchestrate.mjs`'s `buildGatedQueue`, `cmdStage`, `cmdWatch` and `itemDoneWhenCommands`.
- `skills/backlog/tools/backlog.mjs`'s API-mode request helper, which is the pattern Step 4 copies.

**The design, settled with the user on 2026-09-19.** These seven calls are fixed; the Steps implement them:

1. Split: this is 4a (one machine), and task-48 is 4b (cross-machine view).
2. **The driver owns the claim.** It claims at `stage <n> preflight`, before the worktree exists, and releases at the terminal stage. On a tracker item
   under `[orchestrator-run`, the execute child never runs `start`/`stop`/`move`.
3. `orchestrate.mjs` stays synchronous. Its HTTP goes through a helper run with `spawnSync`.
4. **A run pushes, for tracker projects only.** The order after a merge is push, then close. A rejected or classifier-denied push **parks**, never
   degrades.
5. `runner-fix` becomes a label the gate reads. `BacklogItem.runnerFix?: true` is set by the tracker mapper only.
6. Inside a run, a tracker item's id is its **bare issue number** (`31`). Bash would read `#31` as the start of a comment.
7. A resumed driver **takes over a claim that carries its own `runId`**. Only a live claim from a different run is a refusal.

### Step 1 — shared shapes

`shared/types.ts`:

- `BacklogItem.runnerFix?: true`. Optional, and set **only** by the tracker mapper, so every files fixture and payload stays byte-identical. Never
  `false`: absence is the negative.
- `ClaimRun` = `{ runId: string; startedAt: string; mergeMode: MergeMode; questionMode: QuestionMode; maxItems: number | null; base: string }`.
- `ItemClaimRequest.run?: ClaimRun`, written into `ClaimRecord.run`, the field task-46 left opaque. Type `ClaimRecord.run` as `ClaimRun` now.
  `ClaimRecord.state` stays `unknown` on the server, which never reads it in 4a.
- `ClaimState` is the object `orchestrate.mjs` pushes through `heartbeat`. It holds exactly the `RunQueueItem` fields spec §7.1 names: `stage`, `stageAt`,
  `worktree`, `branch`, `sessionId`, `fixLoops`, `verification`, `usage`, `assumptions`, `note`. Export it for 4b; nothing in 4a's server reads it.
- `ItemBodyRequest.runnerFix?: boolean`. `true` adds the label, `false` removes it, and absent leaves it alone.
- `RunQueueItem.claim?: { commentId: number }`. Present only on a tracker run's item once `preflight` has won. Optional, so an older run file reads as it
  always did.

`shared/agent.ts`: add `queueItemIs(queueId: string, item: BacklogItem): boolean`. It returns true when `queueId === item.id`, or when
`item.source === 'github'` and `` `#${queueId}` === item.id ``. `runEntryAt` switches to it. That is the only place in `shared/` that matches a queue entry
to an item. Sweep `client/src/` for any other `q.id === item.id`-shaped comparison, and route each one through the helper.

### Step 2 — server: mapper, claim `run`, same-run takeover, body `runnerFix`

- `mapIssue` already computes `runnerFix` and drops it (`map-issue.ts:144`). Put it on the item as `runnerFix: true` when the label is present, and omit it
  otherwise.
- The `claim` route accepts `run`. Validate it field by field; a malformed `run` is a 400 naming the field. Pass it to `GithubSource.claim`, which writes it
  into the new record.
- **Same-run takeover** (design call 7 above) happens inside `claim`'s existing serialised block. Before choosing the winner, drop from the live set every live claim
  whose `record.run?.runId` equals `req.run.runId`. The lowest-id rule then decides among the rest.
  - If ours wins, release each same-run claim that was dropped with `released: { reason: 'resumed', by: req.session }`. Never delete it.
  - Seed the new claim's counters from the newest claim as today. The released same-run claim is included in that, so its counters carry forward.
  - A claim without `run` (a hand `start`) is never same-run with anything.
  - Absent `req.run` behaves exactly as today.
- `body` route: `runnerFix` is validated as a boolean when present. After a successful patch, `true` adds the `runner-fix` label (idempotent), and `false`
  removes it, where a 404 counts as success, the same reasoning `release` documents for `in-progress`.

### Step 3 — `backlog.mjs`: `--runner-fix`

- `new … --runner-fix` sends `runnerFix: true` to `create`. Refused in files mode, as `--body` and `--kind` are, with its own sentence.
- `body <id> --body <file> [--runner-fix | --no-runner-fix]` sends `runnerFix`. Passing both flags is a usage error, exit `1`.
- Update `backlog-groom`'s tracker section: a groom that decides an item repairs the runner passes `--runner-fix` on its one `body` call. That is the same
  judgement the files path writes as frontmatter.

This closes task-46's carried item: the `create` route's `runnerFix` finally has a caller.

### Step 4 — `orchestrate.mjs`: source detection and the API helper

- **`tools/api-call.mjs`**, new, inside `backlog-orchestrate/tools/`, and importing nothing from another skill.
  - Input: method, path and an optional JSON body, on argv or stdin (implementer's choice; document it in the header).
  - Behaviour: exactly one `fetch` to `http://127.0.0.1:${BM_API_PORT ?? 4322}`, with `connection: close` and `content-type: application/json`.
  - Output: the parsed JSON on stdout.
  - Exit codes:
    - `0` for a 2xx.
    - `3` for a non-2xx. Stdout still carries the JSON body, and stderr the status.
    - `5` for a refused connection. Stderr names `pnpm run dev` and `pnpm run docker:up`, the same wording `backlog.mjs` uses.
  - It holds the event loop only for that one awaited request, so it ends with `process.exitCode = await main(...)`. Add it to `backlog.test.mjs`'s
    three-CLI source guard as a fourth file, with its own safety note: it is a child process, never `orchestrate.mjs` itself.
- **`apiCall(method, path, body)`** in `orchestrate.mjs` runs that helper with `spawnSync(process.execPath, …)`.
  - It returns `{ ok, status, data }` for exits `0` and `3`.
  - It throws `OrchestrateError(…, 8)` for exit `5`. **The stack being down is exit `8` everywhere in `orchestrate.mjs`, and an API refusal a command cannot
    absorb is exit `9`.** `3` and `5` are taken: `watch` and `verify` already use them (budget elapsed, nothing to verify), and SKILL.md branches on both.
    The helper's own `3`/`5` are private to the helper, and `apiCall` maps them.
  - It is the only HTTP in `orchestrate.mjs`, so `main` stays synchronous and nothing in the exit-code invariant changes.
- **`projectSource(projectRoot)`** returns `'files' | 'github'` and reads `backlog/source.json` by the same three rules `backlog.mjs` uses:
  - Absent, or `{"kind":"files"}`, gives `files`.
  - `{"kind":"github"}` with a valid repo gives `github`.
  - Anything else is exit `1` naming the marker, never a fallback.
  - Read per call, cached nowhere.
  - **In files mode no command in this tool may ever spawn the helper.** Test case O-1 pins that by making the helper unreachable.

### Step 5 — the gate: `init` and `plan` for a tracker project

In `buildGatedQueue`, when `projectSource` is `github`:

- Candidates come from `GET /api/items`, filtered to this project's registry path, `status === 'open'`, and section `bugs` or `tasks`. There is no `<base>`
  read and no "not committed on `<base>`" reason. Each queue id is the bare number, `item.id` without its `#`.
- Each candidate's body comes from `GET /api/items/body` and goes through the **unchanged** `gateItem`. `hoisted` is `item.runnerFix === true`. The ordering
  is bugs, then tasks, oldest issue number first, then the stable runner-fix partition and `--max`, exactly as for files.
- `--ids` on a tracker project accepts only `^\d+$`. `#31`, a URN or a files id is exit `1`: `tracker items are named by issue number inside a run — got
  <value>`. An id that is not an open bug or task is the existing `unknown item id` refusal.
- `init` on a tracker project runs `git -C <base tree> pull --ff-only` **before** building the queue. A non-zero exit refuses the init: exit `1`, nothing
  written, the git stderr quoted. `plan` never pulls, because it writes nothing, and git state counts.
- `init` records nothing new in `run.json`; the source is re-derived from the marker by every command. The API being down is exit `8`, with nothing written.

### Step 6 — the claim as machine state

All of this is in `orchestrate.mjs` and runs only in tracker mode.

- **`stage <n> preflight`** posts `claim` with `phase: 'execute'`, `session` set to the driver's own session identity, and `run` built from `run.json`.
  - Won: store `claim.commentId` on the queue item, then write the stage.
  - A 409 naming a different run: the item goes to `skipped` with `note: claimed elsewhere (session <s>, heartbeat <age> ago)`. Exit `0`, and the loop
    moves on. A refusal is information, not a failure.
  - Any other refusal: exit `9` with the server's error. Nothing is written.
- **Every command that changes an item's fields** (`stage`, `usage`, `verify`, `assume`, and `watch`'s tick) also calls `heartbeat` for that item with
  `state` set to the `ClaimState` built from the item as just written.
  - A failed heartbeat is **one stderr line and never a failure of the command**. `run.json` on this machine is the journal of record.
  - A claim that goes stale because the API was down for 15 min is the protocol working as designed. Record that as a known trade in the Outcome.
- **Terminal stages** (`merged`, `branched`, `failed`, `skipped` after a claim, `parked`, `ungroomed` after a claim) release with `reason: <stage>`.
  - Release carries counters. Read the newest counters through `GET /api/items/claim`, then add this run's bill for the item: `executeElapsed += ⌊Σ
    usage.durationMs / 1000⌋` and `executeTokens += Σ (inputTokens + outputTokens + cacheCreationTokens)` over every usage entry, with a `null` field
    contributing nothing.
  - That is the same set of token kinds `backlog.mjs stop` bills (`backlog.mjs:1527`). If every entry is `null`, send the read counters unchanged, never
    zeros.
  - A `parked` release leaves the issue open. So does every terminal stage but `merged`.
- **`stage <n> merged`** in tracker mode takes `--outcome <file>` (required in tracker mode, and refused in files mode). In this order it:
  1. posts `state` with `status: 'done'` and `outcome`, which is task-46's route, comment first and then close;
  2. releases the claim;
  3. writes the stage.

  If step 1 fails, **nothing is written** and the exit is `9`. The SKILL parks the item with an attention entry: "merged and pushed; issue not closed:
  `<error>` — close it by hand". A step-2 failure after a successful close is one stderr line: the issue is done, and a dangling live claim goes stale on
  its own.
- **Resume** (`--resume`): each in-flight item with a `claim` is re-claimed before anything touches it, and the same-run takeover in Step 2 makes that
  succeed. A different run's live claim moves the item to `skipped` / `claimed elsewhere`. Its worktree and branch are left in place and named in the note,
  never removed. The run did not lose them; it lost the item.

### Step 7 — execute, the outcome file, the item snapshot

- **Dispatch prompt** (SKILL.md §4), tracker items only: the `[orchestrator-run …]` marker gains `outcome <dir>/outcomes/<n>.md`, an absolute path,
  created empty by the driver. `backlog-execute`'s "Am I inside an orchestrator run?" gains a tracker bullet:
  - never run `start`, `stop`, `heartbeat`, `move` or `comment` on the item;
  - write the whole `## Outcome` (contract sweep and red proof lines included) to that path, verified or not;
  - `show <n>` stays the way to read the item.
- **§4's post-checkout probe** (`backlog.mjs show` inside the worktree) is skipped for tracker items. It asks whether a committed file reached the worktree,
  and there is none.
- **§5 inspect**: for a tracker item, "the item moved to `done/`" becomes "the outcome file is non-empty". An empty one is the same evidence as an unmoved
  file, and takes the same branch.
- **`orchestrate.mjs snapshot <n>`**, new and tracker-only, writes `<dir>/items/<n>.md`: the item's body from the API, then `## Outcome`, then the outcome
  file's contents. It runs after inspect and again after each fix loop.
  - The reviewer is handed that path where a files run hands the item file. `agents/backlog-reviewer.md` gains one sentence: in a tracker run the path is
    a snapshot under the run-state directory, not a file under `backlog/`.
  - `itemDoneWhenCommands` reads `## Done when` from the snapshot in tracker mode.
  - Files mode is unchanged. `snapshot` in files mode is exit `1`.
- `<dir>/outcomes/` and `<dir>/items/` are sidecar subdirectories. They are archived with the run by the existing denylist mover, with no change to it. Test
  I-3 pins that they ride along.

### Step 8 — merge, push, pull (SKILL.md §4 and §9)

Tracker projects only. Files runs are untouched, and a prose case pins that the files path gains no `push`.

- **Before each item's worktree**: `git -C "<base tree>" pull --ff-only origin <base>`. A failure parks the run with `attention --kind parked` naming the
  refusal: another machine pushed something this tree cannot fast-forward onto.
- **The merge commit message** carries `Fixes #<n>`: `merge --no-ff -m "Merge backlog/<n>: <title>" -m "Fixes #<n>"`. That replaces `--no-edit` for
  tracker items only.
- **After the merge, before `stage merged`**: `git -C "<base tree>" push origin <base>`.
  - Rejected (non-fast-forward): `attention --kind parked` naming it, then `stage parked`. The merge stays local, and `--resume` pulls and pushes again.
  - **Denied by the auto-mode classifier: also parked.** It never degrades to branch mode, because the merge has already landed and "branched" would be
    false. SKILL.md says this beside the existing classifier-denial rule, as the one place that rule does not apply.
  - Pushed: `stage <n> merged --outcome <dir>/outcomes/<n>.md`.
- **Branch mode**: `git push -u origin backlog/<n>`, then `stage <n> branched --branch backlog/<n>`. The issue stays open, and the branch name goes into
  the claim's state. A failed push parks, as above.
- `orchestrate.test.mjs`'s closed allowlist of `git -C "$PWD"` lines is **not** widened. Every new command is `-C "<base tree>"`, or runs inside the item
  worktree. Add both tracker push shapes and the pull to the prose cases.

### Step 9 — the lifts

- **Server**: remove `AgentsService.orchestrate`'s tracker 400. `resolveIds` learns tracker projects:
  - it accepts `#n`, the project's own URN, or bare `n`, still proven by `isItemId` except bare digits, which get their own check;
  - it proves membership against `ItemsService`'s open bugs and tasks for that project, never `scanProject`;
  - it **normalises every id to bare digits before composition**.

  The prompt therefore never carries a `#`. Re-check and rewrite CLAUDE.md's `isItemId` paragraph, whose last sentence names this exact lift.
- **Client**: `projectIsFiles` no longer gates the Orchestrate control. Delete it if nothing else reads it; its own comment says it had one job. The
  sheet's `uncommitted` column already handles `known: false`. Confirm it renders nothing for a tracker project, and add a case if none exists.
- **`base` on a tracker run** is resolved exactly as today (`resolveBase`, `assertUsableBase`). Nothing about the base is tracker-specific.

### Step 10 — docs

- `CLAUDE.md`:
  - rewrite the "A tracker project has no item files…" entry's orchestrator sentence;
  - rewrite the `isItemId` entry;
  - add to "`backlog-orchestrate` is the only skill that commits or merges": it is now also the only one that **pushes**, and only for a tracker project;
  - add a new entry for "the driver owns a tracker item's claim during a run", covering same-run takeover, terminal release and the outcome file.
- `docs/subsystems/invariants.md`: a section per new entry, carrying the reasoning from this plan's Decisions.
- `docs/subsystems/skills.md` and `api.md`: the new command and flags, and the `claim.run` and `body.runnerFix` fields.
- `.claude/rules/`: pointer lines only, if a new anchor needs one.
- Spec §7: annotate §7.1, §7.2 and §7.5–§7.6 with "landed in task-47" and each deviation. Never rewrite the original text.

### Decisions this plan takes that spec §7 does not spell out

1. **The driver's claim uses `phase: 'execute'`.** `ClaimRecord.phase` has two values, and the counters it bills are the execute pair. A run is execution.
2. **Claim `run` is a first-class field (`ClaimRecord.run`), not nested inside `state`** as §7.1's prose puts it. task-46 already reserved `run` beside
   `state`, and the takeover rule (design call 7) needs `runId` somewhere the server can read without parsing an opaque blob. `base` joins §7.1's list:
   4b cannot say where a run's work landed without it.
3. **Close happens at `stage merged`, not at the merge.** The tool cannot see the push, so the SKILL calls `stage merged` only after the push succeeds, and
   the tool's close is tied to the stage.
4. **The outcome file lives in the run-state directory, not the worktree.** In the worktree, the driver's `git add -A` would commit it into the
   project's history.
5. **The reviewer gets a snapshot file**, so its contract ("here is the item file path") is unchanged. A reviewer that queried the API would need the stack
   up and a new code path.
6. **A failed state heartbeat never fails a command.** `run.json` is the journal of record on this machine. The claim's state is a published copy, and
   4b is its first reader.
7. **Attention stays in `run.json`** in 4a. Comment-borne attention with an `@mention` is task-48's.

## Test cases

Authoritative. Server cases run under jest against `test/helpers/github.ts`'s in-memory GitHub, which already honours `since` and paginates. CLI cases
run under `node --test` against a fake API on loopback, the way `backlog.test.mjs`'s API-mode suite does. "Files fixture" means an existing
`orchestrate.test.mjs` store with no `source.json`.

### Shared (jest)

- S-1 `queueItemIs('31', { id: '#31', source: 'github' })` → `true`. `queueItemIs('31', { id: '#31', source: 'files' })` → `false`.
  `queueItemIs('task-3', { id: 'task-3', source: 'files' })` → `true`. `queueItemIs('#31', { id: '#31', source: 'github' })` → `true` (identity always
  holds).
- S-2 `runClaimBlock` for tracker item `#31`, with a fresh run in the same project holding queue id `31` at `dispatched` → `an orchestrator run is working
  this item (dispatched)`. The same run, with `project` set to another path → `null`.

### Server (jest)

- M-1 An issue labelled `type:task` and `runner-fix` maps to `runnerFix: true`. Without the label, the key is **absent**: `'runnerFix' in item` is
  `false`. A files item never carries the key: assert on the existing files fixture's whole payload.
- C-1 `claim` with a valid `run` → the posted comment's JSON carries `run` verbatim, with all six keys.
- C-2 `claim` with `run: { runId: 5 }` → 400 whose error names `run.runId`. With `run.mergeMode: 'yolo'` → 400 naming `run.mergeMode`.
- C-3 **Same-run takeover.** Session A claims #7 with `runId: r1`. Session B, which is live and not released, claims #7 with `runId: r1` → 200, with B's
  `commentId`. A's comment is edited to `released.reason: 'resumed'` and `released.by: B`, and it still exists. B's counters equal A's.
- C-4 **Different run refused.** A holds #7 with `r1`. B claims with `r2` → 409, and `holder.session === A`. B's own comment is deleted, and A's is untouched.
- C-5 **Hand claim is not same-run.** A holds #7 with no `run`. B claims with `r1` → 409.
- C-6 The spec's protocol cases stay green unchanged: two claimants and the lowest id wins; a stale claim is released and not deleted; the loser's error
  names the holder. Run `test/tracker-write.test.ts` as is.
- C-7 `claim` without `run` behaves exactly as today. The existing suite stays green with zero edits to its expectations.
- B-1 `body` with `runnerFix: true` → the body is patched and `runner-fix` added. Called again → still one label, and no error.
- B-2 `body` with `runnerFix: false` on an issue that has no `runner-fix` label → 201. The DELETE is attempted, and the 404 is swallowed. Assert the call
  was made, not only the outcome.
- B-3 `body` with `runnerFix: 'yes'` → 400.
- O-L1 `POST /api/agents/orchestrate` for a tracker project with `ids: ['#31', 'gh:futin/x#32', '33']` (all open) → spawned, and the prompt contains
  `/backlog-orchestrate 31,32,33` (whatever the current id-list spelling is) and **no `#` anywhere in the prompt**.
- O-L2 The same request with `#99`, which is not an open bug or task → 409. With `ids: ['#31; rm']` → 400.
- O-L3 A files project's orchestrate prompt is byte-identical to before. Reuse the existing prompt-composition cases unchanged.

### `backlog.mjs` (node)

- R-1 Tracker `new tasks "t" --body f --runner-fix` sends a create body with `runnerFix: true`. Without the flag, the key is absent.
- R-2 Files `new tasks "t" --runner-fix` → exit `1`, with its own sentence, and no HTTP request made.
- R-3 `body 7 --body f --no-runner-fix` sends `runnerFix: false`. `--runner-fix --no-runner-fix` together → exit `1`, and no request.

### `orchestrate.mjs` (node)

- O-1 **Files runs never touch the API.** Every existing `orchestrate.test.mjs` case passes with `BM_API_PORT` pointed at a closed port. Add one
  explicit case: `init` plus a whole stage sequence on a files fixture with the port closed → exit `0` at every step.
- O-2 `projectSource`: absent → `files`. `{"kind":"files"}` → `files`. `{"kind":"github","repo":"futin/x"}` → `github`. `{"kind":"jira"}` → exit `1`
  naming `backlog/source.json`.
- A-1 `api-call.mjs` against a closed port → exit `5`, with stderr containing `pnpm run dev` and `pnpm run docker:up`. Against a 409 → exit `3`, with the
  JSON on stdout.
- G-1 `plan` on a tracker fixture: the fake API serves #3 (a bug, groomed), #1 (a task, groomed), #2 (a task, `## Plan` empty) and #5 (a task, runner-fix,
  groomed). Queue order is `5, 3, 1, 2`. Gates are `ready, ready, ready, ungroomed`. `hoisted` is true on `5` only. No reason mentions "not committed".
- G-2 `plan --ids '#3'` → exit `1` with `tracker items are named by issue number inside a run — got #3`. `--ids 99` → `unknown item id: 99`.
- G-3 `init` on a tracker fixture whose base tree is behind an origin it cannot fast-forward to (a diverged bare remote) → exit `1`, with no `run.json`
  written.
- G-4 `init` with the API down → exit `8`, with no `run.json`. `stage 3 preflight` with the API down → exit `8`, with nothing written.
- P-1 `stage 3 preflight` → one `claim` request with `phase: 'execute'` and `run.runId` equal to the run's id. The queue item then carries
  `claim.commentId`.
- P-2 `stage 3 preflight` with the fake answering 409 plus a holder from another run → exit `0`, the item at `skipped`, and a note starting `claimed
  elsewhere (session`.
- P-3 `stage 3 dispatched --session s` → one `heartbeat` whose `state.stage === 'dispatched'` and `state.sessionId === 's'`.
- P-4 The heartbeat endpoint answering 500 → the stage command still exits `0`, `run.json` records the stage, and stderr has one line.
- P-5 `usage 3 --jsonl <fixture>` → a `heartbeat` whose `state.usage` has the new entry.
- P-6 `stage 3 merged` in tracker mode without `--outcome` → exit `1`, with nothing written.
- P-7 `stage 3 merged --outcome f` → requests in the exact order `GET claim`, `state` (`status: 'done'`, `outcome` equal to f's text), `release`
  (`reason: 'merged'`). Counters: executeElapsed is the prior value plus `⌊Σ durationMs/1000⌋`, and executeTokens is the prior value plus the sum of
  input, output and cacheCreation across the item's usage entries. The fixture has a cache-read count, and it must not appear in the sum.
- P-8 `state` answering 502 → exit `9`, the stage **not** written, and no `release` sent.
- P-9 `stage 3 branched` → `release` with `reason: 'branched'`, and **no** `state` request.
- P-10 Usage entries whose token and duration fields are all `null` → release counters equal the read counters exactly.
- P-11 **Resume takeover.** A run with item `3` at `dispatched`, carrying `claim.commentId`, is resumed under a new session → one `claim` request with the
  same `run.runId`. The new `commentId` replaces the old one on the item.
- P-12 Resume where the fake refuses with another run's holder → item `3` goes to `skipped`, with a note naming its worktree path. The worktree directory
  still exists.
- I-1 `snapshot 3` writes `<dir>/items/3.md`, containing the fake's body and then `## Outcome` and the outcome file's text. In files mode it is exit `1`.
- I-2 `verify 3` in tracker mode runs the `## Done when` commands found in the snapshot, not in any `backlog/` file.
- I-3 A tracker run archived by the next `init` moves `outcomes/` and `items/` beside the archived run file, under its `archiveStem`.

### Prose (node, in the suites that already read these files)

- W-1 Orchestrate SKILL.md contains a tracker-only `pull --ff-only`, `push origin <base>`, `push -u origin backlog/<n>` and `Fixes #<n>`. The files-path
  merge line `merge --no-ff --no-edit backlog/<id>` is unchanged. The `git -C "$PWD"` allowlist is unchanged.
- W-2 SKILL.md says a classifier-denied **push** parks and does not degrade. Assert the sentence sits in the push paragraph, not only somewhere in the
  file.
- W-3 `backlog-execute/SKILL.md`'s orchestrator section names the outcome path and forbids `start`/`stop`/`move` for a tracker item.
  `agents/backlog-reviewer.md` mentions the snapshot.
- W-4 `backlog-groom/SKILL.md`'s tracker section names `--runner-fix`.

## Done when

```
pnpm run typecheck
pnpm test
pnpm run build
```

All green. Also, without being asked, `git diff main...HEAD -- skills/backlog-orchestrate/tools/orchestrate.mjs` shows no edit to any files-mode branch
that a tracker test does not also exercise: O-1 is the proof, and the Outcome quotes it.

**A live run is a person's job, as in task-45 and task-46.** After merge, push and `pnpm run plugin:sync`, run on `futin/test-claude-issues`: two groomed
issues, one orchestrate from the board, and check that each issue has one claim comment carrying `run` and `state`, closed after a push with `Fixes #n` in
the merge commit. Then check the second machine case by hand: a claim from another `runId` makes the item `skipped`.

### What this item's Outcome must record

What happened to each Decision; every deviation, numbered, for task-48 to read; the shipped `ClaimState` shape verbatim, which 4b builds runs from;
and the known trades (a stale claim while the API is down; the dangling claim after a close whose release failed).
