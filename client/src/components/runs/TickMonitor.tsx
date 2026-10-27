import { useRef, useState } from 'react';

import { useNow } from '../../hooks/useNow';
import { useTicks } from '../../hooks/useTicks';
import { formatClock } from '../../lib/run-time';
import { sortTickProjects, tickActivity, ticksLast24h } from '../../lib/ticks';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { Figure, FigureStrip } from '../ui/Figure';
import { Ledger } from '../ui/Ledger';
import { Pill } from '../ui/Pill';
import { Sheet, SheetHead } from '../ui/Sheet';
import type { TickProject } from '../../../../shared/types';
import { useTimeZone } from '../../hooks/TimeZoneContext';

/**
 * Runs › Ticks (tick-breaker spec, "Client"; .claude/DESIGN.md §8.4 and §8.4.2) — the third Runs page, built as the Watchdog page is: its own `Band`
 * (`Runs · Ticks`, the `section · destination` convention the rail's tree sets), three figures, a sheet of per-project rows and a sheet of activity. It reads
 * what the breaker has decided, per project, and carries the ONE write the breaker needs a person for: Reset.
 *
 * It takes no props, unlike `WatchdogMonitor`, because nothing here joins another payload: `useTicks({ live: true })` is the only source, and it mounts only
 * while this page is open, so the 15 s poll runs exactly while someone is looking. `streak`, `halted` and `haltedSince` arrive already derived by the server
 * (the breaker rule lives in `tick-breaker.util.ts` and nowhere on the client), so no row below recomputes a verdict — it prints one.
 *
 * Why Reset lives on this page and the policy does not: the threshold is edited in Settings › Backlog tick, and a second editor for the same number is a
 * second thing to keep in agreement, so the band carries the same flat, inert `Policy in Settings ›` chip the Watchdog page does. A Reset, by contrast, is an
 * act on one project's history and has no home in a settings card.
 *
 * The Reset button's two guards are this component's own, not the hook's. `useTicks.reset` is a bare awaited call; a double-click would fire two POSTs
 * (two stamps, `max(now, newest at)` each) unless the button is closed before the first settles — and `disabled` alone is a re-render away, so the in-flight
 * set is a REF read synchronously by the handler, with state only to draw the disabled button. `saveError` is hook-wide (one slot for both writes), so the
 * component remembers which root it last asked to reset and shows the error under THAT row alone; every other row stays quiet about a refusal that was not
 * theirs.
 *
 * Every row, figure and sheet is drawn from ONE payload, so a figure and the rows under it cannot disagree. The 24 h figure is the one reading that moves
 * with no new payload (a tick ages out of the window), so the clock is enabled at a minute — the cadence the figure's own resolution deserves.
 */
export function TickMonitor() {
  const { zone } = useTimeZone();
  const { data, error, saveError, reset } = useTicks({ live: true });
  const now = useNow(true, 60_000);

  // Synchronous guard first, drawn state second — see the header for why one cannot stand in for the other.
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [lastReset, setLastReset] = useState<string | null>(null);

  async function onReset(root: string): Promise<void> {
    if (inFlight.current.has(root)) return;
    inFlight.current.add(root);
    setPending(new Set(inFlight.current));
    setLastReset(root);
    try {
      await reset(root);
    } finally {
      inFlight.current.delete(root);
      setPending(new Set(inFlight.current));
    }
  }

  // `useTicks` never throws — a failed first GET lands in `error` and leaves `data` null. There is nothing honest to draw from that: a page of "none halted"
  // would tell someone the breaker is quiet when this tab could not reach the server. The band stays, because the page still has to say which page it is.
  if (data === null) {
    return (
      <div className="watchdog-monitor" data-testid="tick-monitor">
        <Band title="Runs · Ticks" />
        <Sheet>
          <span className="watchdog-hint" data-testid="tick-unreachable">
            Could not reach the tick history{error ? ` — ${error}` : ''}. This page will fill in once the API answers <code>GET /api/ticks</code> again.
          </span>
        </Sheet>
      </div>
    );
  }

  const { config, projects } = data;
  const sorted = sortTickProjects(projects);
  const halted = projects.filter((p) => p.halted === true);
  // "With tick history": a project whose `recent` is empty has a state directory but nothing to count, and the band and the policy figure both state this
  // one number so they cannot disagree.
  const withHistory = projects.filter((p) => p.recent.length > 0).length;
  const day = ticksLast24h(projects, now);
  const activity = tickActivity(projects);

  return (
    <div className="watchdog-monitor" data-testid="tick-monitor">
      <Band
        title="Runs · Ticks"
        sub={<span data-testid="tick-band-sub">{`${halted.length > 0 ? `${halted.length} halted · ` : ''}${withHistory} with tick history`}</span>}
      >
        {/* Flat and inert, for the reason the Watchdog page's is: the threshold is read here and edited in one place. */}
        <Chip variant="flat" data-testid="tick-policy-link" title="Settings › Backlog tick">
          Policy in Settings ›
        </Chip>
      </Band>

      <FigureStrip cols={3}>
        <Figure
          testId="tick-figure-breaker"
          label="breaker"
          value={halted.length > 0 ? halted.length : 'none'}
          unit="halted"
          tone={halted.length > 0 ? 'bad' : 'ink'}
          line={halted.length > 0 ? halted.map((p) => p.name).join(', ') : `after ${config.haltAfter} failures in a row`}
        />
        <Figure testId="tick-figure-24h" label="last 24 h" value={day.total} unit="ticks" line={`${day.ok} ok · ${day.failed} failed`} />
        <Figure testId="tick-figure-policy" label="policy">
          {/* The same label/value rows the Watchdog page's policy figure draws, from `config` rather than a literal. */}
          <div className="watchdog-policy">
            <span className="watchdog-policy-label">halt after</span>
            <span className="watchdog-policy-value">{`${config.haltAfter} failures`}</span>
            <span className="watchdog-policy-label">history on</span>
            <span className="watchdog-policy-value">{`${withHistory} projects`}</span>
          </div>
          {/* An unreadable `tick.json` still renders every figure — the number above is the default, for display only, and this line is what says so. */}
          <span className="watchdog-policy-line">
            {config.source === 'unreadable' ? 'tick.json cannot be read — showing the default' : 'a reset clears the count, not the item records'}
          </span>
        </Figure>
      </FigureStrip>

      {projects.length === 0 ? (
        // Replaces both sheets rather than heading two empty ones — the band and the figures above already say everything a zero can.
        <Sheet>
          <span className="watchdog-hint" data-testid="tick-empty">
            No project has ticked yet. A tick starts from a scheduled job running /backlog-tick.
          </span>
        </Sheet>
      ) : (
        <>
          <Sheet>
            <SheetHead title="Projects" />
            <div className="watchdog-rows" data-testid="tick-rows">
              {sorted.map((p) => (
                <TickRow
                  key={p.root}
                  project={p}
                  pending={pending.has(p.root)}
                  failure={lastReset === p.root ? saveError : null}
                  onReset={() => void onReset(p.root)}
                />
              ))}
            </div>
          </Sheet>

          <Sheet className="watchdog-activity">
            <SheetHead title="Activity" sub="Newest first, across every project" />
            <Ledger label="Tick activity">
              <table className="watchdog-table" data-testid="tick-events">
                <thead>
                  <tr>
                    <th scope="col">time</th>
                    <th scope="col">outcome</th>
                    <th scope="col">project</th>
                    <th scope="col">did</th>
                    <th scope="col">item</th>
                    <th scope="col">what happened</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((e, i) => (
                    <tr key={`${e.root}-${e.at}-${i}`}>
                      <td>
                        <time dateTime={e.at}>{formatClock(e.at, zone) ?? '—:—'}</time>
                      </td>
                      <td>
                        {/* Glyph AND word, so the tone is never the only carrier; an outcome this build has no name for prints as it came. */}
                        {e.outcome === 'ok' ? (
                          <span className="watchdog-kind watchdog-kind-done">✓ ok</span>
                        ) : e.outcome === 'failed' ? (
                          <span className="watchdog-kind watchdog-kind-bad">✕ failed</span>
                        ) : (
                          <span className="watchdog-kind watchdog-kind-muted">{e.outcome}</span>
                        )}
                      </td>
                      <td>{e.project}</td>
                      <td>{e.kind}</td>
                      <td>{e.id}</td>
                      <td className="watchdog-table-detail">{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Ledger>
          </Sheet>
        </>
      )}
    </div>
  );
}

/** One project's row — a `<div>` for the reason `WatchdogMonitor`'s rows are: the body and the Reset are two controls' worth of layout, never nested. */
function TickRow({ project: p, pending, failure, onReset }: { project: TickProject; pending: boolean; failure: string | null; onReset: () => void }) {
  const { zone } = useTimeZone();
  if (p.error !== undefined) {
    // Muted and button-less: an unreadable `state.json` has no verdict to reset, and a Reset on it would clear nothing a person could see.
    return (
      <div className="watchdog-row tick-row-error" data-testid="tick-row">
        <div className="tick-row-body">
          <span className="watchdog-row-project" data-testid="tick-row-name">
            {p.name}
          </span>
          <span>{p.error}</span>
        </div>
      </div>
    );
  }

  const last = p.recent[0];
  const isHalted = p.halted === true;
  return (
    <div className={isHalted ? 'watchdog-row tick-row-halted' : 'watchdog-row'} data-testid="tick-row">
      <div className="tick-row-body">
        <span className="watchdog-card-head">
          <span className="watchdog-row-project" data-testid="tick-row-name">
            {p.name}
          </span>
          {isHalted ? (
            <Pill tone="bad">halted</Pill>
          ) : (
            // Only while a lock is held: "a tick is running now". Whether that lock is stale is the reader's call and not this page's.
            p.lock !== null && (
              <Pill tone="live" title={`${p.lock.kind} ${p.lock.id} on ${p.lock.host}`}>
                ticking
              </Pill>
            )
          )}
        </span>
        {isHalted ? (
          <span className="watchdog-card-item">
            {`${p.streak ?? 0} failures in a row since ${formatClock(p.haltedSince, zone) ?? '—:—'}`}
            {last !== undefined && ` · last: ${last.reason} on ${last.id}`}
          </span>
        ) : last === undefined ? (
          <span className="watchdog-card-beat">no tick yet</span>
        ) : (
          <span className="watchdog-card-item">
            {`last tick ${formatClock(last.at, zone) ?? '—:—'} · ${last.kind} ${last.id} → ${last.outcome} · ${p.streak ?? 0} failures in a row`}
          </span>
        )}
        {/* #367 — the caps the last `decide` saw, which is the one place a tick that keeps answering `idle` says why: grooming waits while the plans
            awaiting review fill `--max-plans`. Absent until a tick has recorded them (`last-decide.json` is written by `decide`, not `record`). */}
        {p.lastDecide !== undefined && (
          <span className="watchdog-card-beat" data-testid="tick-row-caps">
            {`plans awaiting review ${p.lastDecide.caps.planReview}/${p.lastDecide.caps.maxPlans} · open PRs ${p.lastDecide.caps.openPrs ?? '?'}/${p.lastDecide.caps.maxPrs} · as of ${formatClock(p.lastDecide.at, zone) ?? '—:—'}`}
            {p.lastDecide.caps.planReview >= p.lastDecide.caps.maxPlans && ' · grooming blocked'}
          </span>
        )}
        {failure !== null && (
          <span className="tick-row-fail" role="alert">
            {failure}
          </span>
        )}
      </div>
      {isHalted && (
        <div className="watchdog-row-resume">
          <Chip size={28} disabled={pending} onClick={onReset}>
            Reset
          </Chip>
        </div>
      )}
    </div>
  );
}
