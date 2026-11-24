import { useRef, useState, type ReactNode } from 'react';

import { initialsOf, statusTone } from '../../lib/jira';
import type { StripAgent, StripPill } from '../../lib/jira-strip';
import type { DeliveryTone } from '../../lib/delivery';
import { sessionTone } from '../../lib/tones';
import type { JiraIssue, JiraTransition } from '../../../../shared/types';
import { Chevron } from '../ui/Chevron';
import { Chip } from '../ui/Chip';
import { Popover } from '../ui/Popover';
import { useMentionIndex } from '../../hooks/JiraMentionsContext';
import { JiraMentionMarkFor } from './JiraMentionMarkFor';
import { JiraMoveRows } from './JiraMoveRows';
import { useOpenMention } from './MentionOpenContext';

/**
 * What the strip's Delivery cell draws, already read: the target pills and their fold, one grey word for a ticket whose delivery is known to be empty
 * (`no MR`) or not yet trustworthy (`unknown`, titled with the Delivery pane's own sentence), or `null` — no cell at all — when the Delivery tab is not
 * drawn either (spec §1.2: the cell and the tab share one condition, so the strip never points at a tab that is not there).
 */
export type StripDeliveryCell =
  | { pills: StripPill[]; more: { count: number; tone: DeliveryTone } | null }
  | { word: 'no MR' | 'unknown'; title: string | null }
  | null;

/**
 * JiraTicketStrip — the Detail body's summary strip (Jira detail tabs spec §1.2; DESIGN.md §8.9.2): one `--strip` band of label-over-value cells under the
 * heading, wrapping on a narrow frame, drawn the same on every tab and in both frames. It is the anti-goal's answer — "a tab that hides an alarm" — so the
 * things a reader must not miss (a failed pipeline, findings to fix, a session waiting on an answer) sit here and not only in the tab that details them.
 *
 * **It holds the two writes, not their plumbing.** The Status chip IS today's `Move to` control and `Assign to me` keeps today's rules and titles — both moved
 * here from the facts pane, because the facts they change (Status, Assignee) moved here. The write itself, its one `useAction` guard and the error line under
 * the strip stay the body's (`JiraTicketBody`): the strip only says which was asked for, so the guard still spans every write the body sends, Stop and Unlink
 * included. The `Move to` panel's open state is the one piece of state here — it is this chip's, and nothing outside it reads it.
 *
 * **The `@ N` mention mark** (DESIGN.md §8.9.7; Jira mentions <-> board link, Task 5): the last cell, `Mentions`, after Agent, drawn only when the mark will be
 * (the index holds the key and an opener exists), so an empty cell never shows. It is a `JiraMentionMarkFor`; a press on it is stopped inside `MentionMark`,
 * and `JiraView` answers it by swapping Detail for the mention modal — the strip sits INSIDE Detail, so the press never also opens it.
 *
 * **The Delivery and Agent cells are read, not derived, here.** `stripDelivery` and `stripAgent` (`lib/jira-strip.ts`) choose the pills, their order and
 * their words; this file draws them. A target pill's click hands its row id (`<project>\u0000<target>`) to `onDelivery`, which selects the Delivery tab and
 * records the row to open; `+N` selects the tab alone. The live Agent pill selects the Agent tab; an idle cell is a sentence, not a control.
 */
export function JiraTicketStrip({
  src,
  busy,
  transitions,
  moveBlock,
  onMove,
  assignBlock,
  onAssign,
  parentLink,
  delivery,
  agent,
  onDelivery,
  onAgent
}: {
  /** The issue as drawn — the detail's copy once it lands, the card's until then. */
  src: JiraIssue;
  /** A write is out: every write control here is disabled, the rendering half of the body's one guard. */
  busy: boolean;
  /** The detail's transitions, or `null` while it has not landed (the chip is disabled until it has). */
  transitions: JiraTransition[] | null;
  moveBlock: string | null;
  onMove: (transitionId: string) => void;
  assignBlock: string | null;
  onAssign: () => void;
  /** The body's one parent link element (the walk push), or `null` for a ticket with no parent — the cell is then not drawn. */
  parentLink: ReactNode;
  delivery: StripDeliveryCell;
  agent: StripAgent;
  /** A Delivery pill's click: the row id to open, or `null` for `+N`, which only selects the tab. */
  onDelivery: (row: string | null) => void;
  onAgent: () => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const moveChip = useRef<HTMLButtonElement>(null);
  // The Mentions cell is drawn only when its mark will be: the index holds the key AND something above can open the modal, so an empty cell never shows.
  // Both hooks run on every render: a `&&` between the calls would skip the second one whenever the key has no entry.
  const mentionIndex = useMentionIndex();
  const openMention = useOpenMention();
  const mentioned = mentionIndex.has(src.key) && openMention !== null;
  const moveReady = transitions !== null && transitions.length > 0;

  return (
    <dl className="jira-strip" role="group" aria-label="Summary">
      <Cell label="Status">
        <span className="jira-detail-status">
          <Chip
            ref={moveChip}
            size={28}
            disabled={busy || !moveReady}
            title={moveBlock ?? undefined}
            aria-label="Move to"
            aria-haspopup="dialog"
            aria-expanded={moveOpen}
            onClick={() => setMoveOpen((o) => !o)}
          >
            <span className="jira-status-dot" data-tone={statusTone(src.status.category)} aria-hidden="true" />
            {src.status.name}
            <Chevron dir={moveOpen ? 'up' : 'down'} />
          </Chip>
          {moveOpen && moveReady && (
            <Popover label="Move to" width={240} anchor={moveChip} onClose={() => setMoveOpen(false)}>
              <JiraMoveRows
                transitions={transitions}
                current={src.status.name}
                onPick={(id) => {
                  setMoveOpen(false);
                  onMove(id);
                }}
              />
            </Popover>
          )}
        </span>
      </Cell>
      <Cell label="Assignee">
        <span className="jira-detail-assignee">
          {src.assignee !== null && (
            <span className="jira-card-av" aria-hidden="true">
              {initialsOf(src.assignee.name)}
            </span>
          )}
          {src.assignee === null ? 'unassigned' : src.assignee.name}
        </span>
        <Chip size={28} disabled={busy || assignBlock !== null} title={assignBlock ?? undefined} onClick={onAssign}>
          Assign to me
        </Chip>
      </Cell>
      {src.sprint !== null && src.sprint !== '' && <Cell label="Sprint">{src.sprint}</Cell>}
      {parentLink !== null && <Cell label="Parent">{parentLink}</Cell>}
      {delivery !== null && <Cell label="Delivery">{deliveryValue(delivery, onDelivery)}</Cell>}
      <Cell label="Agent">{agentValue(agent, onAgent)}</Cell>
      {mentioned && (
        <Cell label="Mentions">
          <JiraMentionMarkFor issueKey={src.key} />
        </Cell>
      )}
    </dl>
  );
}

/** One label-over-value cell — `Main.dc.html`'s `.strip .f`. A `div` around the `dt`/`dd` pair, which a `dl` allows, so each cell wraps as one piece. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="jira-strip-cell">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The Delivery cell's value: target pills in `deliveryLook`'s tone (`.jira-dlv-word`'s own tone table, so a pill reads as the pane's word does), then `+N`. */
function deliveryValue(cell: Exclude<StripDeliveryCell, null>, onDelivery: (row: string | null) => void): ReactNode {
  if ('word' in cell) {
    return (
      <span className="jira-dlv-word" data-tone="grey" title={cell.title ?? undefined}>
        {cell.word}
      </span>
    );
  }
  return (
    <>
      {cell.pills.map((p) => (
        <button key={p.key} type="button" className="jira-dlv-word jira-strip-pill" data-tone={p.tone} onClick={() => onDelivery(p.key)}>
          {p.label}
        </button>
      ))}
      {cell.more !== null && (
        <button type="button" className="jira-dlv-word jira-strip-pill" data-tone={cell.more.tone} onClick={() => onDelivery(null)}>
          {`+${cell.more.count}`}
        </button>
      )}
    </>
  );
}

/** The Agent cell's value: the lead live session as a pill led by its state's dot (the card's `ui-stripe-dot` tone), `+N` beside it; else the idle words. */
function agentValue(agent: StripAgent, onAgent: () => void): ReactNode {
  if ('idle' in agent) return <span className="jira-strip-idle">{agent.idle}</span>;
  return (
    <>
      <button type="button" className="jira-strip-agent" onClick={onAgent}>
        <i className="ui-stripe-dot" data-tone={sessionTone(agent.lead.state)} aria-hidden="true" />
        {agent.lead.text}
      </button>
      {agent.more > 0 && <span className="jira-strip-more">{`+${agent.more}`}</span>}
    </>
  );
}
