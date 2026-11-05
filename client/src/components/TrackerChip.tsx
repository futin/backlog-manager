import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { ServiceHead } from './ServiceHead';
import { Glyph } from './ui/Glyphs';
import { Popover } from './ui/Popover';
import { StatusPill } from './ui/StatusPill';
import { useTrackersContext } from '../hooks/TrackersContext';
import { useNow } from '../hooks/useNow';
import { useSweep } from '../hooks/useSweep';
import { useTimeZone } from '../hooks/TimeZoneContext';
import { TONE_WORD, fastestInterval, githubDown, newestAge, serviceTone } from '../lib/service-status';
import { accessReason, hasTracker, pollAge, resetClock } from '../lib/tracker';
import type { Section } from '../lib/sections';
import type { TrackerPlatform, TrackerProjectRow } from '../../../shared/types';

/**
 * The GitHub status pill (Shell mock, top right; spec §4.9) — a 28 px `StatusPill`: a dot whose colour is the service's state, the word `GitHub`, and how
 * long ago the newest repo was polled. Everything the old chip drew as numbers (the login, a POLL countdown, an API meter) moved into the popover, because a
 * poll age and an API budget are things you look up and not things you glance at; the pill keeps the one glanceable fact — alive or not, and how fresh.
 *
 * **In the shell, not in a section.** A connected tracker is a property of the machine: the token, the login, the hourly budget and the poll clock are the
 * same whichever section is open, so `App` renders this once, in the strip (or the rail bar below 700 px), from the shell's one `useTrackers`.
 *
 * **The button names the pill.** `StatusPill` is a span with no name of its own (the dot and word would otherwise be read twice), so this button carries
 * `GitHub: <on time|late|down>, <age>`. The name changes only when the state or the age rung does — a one-second tick moves a seconds age, and a screen
 * reader re-announces a focused element whose name changes, so the age is rounded to `pollAge`'s own ladder and is the only part that ticks.
 *
 * **The popover is `ui/Popover`'s, and so is its dismissal.** Escape and click-outside, and the phone shape, are there; what stays here is the section-change
 * close, which only this chip's host knows about, and the pill as `Popover`'s anchor, so a second click on it toggles the panel shut instead of racing the
 * outside-press listener. It carries two writes now: `Sync now` (every repo) and a sync icon per repo, both `POST /api/github/sweep`; and one link, to
 * GitHub › Settings, handed down as `onOpenSettings` because only the shell sets a section and its page as one pair.
 */
export function TrackerChip({ section, onOpenSettings }: { section: Section; onOpenSettings?: () => void }) {
  const { zone } = useTimeZone();
  const { data, reload } = useTrackersContext();
  const visible = data !== null && hasTracker(data.projects);
  // A one-second tick is what a seconds age needs, and it runs only while a tracker exists — a machine with no tracker pays for no interval.
  const now = useNow(visible, 1_000);
  const [open, setOpen] = useState(false);
  // The popover's anchor: a press on the pill is not "outside" it — the pill's own click toggles — so `Popover` is told which element that is.
  const button = useRef<HTMLButtonElement>(null);
  // The sweep state lives here and not in the popover, which unmounts on close: a sweep out when it closes must still read as out when it opens again.
  const sweep = useSweep('github', reload, zone, data);

  // The pill outlives every section; the popover has no reason to.
  useEffect(() => setOpen(false), [section]);

  if (!visible) return null;

  const githubRows = data.projects.filter((p) => p.source === 'github');
  const plat = data.platforms.find((p) => p.kind === 'github');
  const hasToken = plat !== undefined && plat.hasToken;
  // `limited` reads the rows' own access, never the platform's remaining count: a rate-limited repo is the poller's own report that it is waiting.
  const tone = serviceTone(
    { down: githubDown(hasToken, githubRows.map((r) => r.access)), rows: githubRows, limited: githubRows.some((r) => r.access === 'rate-limited') },
    now
  );
  const age = newestAge(githubRows, now);

  return (
    <div className="tracker-chip-root">
      <button
        ref={button}
        type="button"
        className="tracker-chip"
        data-testid="tracker-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`GitHub: ${TONE_WORD[tone]}${age === null ? '' : `, ${age}`}`}
        onClick={() => setOpen((o) => !o)}
      >
        <StatusPill tone={tone} word="GitHub" age={age} />
      </button>
      {open && (
        <TrackerPopover
          platform={hasToken ? plat : undefined}
          rows={githubRows}
          tone={tone}
          now={now}
          zone={zone}
          anchor={button}
          sweep={sweep}
          onOpenSettings={
            onOpenSettings === undefined
              ? undefined
              : () => {
                  setOpen(false);
                  onOpenSettings();
                }
          }
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The popover's content, a component of its own so that its `Popover` MOUNTS only while open — the shape `ui/Confirm` has, and the reason `Popover` can join
 * the Escape stack with a plain `useDialogEscape` call: mounted last, it is topmost; unmounted, the key goes back to whatever is under it.
 *
 * Rows are read off the live payload on every render, never copied into state when it opened, so a repo disconnected or a token removed while it is up
 * drops out of it on the next answer rather than lingering. A repo that answered something other than ok says why, in the access card's own words
 * (`accessReason`) — which is also where a sweep that returned 200 with a failure inside it shows its `detail`.
 */
function TrackerPopover({
  platform,
  rows,
  tone,
  now,
  zone,
  anchor,
  sweep,
  onOpenSettings,
  onClose
}: {
  platform: TrackerPlatform | undefined;
  rows: TrackerProjectRow[];
  tone: ReturnType<typeof serviceTone>;
  now: number;
  zone: string;
  anchor: RefObject<HTMLElement>;
  sweep: ReturnType<typeof useSweep>;
  onOpenSettings: (() => void) | undefined;
  onClose: () => void;
}) {
  const busy = sweep.pending !== null;
  const interval = fastestInterval(rows);
  const last = newestAge(rows, now);
  const login = platform === undefined ? null : platform.login;
  return (
    // 330 px, the mock's: the rows are a name over `polled 12 s ago` and an icon, which need no timer column any more. The look, the 8 px drop, the phone
    // shape and both dismissals are `Popover`'s.
    <Popover label="Tracker" width={330} anchor={anchor} onClose={onClose}>
      <ServiceHead
        initial={platform === undefined ? '—' : (login?.[0]?.toUpperCase() ?? '·')}
        name={platform === undefined ? 'no token' : (login ?? 'token set')}
        tone={tone}
        status={tone === 'red' ? 'not connected · github.com' : 'connected · github.com'}
        busy={busy}
        disabledReason={platform === undefined ? 'no token' : sweep.blocked}
        notice={sweep.notice}
        onSync={() => sweep.run()}
        figures={[
          { label: 'Last sweep', value: `${last === null ? 'not yet' : `${last} ago`} · ${interval === 'off' ? 'sync off' : `every ${interval}`}` },
          {
            label: 'Rate limit',
            value:
              platform === undefined || platform.limit === null || platform.remaining === null
                ? '—'
                : `${platform.remaining.toLocaleString()} of ${platform.limit.toLocaleString()}${platform.reset === null ? '' : ` · resets ${resetClock(platform.reset, zone)}`}`
          }
        ]}
      />
      {platform === undefined ? (
        // The same fix `accessReason` and the Settings card name, so the operator reads one instruction wherever they meet the state.
        <p className="tracker-pop-note">
          No token on this machine. Put <code>BM_GITHUB_TOKEN</code> in <code>.env</code> and restart the stack.
        </p>
      ) : (
        rows.map((row) => {
          const off = row.interval === 'off';
          const reason = accessReason(row);
          const name = row.repo ?? row.name;
          const polled = pollAge(row.polledAt, now);
          const mine = sweep.pending === name;
          return (
            <div className="tracker-row" data-testid="tracker-row" key={row.path}>
              <span className="tracker-row-text">
                <span className="tracker-row-name">{row.name}</span>
                {row.repo !== null && <span className="tracker-row-repo">{row.repo}</span>}
                <span className="tracker-row-line">
                  {mine ? 'syncing…' : polled === null ? 'not polled yet' : `polled ${polled} ago`}
                  {off ? ' · sync off' : ''}
                </span>
                {reason !== null && <span className="tracker-row-line jira-setup-failure">{reason}</span>}
              </span>
              <button
                type="button"
                className="tracker-sync"
                aria-label={`Sync ${name}`}
                title={off ? 'sync is off' : (sweep.blocked ?? `Sync ${name} now`)}
                disabled={off || busy || sweep.blocked !== null}
                onClick={() => sweep.run(name)}
              >
                <Glyph name="refresh" />
              </button>
            </div>
          );
        })
      )}
      {onOpenSettings !== undefined && (
        <button type="button" className="tracker-link" onClick={onOpenSettings}>
          GitHub page
          <Glyph name="external" />
        </button>
      )}
    </Popover>
  );
}
