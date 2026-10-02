import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { Meter } from './ui/Meter';
import { Popover } from './ui/Popover';
import { useTrackersContext } from '../hooks/TrackersContext';
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
 * **The panel is `ui/Popover`'s, and so is its dismissal.** Escape and click-outside, and the phone shape that escapes the rail bar's clip,
 * moved there when the band's Filters and Sort wanted the same panel: a second copy of any of them is how two panels come to behave differently. What
 * stays here is the section-change close, which only this chip's host knows about, and the chip button as `Popover`'s anchor, so a second click on it
 * toggles the panel shut instead of racing the outside-press listener.
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
  // The popover's anchor: a press on the chip is not "outside" it — the chip's own click toggles — so `Popover` is told which element that is.
  const button = useRef<HTMLButtonElement>(null);
  const metersId = useId();

  // The chip outlives every section; the popover has no reason to.
  useEffect(() => setOpen(false), [section]);

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
    <div className="tracker-chip-root">
      {/* Name versus description (#230). The name stays `Tracker: <login>` and never moves, because a screen reader re-announces a focused element whose
          name changes and the POLL countdown changes every second — a name built from the meters would be spoken once a second for as long as the chip held
          focus. The readings ride as the DESCRIPTION instead, which is read on focus and not re-spoken on change. A no-token chip has no meters, so it
          carries no `aria-describedby` at all rather than one pointing at nothing. */}
      <button
        ref={button}
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
      {open && <TrackerPopover platform={noToken ? undefined : plat} rows={githubRows} now={now} anchor={button} onClose={() => setOpen(false)} />}
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
 * The popover's content, a component of its own so that its `Popover` MOUNTS only while open — the shape `ui/Confirm` has, and the reason `Popover` can join
 * the Escape stack with a plain `useDialogEscape` call: mounted last, it is topmost; unmounted, the key goes back to whatever is under it.
 *
 * Rows are read off the live payload on every render, never copied into state when it opened, so a repo disconnected or a token removed while it is up
 * drops out of it on the next answer rather than lingering.
 */
function TrackerPopover({
  platform,
  rows,
  now,
  anchor,
  onClose
}: {
  platform: TrackerPlatform | undefined;
  rows: TrackerProjectRow[];
  now: number;
  anchor: RefObject<HTMLElement>;
  onClose: () => void;
}) {
  const usage = platform === undefined ? null : apiUsage(platform);
  const connected = `GitHub · ${rows.length} ${rows.length === 1 ? 'repo' : 'repos'} connected`;

  return (
    // 420 px, not the dashboard's 372: a repo name, a 120 px timer and its seconds do not fit 372 without wrapping. This number is the only thing the tracker
    // asks of the panel — the look, the 8 px drop, the phone shape and both dismissals are `Popover`'s.
    <Popover label="Tracker" width={420} anchor={anchor} onClose={onClose}>
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
    </Popover>
  );
}
