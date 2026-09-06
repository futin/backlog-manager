# Watchdog monitor — design

Move the watchdog's live surface — its phase, the runs it is watching and
its activity feed — out of Settings and into the Runs section, behind a
`Runs | Watchdog` mode switch, so that Settings holds configuration alone
and every live reading about orchestration lives on the one section a
person actually watches while a run is going. Nothing here changes the
server, the sweeper, the strip's crashed rendering, or the run file.

Supersedes §6.4 of `2026-09-04-orchestrator-watchdog-design.md` for the
State row and the Activity feed; that section's four knobs stay exactly
where and what they are.

## Why this exists

On 2026-09-05, with `run-20260905-113818` live and the watchdog armed on
it, the question "where can I inspect the watchdog, I thought it would be
visible on the UI" had the answer "Settings, bottom group". That answer is
correct and wrong at the same time. The watchdog design put its State row
and Activity feed into Settings because that is where its knobs went, and
the feed was described as "the answer to where do I see that it ran". But
Settings is a page a person opens to change a preference and leaves. A
5-second poll and a scrolling event list sit there unread for the whole of
a run, and the strip — the one live surface anyone does watch — says
nothing about the watchdog until a run has already crashed.

The Runs section is where orchestration is watched: the pinned live run,
its stage track, its per-item durations. The watchdog watches exactly those
runs. Putting its live view beside them, one segment click away, is the
same move `RunStrip` made when it stopped rendering a crashed run as
silence: state a fact where the person is already looking.

The second half of the change is a rule Settings should have had from the
start: **nothing in Settings is live.** Every other group there is a
preference — theme, density, default model, link base — that is read once
and acted on. A row that says "next check in 42s" and moves is a monitor,
not a setting, and it drags a poll into a page that otherwise has none.

## Non-goals

- **No server change.** `GET /api/agents/watchdog` and
  `GET /api/orchestrator/runs` are read as they are; no field is added, no
  endpoint. The monitor is a client-side join of two payloads the client
  already fetches.
- **No durable events.** `WatchdogStateService` stays in memory, capped at
  `WATCHDOG_EVENT_CAP`, lost on API restart. The monitor inherits that and
  says so in its hint. Persisting the feed would be a second writer in the
  run-state directory's neighbourhood and is out of scope on purpose.
- **No change to the strip, badges or blocks.** `isCrashed`,
  `watchdogClause`, `runClaimBlock`, `watchdogStoodDown` and the Resume
  control are untouched. The monitor reads the same functions; it does not
  replace them.
- **No fifth side-rail tab.** The watchdog is a view over runs, not a peer
  of Board or Archive. `SECTIONS` is unchanged.
- **No per-run watchdog section in `RunDetail`.** Considered (design C in
  the brainstorm) and rejected: a global activity feed inside a per-run
  pane reads oddly, and `RunDetail` is being swept by task-15 right now.
- **No knob duplication.** The four watchdog settings are edited in
  Settings and nowhere else. The monitor prints their current values and
  points at Settings; it never posts a change.

## 1. Vocabulary

- **Mode** — `RunsMode = 'runs' | 'watchdog'`, the Runs section's one
  view switch. `'runs'` is everything the section does today.
- **Monitor** — `WatchdogMonitor`, the component the `'watchdog'` mode
  renders in place of the tiles, list and detail pane.
- **Running run** — an entry of the runs payload with `status: 'running'`,
  fresh or crashed alike. This is by definition the set the sweeper is
  armed over (watchdog design §2.1), which is why the monitor's rows come
  from the runs payload and not from `WatchdogStatus.watching` — see §3.2.
- **Watched** — a running run whose `runId` appears in
  `WatchdogStatus.watching`. Nearly always every running run; the two
  lists can disagree for one poll tick, and the row says so rather than
  hiding it.

## 2. The mode switch — `RunsView.tsx`

*Superseded on 2026-09-06 by `2026-09-06-watchdog-console-design.md` §2 for
the switch's position (last in the bar, after a divider); the persistence
rule below stands.*

A segmented control in the Runs `board-bar`, before the range control,
using the identical `.runs-seg` idiom: `role="group"`,
`aria-label="View"`, two `<button>`s labelled `Runs` and `Watchdog`, each
carrying `aria-pressed` for its own membership. Test ids `runs-mode`,
`runs-mode-runs`, `runs-mode-watchdog`, matching the range control's
naming.

**It renders unconditionally.** Today the bar's tools render only when
`merged.length > 0`; the mode switch sits outside that condition, because
the sweeper has a phase to report whether or not any run has ever
finished. Range and project select keep their existing condition AND gain
`mode === 'runs'` — they scope run history, and the monitor has no history
to scope.

**Persisted, unlike range and project filter.** `usePersistedState<RunsMode>`
under `backlog-manager.runs-mode`, default `'runs'`, read through an
`isRunsMode` guard so a stored value outside the union (an older build, a
hand edit) lands on `'runs'` — the same coercion `resolveSection` applies
to the section key, for the same reason. Range and project filter are
deliberately NOT persisted, and the comment on them explains why: a saved
filter silently reopens the section scoped to whatever was last looked at.
Mode is not a filter over one corpus; it picks which of two surfaces the
section shows, the control naming the choice is always on screen, and a
person who left on Watchdog while a run was live wants to come back to
it. Section-like, so it persists like section.

**Body.** `mode === 'watchdog'` renders `<WatchdogMonitor runs={liveRuns}
onSelectRun={…} />` and nothing else below the bar. `mode === 'runs'`
renders exactly today's body, including the `no runs yet` empty state,
which belongs to runs mode alone. `liveRuns` is the array `RunsView`
already holds from `useOrchestratorRuns` — the monitor takes it as a prop
and never fetches runs itself, so switching modes adds no request.

**`onSelectRun(project, runId)`** sets mode to `'runs'` and `selected` to
that key. It is the one link between the modes: a row in the monitor is a
run in the list, and clicking it lands on that run's detail. A key that
names no row in `merged` at that moment resolves through the existing
`selectedRow` lookup exactly as a filtered-out selection does today — the
mode still switches, and the pane falls back to the default row.

## 3. `WatchdogMonitor` — `client/src/components/runs/WatchdogMonitor.tsx`

*Superseded on 2026-09-06 by `2026-09-06-watchdog-console-design.md` §3 for
the presentation (§3.1–3.4: tiles, cards, table); §3.2's join rules — rows
from the runs payload, `watching` as annotation, the skew rendered both ways
— stand.*

```ts
interface Props {
  runs: OrchestratorRunsPayload['runs'];
  onSelectRun: (project: string, runId: string) => void;
}
```

Owns `useWatchdog()` (live, the default — §4) and
`useNow(hasRows, 5_000)` for heartbeat ages. Because the monitor mounts
only in watchdog mode, the armed 5s watchdog poll now runs only while the
monitor is on screen — Settings no longer pays for it (§4, §5).

### 3.1 State

One card. First line is `stateLine(status, now)` — the function that
lives in `WatchdogGroup.tsx` today, moved to `lib/run-watchdog.ts` beside
`isCrashed`/`watchdogClause` so all three watchdog sentences the client
can print come from one module. Second line is the current config,
read-only: `check every 1m · leave alone for 10m · give up after 2`,
values through `formatSpanCompact` and a bare count, the same formatting
the Settings selects use. Third line is a hint: `Configure in Settings ›
Orchestrator watchdog.` Plain text, not a link — `SettingsView` has no
section setter to plumb, and the side rail is one click away.

`status === null` renders the one-line unavailable notice `WatchdogGroup`
renders today (`Could not reach the watchdog — <error>. …`), verbatim,
and nothing else — same reasoning: a monitor whose whole job is to
report on the watchdog must not fall back to a default that looks like a
reading. `phase === 'off'` renders the state line (`off — <reason>`) and
the config line; §3.2 then renders nothing, because there is nothing
being watched and the state line has already said why.

### 3.2 Watched runs

One row per **running run** in `runs`, in payload order — at most one
running run per project, so the list is short and the order is the
server's directory walk, not worth re-sorting. The rows come from the
runs payload,
not from `watching`, for two reasons. First, `watching` carries bare
`runId`s while the runs payload is keyed `{project, runId}` — two
projects that start a run in the same second share a `runId`
(`runs-view.test.tsx` already pins this dedupe), and a join on `runId`
alone would either drop or double a row. Second, the sweeper is armed
over precisely the set of `running` runs, so the payload IS the watched
set, one poll tick of skew aside. `watching` annotates instead of
selecting: a running run whose `runId` is absent from `watching` gains
the suffix `· not yet watched`; a `watching` id with no running run in
the payload renders a placeholder row (`run-… — not in the runs
payload`) so the disagreement is visible rather than swallowed.

A row is a `<button>` (so it is keyboard-reachable) reading, left to
right:

- `projectLabel(run.project)` — the same tail every other run surface
  prints, not `WatchdogGroup`'s private `projectBasename`, which is
  deleted with the feed it served (§5).
- `runId`.
- The active item: the first queue entry whose stage is in
  `RUN_CLAIMED_STAGES`, printed `bug-16 · dispatched`; none →
  `between items`.
- Heartbeat: `heartbeat 4s ago` from `updatedAt` against `now`.
- Verdict. `isCrashed(run)` false → `ok`. True → `crashed · ` followed by
  `watchdogClause(run.watchdog, now)` — the identical sentence the strip
  prints, so the two surfaces can never disagree about what the watchdog
  is doing for a run. An empty clause (annotation not yet made) prints
  `crashed` alone.

Click → `onSelectRun(run.project, run.runId)`. Placeholder rows are not
buttons; there is no run to select.

Empty state: no running runs and no leftover `watching` ids. `phase ===
'idle'` prints `no running run`; `phase === 'armed'` with nothing to show
is the one-tick skew case and prints `nothing running in the runs payload
yet`; `phase === 'off'` prints nothing (§3.1).

### 3.3 Activity

The list `WatchdogGroup` renders today, moved: newest first, one `<li>`
per event with `<time>` (`formatClock(at)`, `—:—` if unparsable), the
project through `projectLabel` when non-null, then `detail`. Empty copy
`nothing since the server started` is kept word for word. The hint states
the two facts a reader needs to trust the list correctly: it holds at
most `WATCHDOG_EVENT_CAP` lines, and it is the server's memory, so an API
restart empties it. `WATCHDOG_EVENT_CAP` is read from `shared/types.ts`,
not re-typed — the constant's own comment says the list is sized to it.

### 3.4 Styling

New `.watchdog-*` classes in `styles.css`'s Runs block: a card for §3.1,
a row list for §3.2 with the same tone classes `RunStrip` uses for
`ok`/crashed, and the existing `.watchdog-events` rules relocated from the
Settings block. Single column at the existing 700px breakpoint. No new
tokens.

## 4. `useWatchdog({ live })`

The hook gains one option:

```ts
useWatchdog(opts?: { live?: boolean })   // live defaults to true
```

`live: false` skips the armed-only 5s interval and nothing else: mount
fetch, focus refetch, `save()` and the error posture are unchanged.
`WatchdogGroup` passes `live: false`; the monitor takes the default. The
reason is the Settings rule above: with the State row gone, nothing in
Settings changes on a clock, so a poll there buys a redraw nobody can
see. The hook's doc comment, which today justifies the poll by the State
row's countdown, is rewritten to name the monitor instead.

## 5. Settings trim — `WatchdogGroup.tsx`

Keeps: the group title `Orchestrator watchdog · this server`, the
`status === null` unavailable notice (the knobs need `config`), and the
four rows Enabled / Check every / Leave a resumed run alone for / Give up
after, with their ladders, `ladderWithSelected`, and the post-and-redraw
save path exactly as they are.

Drops: the State row, the Activity block, `stateLine` (moved, §3.1),
`projectBasename` (superseded by `projectLabel`, §3.2), and the
`formatClock` import that only the feed used.

Adds: a leading control-less `set-row` named `Live view`, whose hint
carries the two sentences the State row's hint used to carry about the
config file living on the API host and being shared by every device,
followed by: `The sweeper's state, the runs it is watching and its
activity are on Runs › Watchdog.` One row rather than two so the group
opens with one paragraph of orientation, then knobs.

## 6. Documents

- `2026-09-04-orchestrator-watchdog-design.md` §6.4 gains a leading
  italic note: superseded on 2026-09-05 by this document for the State
  row and Activity; the knobs paragraph stands.
- `CLAUDE.md` Layout: the Runs entry gains the mode switch and
  `WatchdogMonitor`; the trailing "and an Orchestrator watchdog group
  (`WatchdogGroup.tsx`, server-side knobs and activity, …)" becomes knobs
  only, pointing at Runs for the live half. `useWatchdog` is described
  with its `live` option.
- No new invariant. The nearest existing rule — the board and the sweeper
  agree on `watchdogStoodDown` — is untouched; the monitor reads the same
  `watchdogClause` the strip does and adds no second predicate.

## 7. Testing

All jsdom suites follow the existing `@jest-environment jsdom` docblock
convention; fetches are stubbed the way `settings-watchdog.test.tsx` and
`runs-view.test.tsx` already stub them.

**`runs-view.test.tsx`** (extended):
- The mode switch renders with `Runs` pressed by default, and renders
  even for an empty runs payload where the range control does not.
- Clicking `Watchdog` hides the range and project controls, unmounts the
  tiles/list/pane and mounts the monitor; clicking `Runs` restores them
  with the previous selection intact.
- A stored `backlog-manager.runs-mode` of `watchdog` opens in watchdog
  mode; a stored `banana` opens in runs mode.
- The monitor's `onSelectRun` switches mode and selects that run.

**`watchdog-monitor.test.tsx`** (new), driving `WatchdogMonitor` with a
stubbed `GET /api/agents/watchdog` and a `runs` prop:
- Rejected fetch → the unavailable notice with the error text, no rows,
  no feed.
- `off` → `off — BM_AGENTS off` and the config line; no rows section.
- `idle`, no running runs → `no running run`.
- `armed`, one fresh running run in `watching` → one row with project
  tail, runId, `bug-16 · dispatched`, a heartbeat age computed against
  the pinned `now`, `ok`; no `not yet watched` suffix.
- `armed`, one crashed running run with a `watchdog` annotation → the
  row's verdict is `crashed · ` + `watchdogClause(annotation)`, asserted
  by calling the function, not by re-typing the sentence.
- A running run absent from `watching` → suffix `· not yet watched`.
- A `watching` id with no matching running run → a non-button
  placeholder row naming the id.
- Two projects sharing a `runId`, both running → two rows.
- Row click → `onSelectRun(project, runId)` with that row's key.
- Events render newest first with clock, project tail and detail; empty
  → `nothing since the server started`; the hint names
  `WATCHDOG_EVENT_CAP`'s value.

**`settings-watchdog.test.tsx`** (adjusted): the State row, the
countdown assertion and the three Activity tests move to the monitor
suite; new assertions that no `Activity` heading and no `armed —` text
render, that the `Live view` row names `Runs › Watchdog`, and that every
knob test (ladders, POST-and-redraw, unavailable notice) passes
unchanged.

**`watchdog-hook.test.tsx`** (extended): `useWatchdog({ live: false })`
fetches once on mount and never again while `armed` after
`WATCHDOG_POLL_MS` elapses; the default still polls; focus refetch and
`save()` behave identically under both.

**`run-watchdog.test.ts`** (extended): `stateLine`'s existing cases —
off with reason, idle with and without the resume-disabled suffix, armed
countdown and watching list — relocate here from the Settings suite.

## 8. Sequencing

`RunsView.tsx` is edited by task-15 (pending in the live run) and will be
edited by task-16 (groomed, not yet queued). This work touches the bar
and the body switch only, but it must land after task-15 merges so the
sweep's `RunsView` edits are the base, not a conflict. The delivery is a
backlog task whose Plan points at this document's implementation plan,
groomed after the current run ends and queued behind task-16 or beside
it as the user prefers.

## 9. Decisions taken, and what they cost

- **A mode switch over a collapsible strip (B) or the detail pane (C).**
  B keeps watchdog and runs on one screen but spends a bar on every Runs
  visit and fights task-16, which exists because the list is already too
  tall. C reuses the pane but plants a fake row in a runs list. A costs
  one segment click to see both; that is the whole price.
- **Rows from the runs payload, `watching` as annotation.** Costs a
  placeholder-row branch for the skew case. Buys a correct join under
  shared `runId`s and a monitor that says when the two payloads disagree.
- **Mode persisted where range is not.** Costs one localStorage key and a
  guard. Buys reopening on the monitor mid-run. The switch is always
  visible, so the "silently reopened scoped" objection to persisting
  range does not apply.
- **No link from Settings to Runs, prose only.** Plumbing a section setter
  into `SettingsView` for one sentence was judged not worth the coupling;
  the rail is one click away.
- **Events stay volatile.** Stated in the hint. A durable feed is a
  separate design if it is ever wanted.
- **`projectLabel` replaces `projectBasename`.** The Settings feed
  justified a private basename as "what every project surface prints";
  `projectLabel` is that surface's actual implementation. One copy.
