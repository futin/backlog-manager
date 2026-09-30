import { useEffect, useId, useRef, useState } from 'react';

import { Meter } from './ui/Meter';
import { useTrackersContext } from '../hooks/TrackersContext';
import { useDialogEscape } from '../hooks/useDialogEscape';
import { useNow } from '../hooks/useNow';
import { accessReason, apiUsage, hasTracker, pollProgress, sweepProgress, syncCycleMs } from '../lib/tracker';
import type { Section } from '../lib/sections';
import type { TrackerPlatform, TrackerProjectRow } from '../../../shared/types';

/**
 * The tracker chip (.claude/DESIGN.md §8.0's shell strip; the tracker strip spec, §2) — login, a `POLL` line timer counting down to the server's next
 * sweep, an `API` usage meter, and a read-only popover with one timer per connected repo.
 *
 * **In the shell, not in a section.** A connected tracker is a property of the machine: the token, the login, the hourly budget and the poll clock are the
 * same whichever section is open. The dashboard's rule for its account header applies — what is true of the machine wherever you stand moves out of the
 * section and into the shell — so `App` renders this once, in the strip (or the rail bar below 700 px), from the shell's one `useTrackers`.
 *
 * **Dismissal has two owners on purpose.** Escape goes through `useDialogEscape`, which `TrackerPopover` calls while it is mounted, exactly as `ui/Confirm`
 * does: the stack is the only Escape listener in the client, so a popover opened over an item modal takes the key from the modal and hands it back. Click-
 * outside is this component's own `pointerdown` listener, because the stack owns a KEY, not the pointer — the dashboard's `useDismiss` bundles the two and
 * is exactly what must not be copied here.
 *
 * **No links and no buttons in the popover.** The rail's sub-nav tree is the only thing that switches sections or Settings' pages, and a "Trackers ›" link
 * here would be the in-page switch that rule forbids. The popover is a reading; the Settings card is one rail click away.
 */
export function TrackerChip({ section }: { section: Section }) {
  const { data } = useTrackersContext();
  const visible = data !== null && hasTracker(data.projects);
  // A one-second tick is what a seconds readout needs, and it runs only while a tracker exists — a machine with no tracker pays for no interval.
  const now = useNow(visible, 1_000);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const metersId = useId();

  // The chip outlives every section; the popover has no reason to.
  useEffect(() => setOpen(false), [section]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  if (!visible) return null;

  const githubRows = data.projects.filter((p) => p.source === 'github');
  const plat = data.platforms.find((p) => p.kind === 'github');
  const noToken = plat === undefined || !plat.hasToken;
  const login = noToken ? 'no token' : (plat.login ?? 'token set');
  const initial = noToken ? '—' : (plat.login?.[0]?.toUpperCase() ?? '·');
  // The no-token state reads `hasToken`, never `access`: a stale payload can say every row is `no-token` while the platform already has one, and the
  // pip must say which fix is still owed. `access` is what the red pip reads.
  const pip = noToken ? 'amber' : githubRows.some((r) => r.access !== 'ok') ? 'red' : null;
  const usage = noToken ? null : apiUsage(plat);

  return (
    <div className="tracker-chip-root" ref={root}>
      {/* Name versus description (#230). The name stays `Tracker: <login>` and never moves, because a screen reader re-announces a focused element whose
          name changes and the POLL countdown changes every second — a name built from the meters would be spoken once a second for as long as the chip held
          focus. The readings ride as the DESCRIPTION instead, which is read on focus and not re-spoken on change. A no-token chip has no meters, so it
          carries no `aria-describedby` at all rather than one pointing at nothing. */}
      <button
        type="button"
        className="tracker-chip"
        data-testid="tracker-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Tracker: ${login}`}
        aria-describedby={noToken ? undefined : metersId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tracker-av">
          {initial}
          {pip !== null && <span className="tracker-pip" data-testid="tracker-pip" data-tone={pip} />}
        </span>
        <span className="tracker-name">{login}</span>
        {!noToken && (
          <span className="tracker-meters" id={metersId}>
            {/* The space keeps the description `POLL 12s API 1.4%` rather than `…12sAPI…`; `.tracker-meters` is flex, so it renders as nothing. */}
            <Meter label="POLL" {...sweepReading(githubRows, now)} />{' '}
            {usage !== null && <Meter label="API" value={usage.label} fraction={usage.fraction} tone={usageTone(usage.fraction)} />}
          </span>
        )}
        <span className="tracker-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && <TrackerPopover platform={noToken ? undefined : plat} rows={githubRows} now={now} onClose={() => setOpen(false)} />}
    </div>
  );
}

type Reading = { value: string; fraction: number | null; tone: 'green' | 'amber' | 'red' };

/**
 * The chip's POLL reading, in precedence order. `failing` beats the clock when EVERY repo is failing — no poll can succeed, so a countdown would promise a
 * sweep that will not land. `…` before the first poll: an empty bar, not a full one, because nothing has been read yet. `overdue` is a full amber bar
 * after two silent cycles (`pollProgress`' own threshold).
 *
 * `sync off` comes first, and only when EVERY repo is off (#17): nothing is being polled, so neither a countdown nor `failing` would be true, and amber
 * because it is a state writes are refused in, not a neutral one. Otherwise off repos drop out of both remaining readings — a repo nobody polls cannot be
 * failing now, and its stamp says when sync stopped, not when the next sweep lands.
 */
function sweepReading(rows: TrackerProjectRow[], now: number): Reading {
  const live = rows.filter((r) => r.interval !== 'off');
  if (live.length === 0) return { value: 'sync off', fraction: null, tone: 'amber' };
  if (live.every((r) => r.access !== 'ok')) return { value: 'failing', fraction: 1, tone: 'red' };
  const sweep = sweepProgress(rows, now);
  if (sweep === null) return { value: '…', fraction: null, tone: 'green' };
  if (sweep.overdue) return { value: 'overdue', fraction: 1, tone: 'amber' };
  return { value: `${sweep.leftS}s`, fraction: sweep.fraction, tone: 'green' };
}

/** One repo's line timer in the popover — `sweepReading`'s rules for one row, with the access sentence in place of `failing`, on the row's own interval
 *  (#17), and `sync off` for a repo this machine no longer polls — before the access reason, which describes a poll that is no longer being made. */
function rowReading(row: TrackerProjectRow, now: number): Reading {
  const cycle = syncCycleMs(row.interval);
  if (cycle === null) return { value: 'sync off', fraction: null, tone: 'amber' };
  const reason = accessReason(row);
  if (reason !== null) return { value: reason, fraction: 1, tone: 'red' };
  const p = pollProgress(row.polledAt, now, cycle);
  if (p === null) return { value: 'connecting…', fraction: null, tone: 'green' };
  if (p.overdue) return { value: 'overdue', fraction: 1, tone: 'amber' };
  return { value: `${p.leftS}s`, fraction: p.fraction, tone: 'green' };
}

/** The dashboard's budget ramp: amber from 60 %, red from 90 %. */
function usageTone(fraction: number): Reading['tone'] {
  return fraction >= 0.9 ? 'red' : fraction >= 0.6 ? 'amber' : 'green';
}

/**
 * The popover itself, a component of its own so that it MOUNTS only while open — the shape `ui/Confirm` has, and the reason it can join the Escape stack
 * with a plain `useDialogEscape` call: mounted last, it is topmost; unmounted, the key goes back to whatever is under it.
 *
 * Rows are read off the live payload on every render, never copied into state when it opened, so a repo disconnected or a token removed while it is up
 * drops out of it on the next answer rather than lingering.
 */
function TrackerPopover({
  platform,
  rows,
  now,
  onClose
}: {
  platform: TrackerPlatform | undefined;
  rows: TrackerProjectRow[];
  now: number;
  onClose: () => void;
}) {
  useDialogEscape(onClose);
  const usage = platform === undefined ? null : apiUsage(platform);
  const connected = `GitHub · ${rows.length} ${rows.length === 1 ? 'repo' : 'repos'} connected`;

  return (
    <div className="tracker-pop" role="dialog" aria-label="Tracker" data-testid="tracker-pop">
      <div className="tracker-pop-id">
        <span className="tracker-av">{platform === undefined ? '—' : (platform.login?.[0]?.toUpperCase() ?? '·')}</span>
        <span className="tracker-pop-who">
          <span className="tracker-name">{platform === undefined ? 'no token' : (platform.login ?? 'token set')}</span>
          <span className="tracker-pop-sub">{connected}</span>
        </span>
      </div>
      {platform === undefined ? (
        // The same fix `accessReason` and the Settings card name, so the operator reads one instruction wherever they meet the state.
        <p className="tracker-pop-note">
          No token on this machine. Put <code>BM_GITHUB_TOKEN</code> in <code>.env</code> and restart the stack.
        </p>
      ) : (
        <>
          {rows.map((row) => (
            <div className="tracker-row" data-testid="tracker-row" key={row.path}>
              <span className="tracker-row-text">
                <span className="tracker-row-name">{row.name}</span>
                {row.repo !== null && <span className="tracker-row-repo">{row.repo}</span>}
              </span>
              <Meter label="next" width={120} {...rowReading(row, now)} />
            </div>
          ))}
          {usage !== null && (
            <div className="tracker-pop-api">
              <Meter label="API" value={usage.label} fraction={usage.fraction} tone={usageTone(usage.fraction)} width="fill" />
              <span className="tracker-pop-api-line">
                {`${usage.left.toLocaleString()} of ${(platform.limit ?? 0).toLocaleString()} left`}
                {usage.resetsAt !== null && ` · resets ${usage.resetsAt}`}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
