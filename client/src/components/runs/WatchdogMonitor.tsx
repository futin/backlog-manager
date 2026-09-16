import { useNow } from '../../hooks/useNow';
import { useWatchdog } from '../../hooks/useWatchdog';
import { projectLabel } from '../../lib/project-label';
import { formatClock, formatSpanCompact, freshnessFraction, lastReportedEntry } from '../../lib/run-time';
import { graceRemainingMs, isCrashed, stateLine, sweepFraction, watchdogClause, WATCHDOG_KIND_GLYPH, WATCHDOG_KIND_TONE } from '../../lib/run-watchdog';
import { RunControls } from '../RunControls';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { Dot } from '../ui/Dot';
import { Figure, FigureStrip } from '../ui/Figure';
import { Ledger } from '../ui/Ledger';
import { ProgressRow } from '../ui/ProgressRow';
import { Sheet, SheetHead } from '../ui/Sheet';
import { RUN_STALE_MS, WATCHDOG_EVENT_CAP } from '../../../../shared/types';
import type { OrchestratorRunsPayload, RunWatchdog } from '../../../../shared/types';

/**
 * Runs › Watchdog (task-18, spec §3) — the sweeper's live surface: what
 * phase it is in, which runs it is watching, and what it has actually done.
 *
 * It exists here rather than in Settings because of a real morning: with
 * `run-20260905-113818` live and the watchdog armed on it, "where can I
 * inspect the watchdog?" answered "Settings, bottom group" — a 5s-polling
 * State row and a scrolling event list sitting on a preferences page nobody
 * has open during a run, while the one surface a person DOES watch said
 * nothing about the sweeper until a run had already crashed. The move also
 * buys Settings a rule it should have had from the start: nothing there is
 * live.
 *
 * Two payloads, joined here and nowhere else. `useWatchdog()` (live — this
 * component is the reason that poll exists at all, and it mounts only in
 * watchdog mode, so the poll now runs exactly while someone is looking at
 * it) and the live runs array `RunsView` already holds, handed down as a
 * prop rather than fetched again: switching modes must add no request.
 *
 * ROWS COME FROM THE RUNS PAYLOAD; `watching` only ANNOTATES. Two reasons,
 * and the first is not hypothetical — `runs-view.test.tsx` already pins a
 * case where two projects share a `runId`, because a run id is a timestamp
 * and two projects starting a run in the same second collide. `watching`
 * carries bare `runId`s while the runs payload is keyed `{project, runId}`,
 * so a join on the id alone would either drop a row or double one. Second,
 * the sweeper is armed over precisely the set of `running` runs
 * (`watchdog.service.ts`), so the payload IS the watched set, one poll tick
 * of skew aside. That skew is rendered rather than hidden, in both
 * directions: a running run absent from `watching` says `· not yet
 * watched`, and a watched id with no run behind it gets a placeholder row.
 * A monitor that silently reconciled two disagreeing payloads would be
 * lying about the one thing it exists to report.
 *
 * `projectLabel`, not a private basename. The Settings feed this replaces
 * justified its own `projectBasename` as "what every project surface
 * prints"; `projectLabel` (lib/project-label.ts) is that surface's actual
 * implementation, and it was already lifted out of two components for
 * exactly this reason once before.
 *
 * The click-through exists because a row here IS a run in the list one
 * segment away: the monitor answers "which run is in trouble", and the
 * immediate next question is "what was it doing", which the Runs detail
 * pane already answers in full. `onSelectRun` switches the mode back and
 * selects that run rather than this component growing a second, thinner
 * copy of the detail pane.
 *
 * `WATCHDOG_EVENT_CAP` is read from `shared/types.ts` rather than typed as
 * `50` in the hint: the constant's own comment says the list is sized to
 * it, and a hint that names a different number than the server enforces is
 * worse than no hint, because a reader uses it to decide whether a short
 * feed means a quiet watchdog or a truncated one.
 *
 * task-38 (DESIGN.md §8.4.2) makes it a PAGE rather than a body swapped in
 * under the Runs section's own bar: it opens on its own `Band` (`Runs ·
 * Watchdog`, the `section · destination` convention the rail's tree sets),
 * carries three figures where task-26 put three tiles, and holds its watching
 * rows and its activity feed in a `Sheet` each. Nothing about which payload
 * says what changed; every join below is task-26's.
 *
 * Two additions are genuinely new. The first is §8.4.2's Resume control on a
 * crashed row — which is `RunControls`, the same component the Runs detail
 * sheet's head draws, rather than a `Resume now` chip of this page's own. The
 * design names both surfaces as readers of `watchdogStoodDown`; making them
 * one COMPONENT rather than two callers is how they read it once. A chip here
 * would have been a second rendering of that table, a second synchronous
 * in-flight guard to keep in agreement (bug-19's layer 1), and a second copy
 * of the 409-is-success rule. The second addition is the `Policy in Settings
 * ›` chip in the band, flat and inert because the policy is read here and
 * edited there, and a second editor for the same three numbers is a second
 * thing to keep in agreement.
 *
 * task-26 (spec §3) kept every one of those joins and rerendered them.
 * The first shape of this surface was deliberately plain — "a monitor read
 * at a glance while something is going wrong, not a dashboard" — and the
 * plainness overshot: a state sentence, a config sentence, a stack of
 * five-field buttons and a `<ul>` of sentences encoded no state in FORM, so
 * a crashed run and a healthy one differed by one word and one border
 * colour. Worse, the one reading a person watching a live run most wants —
 * how close is this run to being called crashed — was not on the page at
 * all, even though `updatedAt`, `RUN_STALE_MS` and a clock were all already
 * here. Hence the three tiles, the per-run freshness meter and the
 * kind-badged feed: the same facts, in shapes that can be read without
 * being parsed.
 */
export function WatchdogMonitor({
  runs,
  onSelectRun,
  gateFor,
  resuming,
  onChanged
}: {
  runs: OrchestratorRunsPayload['runs'];
  onSelectRun: (project: string, runId: string) => void;
  /** task-38: the environment half of the resume gate, per project —
   *  `resumeGate` (shared/agent.ts) applied by the one component that holds
   *  the agents status. Handed down as a function rather than a resolved gate
   *  because this page draws a row per running run and each is a different
   *  project; deriving it here would mean this component reaching for
   *  `useAgents` itself, which is the second data source `RunControls`' own
   *  prop contract exists to avoid. */
  gateFor: (project: string) => { canResume: boolean; blockedReason: string | null };
  /** Projects this board has already asked for a resume of — the same mark
   *  the detail sheet's head reads, so the two controls cannot disagree about
   *  whether a resume is already on its way. */
  resuming: ReadonlySet<string>;
  onChanged: (project: string, kind: 'pause' | 'cancel' | 'resume') => void;
}) {
  const { status, error } = useWatchdog();

  // Every `running` run, fresh or crashed alike — a crashed run is exactly
  // the one this surface most needs to draw, and `isCrashed` below is what
  // tells the two apart in the verdict rather than here in the filter.
  const running = runs.filter((r) => r.status === 'running');

  // TWO readings here move with no new payload, and the clock has to be
  // enabled for either of them — the same `enabled` bargain every other
  // `useNow` caller makes, just with two conditions rather than one. 5s
  // matches the watchdog poll's own cadence: a heartbeat age that stepped in
  // minutes beside a state line stepping in seconds would read as two
  // clocks.
  //
  // The rows are the obvious one: each prints a heartbeat age. The second is
  // `stateLine`'s own `next check in Ns` countdown, and it is the one this
  // gate originally missed (review finding, task-18). `armed` with NOTHING
  // running in the payload is a state this component deliberately renders
  // rather than hides — it is the one-poll-tick skew case, and the
  // `watchdog-row-missing` placeholder lives in it too — so gating on rows
  // alone froze that countdown at whatever it read on mount while the real
  // next tick came and went. `status` is read before the early return below
  // for exactly this: the phase is a reason to keep a clock even when there
  // is not a single row to age.
  const now = useNow(running.length > 0 || status?.phase === 'armed', 5_000);

  // `useWatchdog` never throws — a failed GET lands in `error` and leaves
  // `status` at `null`. There is nothing honest to render from that: this
  // whole page reports on the watchdog, so a fallback that looked like a
  // reading would tell someone the sweeper is idle when the truth is this
  // tab could not reach the server. The band stays, because the page still
  // has to say which page it is.
  if (status === null) {
    return (
      <div className="watchdog-monitor" data-testid="watchdog-monitor">
        <Band title="Runs · Watchdog" />
        <Sheet>
          <div className="watchdog-state" data-testid="watchdog-state">
            <span className="watchdog-hint">
              Could not reach the watchdog{error ? ` — ${error}` : ''}. This page will fill in once the API answers <code>GET /api/agents/watchdog</code> again.
            </span>
          </div>
        </Sheet>
      </div>
    );
  }

  const { config } = status;
  const watching = new Set(status.watching);
  // The other half of the skew: ids the sweeper claims to be watching that
  // no `running` run in this payload accounts for.
  const orphans = status.watching.filter((id) => !running.some((r) => r.runId === id));

  // The three counts the watching figure states once so nobody has to count
  // rows below it. All three are derived from the same `running` array the
  // rows are, so the figure and the sheet cannot disagree.
  const crashedCount = running.filter((r) => isCrashed(r)).length;
  const unwatchedCount = running.filter((r) => !watching.has(r.runId)).length;

  // `null` for every phase but armed, and for an unreadable tick — see the
  // function's own comment for why no bar at all beats an empty one.
  const sweep = sweepFraction(status, now);
  // The countdown in seconds, the same arithmetic `stateLine` prints in
  // words, so the meter and the sentence beside it agree to the second.
  //
  // `null` wherever `sweep` is — which is every phase but `armed`, and an
  // unreadable `nextTickAt` within it. That gate is not defensive tidiness:
  // `idle` and `off` carry `nextTickAt: null` by construction, `Date.parse`
  // of it is `NaN`, and a `NaN` here reached both the meter's own value and
  // the figure's line, where `formatSpanCompact` has no honest answer for it.
  // Reusing `sweepFraction`'s own verdict rather than re-deriving "is there a
  // tick to count down to" keeps the bar and the words it sits under from
  // ever disagreeing about whether there is one.
  const sweepSeconds = sweep === null ? null : Math.max(0, Math.round((Date.parse(status.nextTickAt as string) - now) / 1000));

  return (
    <div className="watchdog-monitor" data-testid="watchdog-monitor">
      {/* `stateLine` verbatim as the band's subtitle, and the reason this
          component reads a function for it at all: two surfaces print one
          sentence about one sweeper, and two hand-written copies would
          drift. */}
      <Band title="Runs · Watchdog" sub={<span data-testid="watchdog-state-line">{stateLine(status, now)}</span>}>
        {/* Flat and inert: `SettingsView` has no section setter to plumb
            through for one chip, and the rail is one click away. The knobs are
            edited in exactly one place. */}
        <Chip variant="flat" data-testid="watchdog-policy-link" title="Settings › Orchestrator watchdog">
          Policy in Settings ›
        </Chip>
      </Band>

      {/* `watchdog-state` stays on the strip even though the single state card
          became three figures: it is what the unavailable-notice case above
          selects, and the meaning — "the sweeper's own reading, as opposed to
          any one run's" — survived the shape change intact. */}
      <div data-testid="watchdog-state">
        <FigureStrip cols={3}>
          <Figure
            label="sweeper"
            value={
              <span className="watchdog-tile-phase">
                <span className={`watchdog-lamp watchdog-lamp-${status.phase}`} aria-hidden="true" />
                <span data-testid="watchdog-phase">{status.phase}</span>
              </span>
            }
            /* The cadence is printed whether or not a sweep is pending — it
               is the policy, and a reader wants it in both states — but the
               countdown half only exists while one is actually running. */
            line={
              sweepSeconds === null
                ? `every ${formatSpanCompact(config.tickMs)}`
                : `next sweep in ${formatSpanCompact(sweepSeconds * 1000)} · every ${formatSpanCompact(config.tickMs)}`
            }
          >
            {sweep !== null && sweepSeconds !== null && (
              // The countdown `stateLine` already prints in words, drawn — a
              // depleting rule is what makes "armed" read as something
              // happening rather than a label. Drawn only while armed:
              // `idle` and `off` have no next tick to be partway through, and
              // an empty bar reads as "a sweep is imminent".
              //
              // `hatch` because this one IS a quantity of work — the tick's
              // own elapsing — which is the distinction `ProgressRow`'s own
              // comment draws against the heartbeat meter below.
              <div data-testid="watchdog-sweep">
                <ProgressRow value={sweepSeconds} max={Math.round(config.tickMs / 1000)} height={6} hatch />
              </div>
            )}
          </Figure>

          <Figure
            label="watching"
            /* `—`, never `0`, while off: nothing is watched at all, and a zero
               would read as a healthy count taken by a sweeper that is
               actually not running. */
            value={<span data-testid="watchdog-watching">{status.phase === 'off' ? '—' : running.length}</span>}
            unit={status.phase === 'off' ? undefined : running.length === 1 ? 'running run' : 'running runs'}
            line={
              status.phase === 'off' ? (
                'nothing is watched while off'
              ) : (
                <span className="watchdog-counts">
                  {/* Printed at zero as well as above it, but muted and
                      glyphless there: the count must always be readable, and
                      the page must not cry wolf on a healthy afternoon. */}
                  <span className={crashedCount > 0 ? 'watchdog-warn' : undefined}>
                    {crashedCount > 0 && <span aria-hidden="true">⚠ </span>}
                    {crashedCount} crashed
                  </span>
                  <span>{running.length - crashedCount} fresh</span>
                  {unwatchedCount > 0 && <span>{unwatchedCount} not yet watched</span>}
                </span>
              )
            }
          />

          <Figure label="policy">
            {/* The same three words the old one-line sentence used, in rows:
                the vocabulary is what a reader carries between this figure and
                the Settings knobs, so it survives the shape change unchanged.
                Every number prints from `config`, never a literal — their
                bounds are `WATCHDOG_LIMITS`, which the Settings ladders and
                the server's clamp already read as one triple. */}
            <div className="watchdog-policy" data-testid="watchdog-config-line">
              <span className="watchdog-policy-label">check every</span>
              <span className="watchdog-policy-value">{formatSpanCompact(config.tickMs)}</span>
              <span className="watchdog-policy-label">leave alone for</span>
              <span className="watchdog-policy-value">{formatSpanCompact(config.graceMs)}</span>
              <span className="watchdog-policy-label">give up after</span>
              <span className="watchdog-policy-value">{config.maxAttempts}</span>
            </div>
            {/* The enabled switch's state, UNDER the three pairs — the cell's
                12 px line (§8.4.2), drawn here rather than through `Figure`'s
                own `line` prop because this cell has no value for that line to
                sit under, and above the pairs it would read as a caption for
                the label rather than as the reading it qualifies.
                  It is named at all because two switches reach this page and
                they are not interchangeable. `WatchdogConfig.enabled` is the
                user's Settings toggle and withholds the SPAWN alone — a
                watchdog disabled there still arms, still ticks, and still
                reports the crashed run it would have resumed. The phase above
                reads `off` only when the ENVIRONMENT says so. */}
            <span className="watchdog-policy-line">
              {config.enabled ? 'resume spawns on · your switch, not the phase' : 'resume spawns off · your switch, not the phase'}
            </span>
          </Figure>
        </FigureStrip>
      </div>

      {/* Omitted entirely while the sweeper is off — nothing is being
          watched, and the band's own state line has already said why. An
          empty-rows line here would be a second answer to a question already
          settled one line up. */}
      {status.phase !== 'off' && (
        <Sheet className="watchdog-watching-sheet">
          <SheetHead title="Watching" sub={`${running.length} ${running.length === 1 ? 'run' : 'runs'} · annotated from the sweeper's own set`} />
          <div className="watchdog-rows" data-testid="watchdog-rows">
            {running.map((run) => {
              const crashed = isCrashed(run);
              const clause = crashed ? watchdogClause(run.watchdog, now) : '';
              const reported = lastReportedEntry(run.queue);
              const age = Math.max(0, now - Date.parse(run.updatedAt));
              const beat = Number.isFinite(age) ? `heartbeat ${formatSpanCompact(age)} ago` : 'heartbeat unknown';
              // `null` for a stamp nobody can read, in which case the meter is
              // omitted rather than drawn empty — an empty track claims a
              // heartbeat this instant, the opposite of what an unreadable
              // stamp says. See `freshnessFraction`'s own comment.
              const fraction = freshnessFraction(run.updatedAt, now);
              // Only ever printed on a crashed, annotated row; positive means
              // the sweeper's own grace window is still open.
              const grace = crashed && run.watchdog !== undefined ? graceRemainingMs(run.watchdog, config, now) : null;
              return (
                /* A `<div>` wrapper with the jump as a real `<button>` inside
                   it and `RunControls` as that button's SIBLING — never
                   nested. A `<button>` may carry no interactive descendant
                   and no descendant with a `tabindex`, and jsdom fails on
                   neither, which is how a green suite once shipped exactly
                   that shape on the board's crashed strip. Two independent
                   controls cannot be one element. */
                <div key={`${run.project} ${run.runId}`} className="watchdog-row">
                  {/* The row IS a run in the History list, so it jumps there
                      and selects it — which is what this component has always
                      done, and under shape D the only place it could send
                      anyone: the run's detail IS that page's sheet. */}
                  <button
                    type="button"
                    data-testid="watchdog-row"
                    /* The verdict tone rides the BUTTON rather than the wrapper
                       div, because the button is the whole informational body —
                       every element the tone reaches (`.watchdog-row-verdict`,
                       the glyph) is inside it, and the Resume sibling outside
                       must not be recoloured by the run's verdict. */
                    className={`watchdog-row-open ${crashed ? 'watchdog-row-crashed' : 'watchdog-row-ok'}`}
                    onClick={() => onSelectRun(run.project, run.runId)}
                  >
                    <span className="watchdog-card-head">
                      {crashed ? <Dot tone="crashed" /> : <Dot tone="live" />}
                      <span className="watchdog-row-project">{projectLabel(run.project)}</span>
                      <span className="watchdog-row-id">{run.runId}</span>
                      {!watching.has(run.runId) && <span className="watchdog-row-skew">· not yet watched</span>}
                      {/* The glyph is a SIBLING of the verdict, not inside it,
                          so no mark is colour alone AND the verdict element's
                          own text stays exactly the one word every reader — a
                          person, assistive tech, or a test — matches on. */}
                      <span className="watchdog-verdict-glyph" aria-hidden="true">
                        {crashed ? '⚠' : '●'}
                      </span>
                      <span className="watchdog-row-verdict" data-testid="watchdog-verdict">
                        {crashed ? 'crashed' : 'ok'}
                      </span>
                    </span>

                    <span className="watchdog-card-item">{reported === null ? 'between items' : `${reported.id} · ${reported.stage}`}</span>

                    {fraction === null ? (
                      <span className="watchdog-card-beat">{beat}</span>
                    ) : (
                      <span className="watchdog-meter" data-testid="watchdog-meter">
                        {/* The scale is `RUN_STALE_MS` itself, so the bar can
                            never point at a different line than the verdict
                            beside it. Both labels are FORMATTED FROM THE
                            CONSTANT at render time, never a typed "15m": a
                            meter labelled with a literal keeps naming the old
                            window the day `RUN_STALE_MS` moves, and on that
                            day the label lies while the meter behind it is
                            still right. */}
                        <ProgressRow
                          name={beat}
                          valueText={crashed ? `past the ${formatSpanCompact(RUN_STALE_MS)} stale line` : `stale at ${formatSpanCompact(RUN_STALE_MS)}`}
                          value={Math.floor(age / 1000)}
                          max={RUN_STALE_MS / 1000}
                          height={6}
                          fill={crashed ? 'warn' : 'progress'}
                        />
                      </span>
                    )}

                    {/* A crashed run the server has not annotated yet renders
                        the verdict alone — `watchdogClause(undefined)` is
                        `''`, and an empty element with a separator in it would
                        read as a truncated sentence. */}
                    {crashed && run.watchdog !== undefined && (
                      <span className="watchdog-card-wd">
                        <span
                          className="watchdog-attempts"
                          data-testid="watchdog-attempts"
                          aria-label={`attempt ${run.watchdog.attempts} of ${run.watchdog.maxAttempts}`}
                        >
                          {Array.from({ length: run.watchdog.maxAttempts }, (_unused, i) => (
                            <i key={i} className={i < (run.watchdog as RunWatchdog).attempts ? 'on' : ''} />
                          ))}
                        </span>
                        {clause !== '' && (
                          // Verbatim, `watchdog:` prefix and all: it is the one
                          // sentence the Live row also prints, and ten
                          // redundant characters cost less than two surfaces
                          // that could disagree about one run.
                          <span data-testid="watchdog-clause">{clause}</span>
                        )}
                        {run.watchdog.lastSessionId !== null && <span className="watchdog-card-session">{`→ session ${run.watchdog.lastSessionId}`}</span>}
                        {grace !== null && grace > 0 && <span data-testid="watchdog-grace">{`leave alone ${formatSpanCompact(grace)} more`}</span>}
                      </span>
                    )}
                  </button>

                  {/* The Resume control §8.4.2 asks for — drawn only once the
                      sweeper has stood down, whatever the grace clock says,
                      because grace is a backoff and not a stand-down.
                        It is `RunControls`, not a chip of this page's own, and
                      the gate is NOT re-asked here: that component reads
                      `watchdogStoodDown` itself and renders nothing for a
                      crashed run the sweeper may still act on. Calling that
                      predicate a second time around it would be an expression
                      agreeing with the first, which is
                      precisely the shape CLAUDE.md's resume-coupling invariant
                      forbids — "one function, not two agreeing expressions" —
                      and the shape that once survived a whole branch with
                      every test green while one half had been quietly widened.
                        The component also brings the synchronous in-flight
                      guard (bug-19's layer 1) and the 409-is-success rule with
                      it, neither of which a hand-written chip here would
                      have. */}
                  {crashed && (
                    <div className="watchdog-row-resume" data-testid="watchdog-resume">
                      <RunControls
                        run={run}
                        gate={gateFor(run.project)}
                        resuming={resuming.has(run.project)}
                        onChanged={(kind) => onChanged(run.project, kind)}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Not a button: there is no run to select. */}
            {orphans.map((id) => (
              <div key={id} className="watchdog-row-missing" data-testid="watchdog-row-missing">
                {`${id} — not in the runs payload`}
              </div>
            ))}

            {running.length === 0 && orphans.length === 0 && (
              <div className="watchdog-rows-empty" data-testid="watchdog-rows-empty">
                {status.phase === 'idle' ? 'no running run' : 'nothing running in the runs payload yet'}
              </div>
            )}
          </div>
        </Sheet>
      )}

      <Sheet className="watchdog-activity">
        <SheetHead
          title="Activity"
          sub={
            <span data-testid="watchdog-events-hint">
              Newest first — what the sweeper itself did (armed, spawned a resume, gave up), not the run's own stage track. The last {WATCHDOG_EVENT_CAP} only,
              held in the API process's memory: an API restart empties it.
            </span>
          }
        />
        {status.events.length === 0 ? (
          // Replaces the table rather than heading an empty one: a header row
          // over nothing reads as a list that failed to load.
          <div className="watchdog-events-empty" data-testid="watchdog-events-empty">
            nothing since the server started
          </div>
        ) : (
          // A table, because a log IS columns — time, actor, what — and every
          // line here has the same five fields. The 2026-09-02 design rejected
          // a dense ledger table for the RUNS LIST, where a detail pane was
          // the point; nothing in that argument applies to a feed.
          //
          // Inside `Ledger`, which owns the overflow box (§8.4's "every table
          // scrolls inside its own sheet") — with no `columns`, so the table
          // lays out its own five and the primitive only holds the box. See
          // `Ledger`'s own comment for why that variant exists.
          <Ledger label="Sweeper activity">
            <table className="watchdog-table" data-testid="watchdog-events">
              <thead>
                <tr>
                  <th scope="col">time</th>
                  <th scope="col">kind</th>
                  <th scope="col">project</th>
                  <th scope="col">run</th>
                  <th scope="col">what the sweeper did</th>
                </tr>
              </thead>
              <tbody>
                {status.events.map((event, i) => (
                  <tr key={`${event.runId ?? 'none'}-${event.at}-${i}`}>
                    <td>
                      <time dateTime={event.at}>{formatClock(event.at) ?? '—:—'}</time>
                    </td>
                    <td>
                      {/* The column the payload always carried and this feed
                          never printed: a `failed` line and a `recovered` one
                          used to be the same grey until read. Glyph AND word,
                          so the tone is never the only carrier. */}
                      <span className={`watchdog-kind watchdog-kind-${WATCHDOG_KIND_TONE[event.kind]}`}>
                        <span aria-hidden="true">{WATCHDOG_KIND_GLYPH[event.kind]}</span>
                        {event.kind}
                      </span>
                    </td>
                    {/* An em dash, not a blank: a sweeper-level event (arming,
                        standing down) is about no one run, and an empty cell
                        reads as missing data where a dash reads as "not
                        applicable". */}
                    <td>{event.project === null ? '—' : projectLabel(event.project)}</td>
                    <td>{event.runId ?? '—'}</td>
                    <td className="watchdog-table-detail">{event.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Ledger>
        )}
      </Sheet>
    </div>
  );
}
