import { useNow } from '../../hooks/useNow';
import { useWatchdog } from '../../hooks/useWatchdog';
import { projectLabel } from '../../lib/project-label';
import { formatClock, formatSpanCompact, freshnessFraction, lastReportedEntry } from '../../lib/run-time';
import {
  graceRemainingMs, isCrashed, stateLine, sweepFraction, watchdogClause,
  WATCHDOG_KIND_GLYPH, WATCHDOG_KIND_TONE
} from '../../lib/run-watchdog';
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
export function WatchdogMonitor({ runs, onSelectRun }: {
  runs: OrchestratorRunsPayload['runs'];
  onSelectRun: (project: string, runId: string) => void;
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
  // whole view reports on the watchdog, so a fallback that looked like a
  // reading would tell someone the sweeper is idle when the truth is this
  // tab could not reach the server.
  if (status === null) {
    return (
      <div className="watchdog-monitor" data-testid="watchdog-monitor">
        <div className="watchdog-state" data-testid="watchdog-state">
          <span className="watchdog-hint">
            Could not reach the watchdog{error ? ` — ${error}` : ''}. This view will fill
            in once the API answers <code>GET /api/agents/watchdog</code> again.
          </span>
        </div>
      </div>
    );
  }

  const { config } = status;
  const watching = new Set(status.watching);
  // The other half of the skew: ids the sweeper claims to be watching that
  // no `running` run in this payload accounts for.
  const orphans = status.watching.filter(
    (id) => !running.some((r) => r.runId === id)
  );

  // The three counts the watching tile states once so nobody has to count
  // chips on the cards below it. All three are derived from the same
  // `running` array the cards are, so the head and the body cannot disagree.
  const crashedCount = running.filter((r) => isCrashed(r)).length;
  const unwatchedCount = running.filter((r) => !watching.has(r.runId)).length;

  // `null` for every phase but armed, and for an unreadable tick — see the
  // function's own comment for why no bar at all beats an empty one.
  const sweep = sweepFraction(status, now);

  return (
    <div className="watchdog-monitor" data-testid="watchdog-monitor">
      {/* `watchdog-state` stays on the wrapper even though the single state
          card became three tiles: it is what the unavailable-notice case
          selects, and the meaning — "the sweeper's own reading, as opposed
          to any one run's" — survived the shape change intact. */}
      <div className="watchdog-tiles" data-testid="watchdog-state">
        <div className="runs-tile">
          <div className="runs-tile-value watchdog-tile-phase">
            <span className={`watchdog-lamp watchdog-lamp-${status.phase}`} aria-hidden="true" />
            <span data-testid="watchdog-phase">{status.phase}</span>
          </div>
          <div className="runs-tile-label">sweeper</div>
          {/* Verbatim, and the reason this component reads a function for it
              at all: the strip and this surface print one sentence about one
              sweeper, and two hand-written copies would drift. */}
          <span className="watchdog-state-line" data-testid="watchdog-state-line">
            {stateLine(status, now)}
          </span>
          {sweep !== null && (
            // The countdown `stateLine` already prints in words, drawn — a
            // depleting rule is what makes "armed" read as something
            // happening rather than a label. `Math.round`, matching that
            // sentence's own arithmetic, so the bar and the words beside it
            // agree to the second.
            <div
              className="watchdog-sweep"
              data-testid="watchdog-sweep"
              role="meter"
              aria-label="time to next sweep"
              aria-valuemin={0}
              aria-valuemax={Math.round(config.tickMs / 1000)}
              aria-valuenow={Math.max(0, Math.round((Date.parse(status.nextTickAt as string) - now) / 1000))}
            >
              <span className="watchdog-sweep-fill" style={{ width: `${sweep * 100}%` }} />
            </div>
          )}
        </div>

        <div className="runs-tile">
          <div className="runs-tile-value">
            {/* `—`, never `0`, while off: nothing is watched at all, and a
                zero would read as a healthy count taken by a sweeper that is
                actually not running. */}
            <span data-testid="watchdog-watching">{status.phase === 'off' ? '—' : running.length}</span>
            {status.phase !== 'off' && (
              <small className="watchdog-tile-unit">{running.length === 1 ? 'running run' : 'running runs'}</small>
            )}
          </div>
          <div className="runs-tile-label">watching</div>
          <div className="runs-tile-substat">
            {status.phase === 'off' ? (
              <span className="runs-tile-substat-item">nothing is watched while off</span>
            ) : (
              <>
                {/* Printed at zero as well as above it, but muted and
                    glyphless there: the count must always be readable, and
                    the tile must not cry wolf on a healthy afternoon. */}
                <span className={`runs-tile-substat-item${crashedCount > 0 ? ' watchdog-warn' : ''}`}>
                  {crashedCount > 0 && <span aria-hidden="true">⚠ </span>}
                  {crashedCount} crashed
                </span>
                <span className="runs-tile-substat-item">{running.length - crashedCount} fresh</span>
                {unwatchedCount > 0 && (
                  <span className="runs-tile-substat-item">{unwatchedCount} not yet watched</span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="runs-tile">
          {/* The same three words the old one-line sentence used, in rows:
              the vocabulary is what a reader carries between this tile and
              the Settings knobs, so it survives the shape change unchanged.
              Every number prints from `config`, never a literal. */}
          <div className="watchdog-policy" data-testid="watchdog-config-line">
            <span className="watchdog-policy-label">check every</span>
            <span className="watchdog-policy-value">{formatSpanCompact(config.tickMs)}</span>
            <span className="watchdog-policy-label">leave alone for</span>
            <span className="watchdog-policy-value">{formatSpanCompact(config.graceMs)}</span>
            <span className="watchdog-policy-label">give up after</span>
            <span className="watchdog-policy-value">{config.maxAttempts}</span>
          </div>
          <div className="runs-tile-label">policy</div>
          {/* Plain text, not a link: `SettingsView` has no section setter to
              plumb through for one sentence, and the side rail is one click
              away. The knobs are edited in exactly one place. */}
          <span className="watchdog-hint">Configure in Settings › Orchestrator watchdog.</span>
        </div>
      </div>

      {/* Omitted entirely while the sweeper is off — nothing is being
          watched, and the state line has already said why. An empty-rows
          line here would be a second answer to a question already settled
          one line up. */}
      {status.phase !== 'off' && (
        <div className="watchdog-rows" data-testid="watchdog-rows">
          {running.map((run) => {
            const crashed = isCrashed(run);
            const clause = crashed ? watchdogClause(run.watchdog, now) : '';
            const reported = lastReportedEntry(run.queue);
            const age = Math.max(0, now - Date.parse(run.updatedAt));
            const beat = Number.isFinite(age)
              ? `heartbeat ${formatSpanCompact(age)} ago`
              : 'heartbeat unknown';
            // `null` for a stamp nobody can read, in which case the meter is
            // omitted rather than drawn empty — an empty track claims a
            // heartbeat this instant, the opposite of what an unreadable
            // stamp says. See `freshnessFraction`'s own comment.
            const fraction = freshnessFraction(run.updatedAt, now);
            // Only ever printed on a crashed, annotated card; positive means
            // the sweeper's own grace window is still open.
            const grace = crashed && run.watchdog !== undefined
              ? graceRemainingMs(run.watchdog, config, now)
              : null;
            return (
              <button
                key={`${run.project} ${run.runId}`}
                type="button"
                data-testid="watchdog-row"
                className={`watchdog-row ${crashed ? 'watchdog-row-crashed' : 'watchdog-row-ok'}`}
                onClick={() => onSelectRun(run.project, run.runId)}
              >
                <span className="watchdog-card-head">
                  <span className="watchdog-row-project">{projectLabel(run.project)}</span>
                  <span className="watchdog-row-id">{run.runId}</span>
                  {!watching.has(run.runId) && (
                    <span className="watchdog-row-skew">· not yet watched</span>
                  )}
                  {/* The glyph is a SIBLING of the verdict, not inside it, so
                      no mark is colour alone AND the verdict element's own
                      text stays exactly the one word every reader — a person,
                      assistive tech, or a test — matches on. */}
                  <span className="watchdog-verdict-glyph" aria-hidden="true">{crashed ? '⚠' : '●'}</span>
                  <span className="watchdog-row-verdict" data-testid="watchdog-verdict">
                    {crashed ? 'crashed' : 'ok'}
                  </span>
                </span>

                <span className="watchdog-card-item">
                  {reported === null ? 'between items' : `${reported.id} · ${reported.stage}`}
                </span>

                {fraction === null ? (
                  <span className="watchdog-card-beat">{beat}</span>
                ) : (
                  <>
                    {/* `role="meter"` with real `aria-*` values rather than a
                        bare styled div: it costs nothing at render and buys
                        both a reading for assistive tech and tests that
                        assert a number instead of parsing a style
                        attribute. The scale is `RUN_STALE_MS` itself, so the
                        bar can never point at a different line than the
                        verdict beside it. */}
                    <div
                      className="watchdog-meter"
                      data-testid="watchdog-meter"
                      role="meter"
                      aria-label="heartbeat age"
                      aria-valuemin={0}
                      aria-valuemax={RUN_STALE_MS / 1000}
                      aria-valuenow={Math.floor(age / 1000)}
                      aria-valuetext={beat}
                    >
                      <span className="watchdog-meter-fill" style={{ width: `${fraction * 100}%` }} />
                    </div>
                    <span className="watchdog-meter-labels">
                      <span>{beat}</span>
                      {/* The line prints from the constant, never a typed
                          "15m": a meter labelled with a literal keeps naming
                          the old window the day RUN_STALE_MS moves. */}
                      <span>
                        {crashed
                          ? `past the ${formatSpanCompact(RUN_STALE_MS)} stale line`
                          : `stale at ${formatSpanCompact(RUN_STALE_MS)}`}
                      </span>
                    </span>
                  </>
                )}

                {/* A crashed run the server has not annotated yet renders the
                    verdict alone — `watchdogClause(undefined)` is `''`, and an
                    empty element with a separator in it would read as a
                    truncated sentence. */}
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
                      // sentence the board's crashed strip also prints, and
                      // ten redundant characters cost less than two surfaces
                      // that could disagree about one run.
                      <span data-testid="watchdog-clause">{clause}</span>
                    )}
                    {run.watchdog.lastSessionId !== null && (
                      <span className="watchdog-card-session">{`→ session ${run.watchdog.lastSessionId}`}</span>
                    )}
                    {grace !== null && grace > 0 && (
                      <span data-testid="watchdog-grace">{`leave alone ${formatSpanCompact(grace)} more`}</span>
                    )}
                  </span>
                )}
              </button>
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
      )}

      <div className="watchdog-activity">
        <span className="watchdog-activity-name">Activity</span>
        <span className="watchdog-hint" data-testid="watchdog-events-hint">
          Newest first — what the sweeper itself did (armed, spawned a resume, gave up),
          not the run's own stage track. The last {WATCHDOG_EVENT_CAP} only, held in the
          API process's memory: an API restart empties it.
        </span>
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
          <div className="watchdog-table-wrap">
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
                    <td><time dateTime={event.at}>{formatClock(event.at) ?? '—:—'}</time></td>
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
          </div>
        )}
      </div>
    </div>
  );
}
