import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { ServiceHead } from './ServiceHead';
import { Glyph } from './ui/Glyphs';
import { Popover } from './ui/Popover';
import { StatusPill } from './ui/StatusPill';
import { useJiraContext } from '../hooks/JiraContext';
import { useNow } from '../hooks/useNow';
import { useSweep } from '../hooks/useSweep';
import { useTimeZone } from '../hooks/TimeZoneContext';
import { errorOf, postJson } from '../lib/http';
import { accessPhrase, boardsByName, failurePhrase, initialsOf, polledPhrase } from '../lib/jira';
import { TONE_WORD, fastestInterval, jiraDown, newestAge, serviceTone } from '../lib/service-status';
import { pollAge } from '../lib/tracker';
import type { JiraPage } from '../lib/jira-page';
import type { Section } from '../lib/sections';
import type { JiraBoardStatus, JiraStatusPayload } from '../../../shared/types';

/**
 * The Jira status pill (Shell mock, top right; spec §4.9) — `TrackerChip`'s sibling: a 28 px `StatusPill` (dot, `Jira`, the newest board's poll age) in a
 * button that names it `Jira: <on time|late|down>` (no age: it ticks every second under a minute, and a changing name is re-announced, #230), and a popover whose head is `ServiceHead` (the same head, so the two cannot disagree about
 * where focus lands or what `Sync now` does). It wears `TrackerChip`'s classes (`.tracker-chip*`, `.tracker-av`, `.tracker-pop-*`, `.tracker-row*`): the look
 * is one look. What differs is the testid, `.jira-setup-failure` for red copy (the Setup page's own class) and `.jira-chip-board`/`-line`, the board row.
 *
 * **In the shell, from the shell's one `useJira`.** A configured Jira site is a property of the machine, as the GitHub token is, so `App` renders this once
 * beside `TrackerChip` — in the strip at desktop width, in the rail bar's `chipSlot` below 700 px, never both and never one hidden by CSS (two mounted chips
 * would be two one-second clocks and two popovers able to join the Escape stack). It is drawn only while `configured` is true.
 *
 * **Two writes, one of each kind.** `Sync now` is site-wide (`POST /api/jira/sweep`, through `useSweep`) and a 429 there reads `Jira asked to wait until
 * HH:MM`. A board's sync icon keeps #472's own callback, `POST /api/jira/boards/sweep { id }`, which is NOT refused in a 429 window or while the poller is
 * idle — a manual-only (`off`) board is the one an icon exists for — so a row stays enabled when `Sync now` is blocked. The link is `Jira setup` → Jira ›
 * Setup, handed down as `onOpenSetup` because only the shell sets a section and its page as one pair.
 *
 * **The in-flight board sweeps live here, not in the popover.** Closing the popover mid-sweep and opening it again must still say `syncing…`, and the popover
 * unmounts on close. `sweeping` is the set of board ids whose icon is out — a ref guards the double click the state cannot (`useAction`'s reason), and it
 * is a set rather than `useAction`'s one slot because two boards' sweeps are independent: the server serialises them itself (`boardSaved` waits for the
 * sweep in flight). When the answer lands the shell's status is re-read, which moves this row's age and — through `useJiraBoard`'s `polledAt` watch — the
 * Board page's cards. A refusal is kept per board and drawn red in that row until its next sync.
 */
export function JiraChip({ section, onOpenSetup }: { section: Section; onOpenSetup?: (page: JiraPage) => void }) {
  const { data } = useJiraContext();
  const visible = data !== null && data.configured;
  // A one-second tick is what a seconds readout needs, and it runs only while Jira is configured.
  const now = useNow(visible, 1_000);
  const [open, setOpen] = useState(false);
  // The popover's anchor: a press on the pill is not "outside" it — the pill's own click toggles — so `Popover` is told which element that is.
  const button = useRef<HTMLButtonElement>(null);

  const { reload } = useJiraContext();
  const { zone } = useTimeZone();
  const site = useSweep('jira', reload, zone, data);
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

  const tone = serviceTone({ down: jiraDown(data.access), rows: data.boards, limited: data.access === 'rate-limited' }, now);
  const age = newestAge(data.boards, now);

  return (
    <div className="tracker-chip-root">
      <button
        ref={button}
        type="button"
        className="tracker-chip"
        data-testid="jira-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Jira: ${TONE_WORD[tone]}`}
        onClick={() => setOpen((o) => !o)}
      >
        <StatusPill tone={tone} word="Jira" age={age} />
      </button>
      {open && (
        <JiraPopover
          data={data}
          tone={tone}
          now={now}
          anchor={button}
          site={site}
          sweeping={sweeping}
          refused={refused}
          onSweep={sweep}
          onOpenSetup={
            onOpenSetup === undefined
              ? undefined
              : () => {
                  setOpen(false);
                  onOpenSetup('setup');
                }
          }
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

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
  tone,
  now,
  anchor,
  site,
  sweeping,
  refused,
  onSweep,
  onOpenSetup,
  onClose
}: {
  data: JiraStatusPayload;
  tone: ReturnType<typeof serviceTone>;
  now: number;
  anchor: RefObject<HTMLElement>;
  site: ReturnType<typeof useSweep>;
  sweeping: ReadonlySet<string>;
  refused: ReadonlyMap<string, string>;
  onSweep: (id: string) => void;
  onOpenSetup: (() => void) | undefined;
  onClose: () => void;
}) {
  const name = data.me?.name.trim() ?? '';
  const access = accessPhrase(data.access);
  const last = newestAge(data.boards, now);
  const every = fastestInterval(data.boards);
  const last429 = pollAge(data.calls.last429At, now);

  return (
    <Popover label="Jira" width={330} anchor={anchor} onClose={onClose}>
      <ServiceHead
        initial={initialsOf(name)}
        name={name === '' ? 'no identity' : name}
        tone={tone}
        status={`${tone === 'red' ? 'not connected' : 'connected'} · ${data.site ?? 'no site'}`}
        busy={site.pending !== null}
        disabledReason={site.blocked}
        notice={site.notice}
        onSync={() => site.run()}
        figures={[
          { label: 'Last sweep', value: `${last === null ? 'not yet' : `${last} ago`} · ${!data.armed ? 'idle' : every === 'off' ? 'sync off' : 'every 15 s'}` },
          { label: 'Calls', value: `${data.calls.sweep} · ${last429 === null ? 'no 429 since start' : `last 429 ${last429} ago`}` }
        ]}
      />
      {access !== null && (
        // A site-wide sweep that answered 200 with a failure inside it lands here: the poller records `access` and `detail`, and this is where they are read.
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
              {/* `polled 12 s ago · every 5m`, then Jira's message and a refused sync in red. The sub-line WRAPS rather than truncating
                  (`.tracker-row-name` ellipsises, right for a name and wrong for a sentence), because the failure is the piece a person can act on. */}
              <span className="jira-chip-board-line">
                {busy ? 'syncing…' : polledPhrase(board.polledAt, now, off)} · {off ? 'sync off' : `every ${board.interval}`}
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
            <button type="button" className="tracker-sync" aria-label={`Sync ${board.name}`} title={`Sync ${board.name} now`} disabled={busy} onClick={() => onSweep(board.id)}>
              <Glyph name="refresh" />
            </button>
          </div>
        );
      })}
      {onOpenSetup !== undefined && (
        <button type="button" className="tracker-link" onClick={onOpenSetup}>
          Jira setup
          <Glyph name="external" />
        </button>
      )}
    </Popover>
  );
}
