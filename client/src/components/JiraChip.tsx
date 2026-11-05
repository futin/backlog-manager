import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { Chevron } from './ui/Chevron';
import { Chip } from './ui/Chip';
import { Meter } from './ui/Meter';
import { Popover } from './ui/Popover';
import { useJiraContext } from '../hooks/JiraContext';
import { useNow } from '../hooks/useNow';
import { errorOf, postJson } from '../lib/http';
import { accessPhrase, boardPollReading, boardsByName, callsReading, failurePhrase, jiraPollReading, polledPhrase, sweepLine } from '../lib/jira';
import type { Section } from '../lib/sections';
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
 * **One initial.** The first letter of `me.name`, `?` while `me` is null — the same shape `TrackerChip` has for a login. `initialsOf`'s two letters are
 * the board CARD's reading and belong nowhere else.
 *
 * **Name versus description (#230), as `TrackerChip` does.** The accessible name is `Jira: <full name>` and never moves; the meters' readings change every
 * second and ride as the DESCRIPTION, which a screen reader reads on focus and does not re-speak on change.
 *
 * **No links in the popover, and one kind of button: a board's `now`.** The rail's tree is the only thing that switches sections or pages, so a `Setup ›`
 * link here would be the in-page switch that rule forbids; the Setup page is one rail click away. A `now` switches nothing — it asks the server to sweep
 * that one board (`POST /api/jira/boards/sweep`), the dashboard's sync row carried over — so it is not what the rule is about. Its copy for the access
 * failure and the last sweep comes from `accessPhrase` and `sweepLine`, the Connection card's own two functions, so the two surfaces cannot word one fact
 * two ways.
 *
 * **The in-flight sweeps live here, not in the popover.** Closing the popover mid-sweep and opening it again must still say `syncing…`, and the popover
 * unmounts on close. `sweeping` is the set of board ids whose `now` is out — a ref guards the double click the state cannot (`useAction`'s reason), and it
 * is a set rather than `useAction`'s one slot because two boards' sweeps are independent: the server serialises them itself (`boardSaved` waits for the
 * sweep in flight). When the answer lands the shell's status is re-read, which moves this row's age and meter and — through `useJiraBoard`'s `polledAt`
 * watch — the Board page's cards. A refusal is kept per board and drawn red in that row until its next `now`.
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

  const { reload } = useJiraContext();
  const [sweeping, setSweeping] = useState<ReadonlySet<string>>(() => new Set());
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(() => new Map());
  const out = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const sweep = useCallback(
    (id: string): void => {
      if (out.current.has(id)) return;
      out.current.add(id);
      setSweeping(new Set(out.current));
      setRefused((prev) => without(prev, id));
      postJson('/api/jira/boards/sweep', { id })
        .then(
          (answer) => {
            if (!answer.ok && mounted.current) setRefused((prev) => new Map(prev).set(id, errorOf(answer.body, `sweep failed (${answer.status})`)));
          },
          () => {
            if (mounted.current) setRefused((prev) => new Map(prev).set(id, 'API unreachable'));
          }
        )
        .finally(() => {
          out.current.delete(id);
          if (!mounted.current) return;
          setSweeping(new Set(out.current));
          reload();
        });
    },
    [reload]
  );

  // The chip outlives every section; the popover has no reason to.
  useEffect(() => setOpen(false), [section]);

  if (!visible) return null;

  const name = data.me?.name.trim() ?? '';
  const initial = initialOf(name);
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
          <Meter label="POLL" {...jiraPollReading(data.boards, now)} />{' '}
          <Meter label="CALLS" value={String(data.calls.sweep)} fraction={calls.fraction} tone={calls.red ? 'red' : 'green'} />
        </span>
        <Chevron dir={open ? 'up' : 'down'} className="tracker-caret" />
      </button>
      {open && (
        <JiraPopover data={data} now={now} anchor={button} sweeping={sweeping} refused={refused} onSweep={sweep} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/** The one initial — the first letter of the (trimmed) name, `?` for none — in one place for the chip and its popover. */
const initialOf = (name: string): string => (name === '' ? '?' : name.charAt(0).toUpperCase());

/** A copy of `map` without `key` — the same map back when it holds no such key, so a `now` on a board that was never refused re-renders nothing. */
function without(map: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/**
 * The popover's content, a component of its own so its `Popover` MOUNTS only while open — `TrackerPopover`'s shape and its reason: mounted last it is
 * topmost on the Escape stack, unmounted the key goes back to whatever is under it. Everything is read off the live payload on every render, so a board
 * deleted or a site that recovers while it is up changes on the next answer.
 */
function JiraPopover({
  data,
  now,
  anchor,
  sweeping,
  refused,
  onSweep,
  onClose
}: {
  data: JiraStatusPayload;
  now: number;
  anchor: RefObject<HTMLElement>;
  sweeping: ReadonlySet<string>;
  refused: ReadonlyMap<string, string>;
  onSweep: (id: string) => void;
  onClose: () => void;
}) {
  const name = data.me?.name.trim() ?? '';
  const sweep = sweepLine(data.armed, data.calls, now);
  const access = accessPhrase(data.access);

  return (
    <Popover label="Jira" width={420} anchor={anchor} onClose={onClose}>
      <div className="tracker-pop-id">
        <span className="tracker-av">{initialOf(name)}</span>
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
      {boardsByName(data.boards).map((board) => {
        const off = board.interval === 'off';
        const failure = failurePhrase(board.failures);
        const refusal = refused.get(board.id) ?? null;
        const busy = sweeping.has(board.id);
        return (
          <div className="tracker-row jira-chip-board" data-testid="jira-chip-board" key={board.id}>
            <span className="tracker-row-text">
              <span className="tracker-row-name">{board.name}</span>
              {/* `polled 12 s ago · every 5m`, then Jira's message and a refused `now` in red. The sub-line WRAPS rather than truncating
                  (`.tracker-row-name` ellipsises, right for a name and wrong for a sentence), because the failure is the piece a person can act on. */}
              <span className="jira-chip-board-line">
                {polledPhrase(board.polledAt, now, off)} · {off ? 'sync off' : `every ${board.interval}`}
                {failure !== null && (
                  <>
                    {' · '}
                    <span className="jira-setup-failure">{failure}</span>
                  </>
                )}
                {refusal !== null && (
                  <>
                    {' · '}
                    <span className="jira-setup-failure">{refusal}</span>
                  </>
                )}
              </span>
            </span>
            <Meter label="next" width={120} {...boardPollReading(board, now, busy)} />
            <Chip size={28} disabled={busy} onClick={() => onSweep(board.id)} aria-label={`Sweep ${board.name} now`}>
              now
            </Chip>
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
