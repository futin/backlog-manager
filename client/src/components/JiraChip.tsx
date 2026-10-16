import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { Chevron } from './ui/Chevron';
import { Meter } from './ui/Meter';
import { Popover } from './ui/Popover';
import { useJiraContext } from '../hooks/JiraContext';
import { useNow } from '../hooks/useNow';
import { accessPhrase, callsReading, failurePhrase, polledPhrase, soonestBoard, sweepLine } from '../lib/jira';
import type { Section } from '../lib/sections';
import { pollProgress } from '../lib/tracker';
import { SYNC_INTERVALS } from '../../../shared/types';
import type { JiraBoardStatus, JiraStatusPayload } from '../../../shared/types';

/**
 * The Jira chip (.claude/DESIGN.md §8.9.4, on §8.0's shell strip; Jira phase 2 spec §6.5) — an initial, `Jira · <first name>`, a `POLL` meter counting down to
 * the soonest board's next sweep, a `CALLS` meter for the last tick's spend, and a read-only popover. It is `TrackerChip`'s sibling and wears its classes
 * (`.tracker-chip*`, `.tracker-av`, `.tracker-pip`, `.tracker-pop-*`): the look is one look, and a second family of rules for the same pill is how two chips
 * come to disagree. What differs is the testid, `.jira-setup-failure` for red copy (the Setup page's own class) and `.jira-chip-board`/`-line`, the one-line
 * board row, which has no timer column, which is what a suite (and a reader of the DOM) tells the two apart by.
 *
 * **In the shell, from the shell's one `useJira`.** A configured Jira site is a property of the machine, as the GitHub token is, so `App` renders this once
 * beside `TrackerChip` — in the strip at desktop width, in the rail bar's `chipSlot` below 700 px, never both and never one hidden by CSS (two mounted chips
 * would be two one-second clocks and two popovers able to join the Escape stack). It is drawn only while `configured` is true: an unconfigured machine pays
 * for no interval and sees no chip.
 *
 * **One initial (R10).** The first letter of `me.name`, `?` while `me` is null — the same shape `TrackerChip` has for a login. `initialsOf`'s two letters are
 * the board CARD's reading and belong nowhere else.
 *
 * **Name versus description (#230), as `TrackerChip` does.** The accessible name is `Jira: <full name>` and never moves; the meters' readings change every
 * second and ride as the DESCRIPTION, which a screen reader reads on focus and does not re-speak on change.
 *
 * **No links and no buttons in the popover.** The rail's tree is the only thing that switches sections or pages, so a `Setup ›` link here would be the in-page
 * switch that rule forbids. The popover is a reading; the Setup page is one rail click away. Its copy for the access failure and the last sweep comes from
 * `accessPhrase` and `sweepLine`, the Connection card's own two functions, so the two surfaces cannot word one fact two ways.
 */
export function JiraChip({ section }: { section: Section }) {
  const { data } = useJiraContext();
  const visible = data !== null && data.configured;
  // A one-second tick is what a seconds readout needs, and it runs only while Jira is configured.
  const now = useNow(visible, 1_000);
  const [open, setOpen] = useState(false);
  // The popover's anchor: a press on the chip is not "outside" it — the chip's own click toggles — so `Popover` is told which element that is.
  const button = useRef<HTMLButtonElement>(null);
  const metersId = useId();

  // The chip outlives every section; the popover has no reason to.
  useEffect(() => setOpen(false), [section]);

  if (!visible) return null;

  const name = data.me?.name.trim() ?? '';
  const initial = name === '' ? '?' : name.charAt(0).toUpperCase();
  const first = name.split(/\s+/)[0];
  const calls = callsReading(data.calls, now);

  return (
    <div className="tracker-chip-root">
      <button
        ref={button}
        type="button"
        className="tracker-chip"
        data-testid="jira-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={name === '' ? 'Jira' : `Jira: ${name}`}
        aria-describedby={metersId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tracker-av">
          {initial}
          {/* One state, not two: Jira has no `no token` amber, because the chip is not drawn at all without credentials. Red is any access but `ok`. */}
          {data.access !== 'ok' && <span className="tracker-pip" data-testid="jira-pip" data-tone="red" />}
        </span>
        <span className="tracker-name">{first === '' ? 'Jira' : `Jira · ${first}`}</span>
        <span className="tracker-meters" id={metersId}>
          {/* The space keeps the description `POLL 12s CALLS 12` rather than `…12sCALLS…`; `.tracker-meters` is flex, so it renders as nothing. */}
          <Meter label="POLL" {...pollReading(data.boards, now)} />{' '}
          <Meter label="CALLS" value={String(data.calls.sweep)} fraction={calls.fraction} tone={calls.red ? 'red' : 'green'} />
        </span>
        <Chevron dir={open ? 'up' : 'down'} className="tracker-caret" />
      </button>
      {open && <JiraPopover data={data} now={now} anchor={button} onClose={() => setOpen(false)} />}
    </div>
  );
}

type Reading = { value: string; fraction: number | null; tone: 'green' | 'amber' | 'red' };

/**
 * The chip's POLL reading: `pollProgress` on the soonest syncing board's own interval (`SYNC_INTERVALS`, not the GitHub cycle — Jira has no slack constant to
 * add, and a board is restamped at its interval). An empty bar with no syncing board — `—` when there are no boards at all, `sync off` (amber, the state
 * `TrackerChip` names the same way) when every board is off — and `…` before the soonest one has polled, an empty bar because nothing has been read yet.
 * `overdue` is a full amber bar after two silent intervals, `pollProgress`' own threshold.
 */
function pollReading(boards: readonly JiraBoardStatus[], now: number): Reading {
  const soonest = soonestBoard(boards, now);
  if (soonest === null) return boards.length === 0 ? { value: '—', fraction: null, tone: 'green' } : { value: 'sync off', fraction: null, tone: 'amber' };
  const interval = SYNC_INTERVALS[soonest.interval];
  const progress = interval === null ? null : pollProgress(soonest.polledAt, now, interval);
  if (progress === null) return { value: '…', fraction: null, tone: 'green' };
  if (progress.overdue) return { value: 'overdue', fraction: 1, tone: 'amber' };
  return { value: `${progress.leftS}s`, fraction: progress.fraction, tone: 'green' };
}

/**
 * The popover's content, a component of its own so its `Popover` MOUNTS only while open — `TrackerPopover`'s shape and its reason: mounted last it is
 * topmost on the Escape stack, unmounted the key goes back to whatever is under it. Everything is read off the live payload on every render, so a board
 * deleted or a site that recovers while it is up changes on the next answer.
 */
function JiraPopover({ data, now, anchor, onClose }: { data: JiraStatusPayload; now: number; anchor: RefObject<HTMLElement>; onClose: () => void }) {
  const name = data.me?.name.trim() ?? '';
  const sweep = sweepLine(data.armed, data.calls, now);
  const access = accessPhrase(data.access);

  return (
    <Popover label="Jira" width={420} anchor={anchor} onClose={onClose}>
      <div className="tracker-pop-id">
        <span className="tracker-av">{name === '' ? '?' : name.charAt(0).toUpperCase()}</span>
        <span className="tracker-pop-who">
          <span className="tracker-name">{name === '' ? 'no identity' : name}</span>
          <span className="tracker-pop-sub">{data.site}</span>
        </span>
      </div>
      {access !== null && (
        <p className="tracker-pop-note">
          <span className="jira-setup-failure">{access}</span>
          {data.detail ? ` · ${data.detail}` : ''}
        </p>
      )}
      {data.boards.map((board) => {
        const failure = failurePhrase(board.failures);
        return (
          <div className="tracker-row jira-chip-board" data-testid="jira-chip-board" key={board.id}>
            <span className="tracker-row-text">
              {/* One line, `Platform · polled 12 s ago · <Jira's message>`: the failure in red is the piece a person can act on, so the line WRAPS
                  rather than truncating it (`.tracker-row-name` ellipsises, which is right for a repo name and wrong for a sentence). */}
              <span className="jira-chip-board-line">
                {board.name} · {polledPhrase(board.polledAt, now, board.interval === 'off')}
                {failure !== null && (
                  <>
                    {' · '}
                    <span className="jira-setup-failure">{failure}</span>
                  </>
                )}
              </span>
            </span>
          </div>
        );
      })}
      <div className="tracker-pop-api">
        <span className="tracker-pop-api-line">{sweep.lead}</span>
        <span className={sweep.red ? 'tracker-pop-api-line jira-setup-failure' : 'tracker-pop-api-line'}>{sweep.rate}</span>
      </div>
    </Popover>
  );
}
