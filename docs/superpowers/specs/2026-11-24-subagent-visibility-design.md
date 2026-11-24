# Subagent visibility on the board — design (#578)

## Why

A parent session that waits on a subagent writes nothing to its own transcript, so on the board a healthy wait and a dead wait look the same. On 2026-11-19 a
`claude -p --resume` session sat silent for about 2 h, and only a hand read of `~/.claude/projects/<project>/<session>/subagents/` told three causes apart: a
foreground subagent stopped on a 429 (5-hour limit), a background subagent woken by `SendMessage` was interrupted after the parent's headless turn had ended
(nothing could wake the parent), and later a healthy foreground subagent ran 25 minutes while the parent looked stuck. Success: from the Jira session card or the
Runs item row a person can tell, without opening a transcript, which of those three is happening.

## Goals

- List a session's subagents where the board already draws that session: the Jira session card (`JiraSessionCard`) and the Runs item row (`RunDetail`).
- Per subagent: description, type, foreground or background, model, age, time since its transcript was last written, its last tool call (one line), and one
  derived state.
- A "waiting on subagent" badge on a parent that has a running foreground subagent, so a silent parent reads as waiting rather than stuck.
- An "orphan" flag on a running background subagent whose parent process is gone: nothing will wake that parent when it stops.

## Non-goals

- No phone notification for `blocked` or `killed` (a later idea, if the visibility proves useful).
- No waking the parent or auto-resuming an orphaned agent — visibility only. That would make the server spawn something, and the server never does on its own.
- No per-type thresholds (a test-running subagent can be silent for minutes; v1 accepts that `quiet` covers it and `stuck` is 20 min).
- No remote machines in v1: subagent detail is read from home's dashboard only. A remote run row or a remote session shows no subagent list.
- No change to how a session's own liveness (`processLive`, `status`) is read — that stays the dashboard row.

## Anti-goals

- The BM server reading `~/.claude` itself. Its container does not mount it, and the dashboard already owns transcript parsing (compaction replays #174, `SendMessage`
  resumes #420). A second parser would drift from the first.
- A poll that runs for every session on every board render. The detail is fetched only for a card or row the person has expanded.

## Constraints

- **The BM server cannot read transcripts.** `docker-compose.yml` mounts `~/.backlog-manager` and the project roots, never `~/.claude`. Every session fact the board
  shows today comes from claude-agents-dashboard's `/api/sessions` (`server/src/agents/dashboard-sessions.util.ts`).
- `agents/` is one of the server's four outbound-calling modules, so the new read lives there.
- Every server route is under `/api`; no Vite proxy change.
- Client pollers enter through `useRefreshing` / `useCoalescedFetch` (`.claude/rules/board.md`); derivations live in `lib/` or `shared/`, a look drawn on two
  surfaces lives in `components/ui/`, and every component cites its `.claude/DESIGN.md` subsection.

## Approaches

- **A — dashboard reports facts, BM derives state and draws it (picked).** The dashboard already parses `AgentJob[]` from the parent transcript and serves it at
  `GET /api/sessions/:id`; it gains the missing facts. BM proxies that route and derives the state in `shared/agent.ts`. Cost: two repos, the dashboard half ships
  first.
- B — mount `~/.claude/projects` read-only into the BM container and parse there. One repo, but duplicates the dashboard's parser and its liveness, and widens
  what the BM container can read to every transcript on the machine. Rejected.
- C — BM only, with today's `SessionDetail` payload (type, description, running/done, start). Cannot see a 429, a rejected tool use or an orphan — the cases this
  item exists for. Rejected.

The user picked A on 2026-11-24, with the dashboard half filed as its own item in claude-agents-dashboard's backlog (below), not planned here.

## The dashboard contract (dashboard's item; BM depends on it)

`GET /api/sessions/:id` keeps its shape and gains optional fields. BM treats every new field as optional and draws "—" for an absent one, so a BM build against an
older dashboard degrades to today's facts rather than breaking.

`AgentJob` gains:

| Field          | Type                                                                          | Source                                                                    |
| -------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `background`   | `boolean`                                                                     | `agent-<agentId>.meta.json` `requestShape === 'background'`, else the launch ack's `isAsync`; always `true` on a `resumed: true` row — a `SendMessage` resume completes by notification, like a background run, whatever the original launch was |
| `model`        | `string \| null`                                                              | meta `model` (falling back to `pickedEffortModel`)                         |
| `lastWriteAt`  | `string \| null` (ISO)                                                        | mtime of `subagents/agent-<agentId>.jsonl`; null without an `agentId` or file |
| `lastTool`     | `string \| null`                                                              | the subagent transcript's newest `tool_use`: `Name(first arg, ≤80 chars)`  |
| `endStatus`    | `'completed' \| 'failed' \| 'killed' \| 'stopped' \| null`                    | the terminal `<status>` of a background/resumed run; `'completed'` for a sync tool_result; null while running |
| `blockedReason`| `'rate-limit' \| 'rejected' \| 'interrupted' \| null`                         | classification of the subagent transcript's LAST entry, running agents only |

`blockedReason` classification of the last entry: an API error or `isApiErrorMessage` carrying 429 or "rate limit" / "usage limit" → `rate-limit`; a
`tool_result` whose text says the tool use was rejected → `rejected`; text starting `[Request interrupted` → `interrupted`. A pending permission prompt is NOT
a `blockedReason`: the dashboard's `permissionWait` is a hook-fed, per-session store that never reaches a transcript and cannot name one subagent, and it
already reaches the board as the parent's row field.

A "didn't finish before the previous session ended" notification **closes** the row on the dashboard side: `status: 'done'`, `endedAt` the notification's
time, `endStatus: 'killed'`. Today the dashboard leaves such a row `running` (only a terminal `<status>` resolves a launch), so this is a change the dashboard
item makes, not a fact BM can read off today's payload.

`SessionDetail` gains `parentLive: true | false | null`, always sent: `true` when a live process carries this session id, whether or not the dashboard holds a
handle for it and whatever its surface; `false` when the process table was read and no process carries it; `null` when the probe did not run or failed. It is
NOT the list row's `processLive`, which is `surface === 'dashboard' && !stopState && live` — absent for a session the dashboard holds a handle for, for a
terminal session, and when the probe failed — so reusing it would call every such parent dead. On the detail, an absent field means an older dashboard.

## BM's half

### Shared types and derivation (`shared/types.ts`, `shared/agent.ts`)

- `SubagentJob` mirrors the dashboard's `AgentJob` with the new fields optional; `SubagentDetail` mirrors `SessionDetail` (`agents`, `running`, `finished`,
  `parentLive?`). Hand-copied contract, like `DashboardRow` — the copy names the dashboard file it mirrors.
- `SUBAGENT_QUIET_MS = 5 * 60_000`, `SUBAGENT_STUCK_MS = 20 * 60_000`.
- `subagentState(job, nowMs): 'working' | 'quiet' | 'stuck' | 'blocked' | 'ended' | 'killed'`, in this order:
  1. `endStatus` of `failed`, `killed` or `stopped` → `killed`, whatever `status` says; else `status === 'done'` → `ended`.
  2. running with a non-null `blockedReason` → `blocked`.
  3. running, `lastWriteAt` younger than `SUBAGENT_QUIET_MS` → `working`; younger than `SUBAGENT_STUCK_MS` → `quiet`; older → `stuck`.
  4. running with `lastWriteAt` absent or null → `working`, never `startedAt` as a stand-in: today's dashboard sends no `lastWriteAt`, and a long healthy
     subagent must not read `stuck` just because BM merged first. Since-write draws `—`.
- `isOrphan(job, detail)`: `subagentState(job) is not 'ended'/'killed' && job.status === 'running' && job.background === true && detail.parentLive === false`.
  `parentLive` `null` or absent never flags: absence and a failed probe prove nothing. A `resumed` row is `background: true` (contract table), so the
  2026-11-19 incident's interrupted, `SendMessage`-woken agent under an ended headless parent is flagged.
- `waitingOnSubagent(detail): 'waiting' | 'waiting-blocked' | null`: some `running` job with `background === false` → `waiting`, and `waiting-blocked` when
  one of those is `blocked`. A job whose `background` is absent (an older dashboard) never counts, so an older dashboard draws no badge rather than a false
  one. A running foreground launch means the parent's turn is parked on that tool call, so BM needs no separate field for it. When
  `detail.parentLive === false` it returns `null`: the dashboard closes a foreground row only on its tool_result, so a killed parent leaves it `running`
  forever, and a "waiting" badge on a dead session would be false. Such a row draws its own `subagentState` (typically `stuck`) and no `orphan` tag — a
  foreground subagent runs inside the parent's process and died with it, so there is nothing left to wake.

### Server route

`GET /api/agents/sessions/:id/subagents` in `agents/` — reads home's dashboard `GET /api/sessions/:id` with the same headers, timeout style and error wording as
`dashboard-sessions.util.ts`. The id is validated with `isSessionId` (`server/src/jira/session-id.util.ts` — first character alphanumeric, so `.` and `..`
can never become a path segment), else 400 `not a session id`, and passed through `encodeURIComponent`. Agents disabled → 409 `agents are off` (the code the
other agents refusals use), checked before any fetch. Dashboard 404 → 404 `the dashboard has no transcript for this session`. A dashboard 400 or 500 →
502 `the dashboard session detail answered <status>`; a network failure or timeout → 502 through `dashboardError(e, 'the dashboard session detail', <ms>)`;
a 200 whose body carries `error: true` or no `agents` array → 502 `the dashboard session detail carried no agents`. The body is normalised field by field (unknown or
mistyped fields dropped, enums checked against their literal sets), never forwarded raw. No cache: the dashboard's own incremental cache makes the read cheap,
and a cached value here would be a sixth rendered-age cache, which the invariants forbid adding casually.

### Client

- `hooks/useSubagents(sessionId: string)` — called only by `SubagentList`, which mounts only while its disclosure is open, so the hook never sees a null id
  and needs no `armed` gate: it enters through `useRefreshing` with `intervalMs: 10_000` and `armed: true` (mount + focus + a 10 s timer — the only way
  `quiet` turns into `stuck` on screen). Collapsing unmounts it and drops its answer; re-opening fetches again and draws the loading line meanwhile. It keeps
  the last good answer across a failed refresh (as `useJiraSessions` does). One instance per open disclosure, no cap: the dashboard's read is incremental
  and cheap, and a person opens a handful at most. It joins `.claude/rules/board.md`'s list of `useRefreshing` pollers, and any source guard in `test/` that
  counts pollers or hook callers is updated in the same change.
- `lib/subagents.ts` — the formatting and the summary (copy table below).
- `components/ui/SubagentList.tsx` — the shared look, drawn only while the disclosure is open: a header line (the summary, then the badge when
  `waitingOnSubagent` is non-null), then one row per subagent in the dashboard's order (newest first), no cap. Each row: the state pill, the label, `type ·
  fg|bg · model`, the age, the since-write, the last tool, an `orphan` tag on an orphan row, and the `blockedReason` word after the pill on a blocked row.
  Cites a new `.claude/DESIGN.md` subsection, "Subagent list".
- The disclosure itself is a button labelled `Subagents`, collapsed by default, with no count: nothing is fetched while it is closed, so a closed
  disclosure has nothing to count. Goal 3's badge is therefore visible once the person opens the list, not on a closed card — accepted for v1, because a
  per-card poll on every board render is the anti-goal above.
- `JiraSessionCard` — the disclosure under the card's facts, with the card's `sessionId`. Not drawn while agents are off (the card's existing agents status).
- `RunDetail` — the same disclosure in each `run-drawer-item` (the `rows.map` under `data-testid="run-detail-items"`) whose row has a `sessionId`, only when
  the `remote` prop is false and agents are on. `DetailRow` (`client/src/lib/run-detail.ts`) gains `sessionId: string | null`, filled from the run item's
  `sessionId` by both `rowsFromArchive` and `rowsFromLive`. Ended items keep the disclosure: a finished item's subagents are the post-mortem, and a
  transcript the dashboard no longer has reads the 404 line.

#### Copy

| Case | Text |
| ---- | ---- |
| Disclosure button | `Subagents` |
| Loading, first fetch | `loading subagents…` |
| Empty list | `no subagents` |
| 404 | `the dashboard has no transcript for this session` |
| 400, 409, 502 on the first fetch | the route's `error` sentence, verbatim, in the list's place |
| Any failure after a good answer | the last good list stays, plus one line under the header: `couldn't refresh — <error sentence>` |
| Summary | `<n> subagent(s)` then ` · <k> <state>` for each state with k > 0, in the order `working, quiet, stuck, blocked, killed, ended`; e.g. `3 subagents · 1 working · 1 blocked · 1 ended`, `1 subagent · 1 stuck` |
| Badge | `waiting on subagent` / `waiting on a blocked subagent` |
| State pill words and tones | `working` live · `quiet` neutral · `stuck` warn · `blocked` bad · `killed` bad · `ended` done (`PillTone`, `client/src/components/ui/Pill.tsx`) |
| Blocked reason word | `rate limit` · `tool use rejected` · `interrupted` |
| Orphan tag | `orphan`, titled `background agent whose parent process is gone — nothing will wake the parent when it stops` |
| Label | `description`, else `type`, else `subagent` |
| `type · fg|bg · model` | `fg` for `background === false`, `bg` for `true`, the segment omitted when absent; an absent `type` or `model` is omitted, never `—` |
| Durations (age = now − `startedAt`; since-write = now − `lastWriteAt`) | under a minute `<1m`, then `3m`, `1h 12m`, `2d 4h`; absent time `—`. An ended job shows its run time (`durationMs`, else `endedAt − startedAt`) as `ran 4m` in place of age, and no since-write |
| Last tool | `lastTool` as sent (≤80 chars), absent → nothing drawn |

## Decided as the author's call (check these)

- Thresholds fixed at 5 / 20 min, constants in `shared/agent.ts`.
- `stuck` added as a state beside the issue's five, because the issue's own open question asked for a `stuck` threshold.
- Home's dashboard only; remote sessions show no list.
- Expand-to-load, 10 s poll while expanded, no server cache.
- `waiting on subagent` derived from a running foreground job instead of a new dashboard field; `waiting on a blocked subagent` when that job is blocked.
- `parentLive` as a new, always-sent `true | false | null` on the detail rather than reusing the row's `processLive?: true`.
- The route validates with `isSessionId`, answers 409 while agents are off, and treats a 200 carrying `error: true` as a 502.
- A subagent's pending permission prompt is not a `blocked` reason (the parent row's `permissionWait` already carries it).
- No count on a closed disclosure; the badge shows once it is opened.
- BM can merge before the dashboard item lands: every new field is optional, and BM's tests run against fixtures. Until then the list shows today's facts.

## Left to the builder

The disclosure's exact markup and DESIGN.md wording, the CSS, and where in `RunDetail`'s item row the disclosure sits — matched to the existing row layout.
