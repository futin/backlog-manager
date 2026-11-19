import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { useAction } from '../../hooks/useAction';
import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { useFetched } from '../../hooks/useFetched';
import { setJiraDetailTab, useJiraDetailTab, type DetailTab } from '../../hooks/useJiraDetailTab';
import { useNow } from '../../hooks/useNow';
import { useParentRead } from '../../hooks/useParentRead';
import { useSettings } from '../../hooks/useSettings';
import { deliveryTargets, targetRowId, ticketDelivery, UNKNOWN_LINE } from '../../lib/delivery';
import { elapsedSince } from '../../lib/item-age';
import {
  failureOf,
  fetchJiraWorktrees,
  modalTree,
  repoBasename,
  resolveJiraAction,
  runChipState,
  stopJira,
  ticketWorktrees,
  typeTone,
  unlinkJira,
  type JiraChildrenIndex
} from '../../lib/jira';
import { childSessions } from '../../lib/jira-deck';
import { parentLiveLine } from '../../lib/jira-parent';
import { ticketSessions } from '../../lib/jira-sessions';
import { stripAgent, stripDelivery } from '../../lib/jira-strip';
import { pollAge } from '../../lib/tracker';
import { JIRA_BUILTIN_LABELS } from '../../../../shared/types';
import type { GitlabMr, JiraAction, JiraIssue, JiraIssueDetail, JiraWorktreesPayload, ReviewHalf } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Glyph } from '../ui/Glyphs';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { ChildrenTree } from './ChildrenTree';
import { ChildSessionLine } from './ChildSessionLine';
import { JiraDeliveryTab, useOpenRows } from './JiraDeliveryTab';
import { JiraHistoryLine, JiraSessionCards, JiraStartingCard } from './JiraSessionCard';
import { JiraTicketPane } from './JiraTicketPane';
import { JiraTicketStrip, type StripDeliveryCell } from './JiraTicketStrip';
import { ParentSessionLine } from './ParentSessionLine';
import { WorktreesFold } from './WorktreesList';

/**
 * JiraTicketBody — one Jira ticket's body: the heading, the summary strip, the tab row and the four panes (Jira detail tabs spec §1; DESIGN.md §8.9.2), drawn
 * by both frames — the Detail dialog (`JiraDetail`, a `ui/Modal` composer) and the ticket page. Neither frame draws any part of it, and it draws no part of
 * a frame: no crumbs (each frame has its own line), no `Open in Jira ↗`, no `Run ▾` (the frame's head holds both, spec §2.1, §7.1) and no close.
 *
 * **Who owns what.** The FRAME owns the detail read and its re-read — the modal reads the card's key, the page reads by key — and hands down `detail` and
 * `failure`; its `onWrote(reread)` does both of today's steps after a landed write: the detail re-read when `reread` is true (an Assign or a Move that landed
 * for the key still shown) and the board nudge always. The BODY owns everything its own controls need, because they now live in its strip:
 *
 * - **The one `useAction` write guard.** Assign, Move, Stop and Unlink all fire through it, so a double click, or a Move picked while Assign is out, sends
 *   nothing (bug-19's layer 1). Each write carries its key and its settle compares that against the key shown NOW (`keyRef`): a refusal for a ticket the
 *   reader has walked away from is dropped, and its detail re-read is not asked for. The status reload is the body's (`useJiraContext().reload()`), and a
 *   session write also reloads the sessions payload, so the card goes without waiting for the timer.
 * - **The write-error line** (`role="alert"`) under the strip, on every tab — the strip is where the writes are, so the line that answers them sits under it,
 *   whichever pane is open. It clears when the next write leaves and when the key changes (during render, so the new ticket's first frame is clean).
 * - **The parent read** (`useParentRead`) and its own alert line, after the write error: the parent link is a strip cell on both frames.
 * - **The Worktrees read** (`GET /api/jira/worktrees`), keyed on the key and on whether a session is live on it — the moments a tree is made or becomes safe
 *   to remove. Liveness is read here, from the sessions the strip already reads, so a frame cannot hand down a list keyed on a different reading of it.
 *
 * **Tabs** (spec §1.3) follow the WAI-ARIA tabs pattern: a `role="tablist"` of buttons with `aria-selected`, a roving `tabIndex` (only the selected tab is
 * in the Tab order), arrow keys moving and selecting (Home/End to the ends, wrapping at both), and one `role="tabpanel"` labelled by its tab. The selection is
 * the `jira-detail-tab` store (`useJiraDetailTab`), shared by both frames and written on every user selection. A remembered tab this ticket does not draw
 * — Delivery on a project mapping no GitLab project — is shown as `ticket` for this render and NOT written, so the next mapped ticket opens on Delivery again.
 *
 * **The slots.** The Ticket pane is `JiraTicketPane`. The Delivery, Agent and Children panes are named render functions below (`deliverySlot`, `agentSlot`,
 * `childrenSlot`). Delivery is `JiraDeliveryTab` (spec §4): one fold row per target, and which rows are open is THIS body's state (`useOpenRows`, reset on
 * a key change), because a strip pill opens its row from outside the tab — the pill's click adds the row and selects the tab. The Worktrees fold (spec
 * §4.6) sits at the bottom of the Delivery tab, or of the Ticket tab when the ticket draws no Delivery tab, so it is drawn once either way. The Agent and
 * Children panes draw today's regions — the agent band's content and history, the Children tree and the comments note — until the tasks that redraw them.
 */

/**
 * POSTs one issue write and resolves when it LANDED: a non-OK answer rejects with `failureOf`'s sentence, a dropped request with the network's own error.
 * The 200's body is not read — `reread: false` is the SERVER's re-read failing after the write stood, and must not turn a landed write into an error.
 */
async function postWrite(path: 'assign' | 'transition', body: Record<string, string>): Promise<void> {
  const res = await fetch(`/api/jira/issue/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await failureOf(res));
}

const TAB_LABEL: Record<DetailTab, string> = { ticket: 'Ticket', delivery: 'Delivery', agent: 'Agent', children: 'Children & comments' };

export function JiraTicketBody({
  issue,
  detail,
  failure,
  childrenOf,
  back,
  onBack,
  onOpenIssue,
  onWrote,
  onReview,
  onRun
}: {
  /** The issue the frame opened on — the card's copy in the modal. Everything the card carries draws from it until `detail` lands. */
  issue: JiraIssue;
  /** The frame's detail read for `issue.key`, held across its own re-read; `null` while out or failed. */
  detail: JiraIssueDetail | null;
  /** The detail read's failure sentence, or `null`. */
  failure: string | null;
  /** The board's lane index the Children tree hangs descendants from (`modalTree`); `null` draws the direct children only. */
  childrenOf: JiraChildrenIndex | null;
  /** One step up the walk, or `null` at its start — the heading draws `← <key>` only when there is one. */
  back: JiraIssue | null;
  onBack: () => void;
  /** A walk step (a Children row, a child-live line, the parent link): the frame swaps its ticket. */
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  /** A write landed: `reread` asks the frame for a detail re-read (an issue write for the key still shown); the board nudge is the frame's either way. */
  onWrote: (reread: boolean) => void;
  /** The Delivery pane's review button — the frame opens the launch sheet pre-set to a review. Absent, no button draws. */
  onReview?: (issue: JiraIssue, half: ReviewHalf, mr: GitlabMr, repos: string[]) => void;
  /** A Delivery next row's `Run ▾` (a failed pipeline): the frame's own `onRun`, the one its head's `Run ▾` calls. */
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const { data, reload } = useJiraContext();
  const { data: sessions, reload: reloadSessions } = useJiraSessionsContext();
  const { settings } = useSettings();
  const { busy, error: writeError, run, clearError } = useAction();
  const now = useNow(true);
  const ids = useId();
  // The key the body shows NOW, read by a write's settle — a ref, because the settle closure was made on the render that sent it.
  const keyRef = useRef(issue.key);
  keyRef.current = issue.key;

  // Per-ticket state, reset DURING render on a key change (React's "adjust state when a prop changes"), so the swapped-in ticket's first frame carries none
  // of the last one's: its refusal, its parent-read failure. The open Delivery rows reset the same way, inside `useOpenRows`.
  const [shownKey, setShownKey] = useState(issue.key);
  const [parentAskedFor, setParentAskedFor] = useState<string | null>(null);
  if (shownKey !== issue.key) {
    setShownKey(issue.key);
    clearError();
    setParentAskedFor(null);
  }

  const src: JiraIssue = detail ?? issue;

  // This ticket's sessions, and the shell's reservation — `starting` is the one state only the status knows (a reservation has no link yet).
  const { live: liveLinks, ended } = ticketSessions(issue.key, sessions);
  const reserved = data?.live[issue.key] ?? null;
  const starting = reserved !== null && reserved.starting ? reserved : null;
  const liveCount = liveLinks.length + (starting !== null ? 1 : 0);

  // The Worktrees read (see the header): keyed on WHETHER a session is live, not on the session object a status poll replaces. The previous answer for the
  // same key stays drawn while a re-read is out, so the list does not blink on a Stop.
  const sessionLive = starting !== null || liveLinks.length > 0 || (sessions === null && reserved !== null);
  const trees = useFetched(() => fetchJiraWorktrees(), [issue.key, sessionLive]);
  const keptTrees = useRef<{ key: string; payload: JiraWorktreesPayload } | null>(null);
  if (trees.status === 'ok' && trees.value !== null) keptTrees.current = { key: issue.key, payload: trees.value };
  else if (trees.status === 'failed') keptTrees.current = null;
  const ticketTrees = keptTrees.current === null || keptTrees.current.key !== issue.key ? [] : ticketWorktrees(issue.key, keptTrees.current.payload);

  // The Children tree, built once because the Children slot draws it and the Agent slot's empty shape says which of its rows a session is live on.
  const tree = detail === null || detail.children.length === 0 ? null : modalTree(detail.key, detail.children, childrenOf);
  const underway = tree === null ? [] : childSessions(tree.rows.map((r) => r.issue), sessions, data?.live ?? {});

  // Delivery: the shell's one GitLab answer, indexed once per payload (`useDeliveryIndex`). `null` index is "delivery is not shown at all"; `hidden` is
  // "this project maps no GitLab project". Either way there is no Delivery tab and no Delivery cell — one condition, the one `DeliveryPane` draws by.
  const index = useDeliveryIndex();
  const dlv = index === null ? null : ticketDelivery(src, index);
  const targets = dlv !== null && dlv.kind === 'mrs' ? deliveryTargets([dlv.lead, ...dlv.also]) : [];
  const { openRows, toggleRow, openRow } = useOpenRows(issue.key, targets.length === 0 ? null : targetRowId(targets[0]));
  const deliveryCell: StripDeliveryCell =
    dlv === null || dlv.kind === 'hidden'
      ? null
      : dlv.kind === 'none'
        ? { word: 'no MR', title: null }
        : dlv.kind === 'unknown'
          ? { word: 'unknown', title: UNKNOWN_LINE[dlv.why] }
          : stripDelivery(targets, new Set(targets.map((t) => t.project)).size > 1, now);

  // The tabs drawn for this ticket, in the store's declaration order; the selection falls back to `ticket` for this render only (see the header).
  const counts: Record<DetailTab, { text: string; live?: boolean } | null> = {
    ticket: null,
    delivery: targets.length === 0 ? null : { text: targets.length === 1 ? '1 target' : `${targets.length} targets` },
    agent: liveCount > 0 ? { text: `${liveCount} live`, live: true } : ended.length > 0 ? { text: String(ended.length) } : null,
    children: detail === null || detail.children.length === 0 ? null : { text: String(detail.children.length) }
  };
  const tabs: DetailTab[] = deliveryCell === null ? ['ticket', 'agent', 'children'] : ['ticket', 'delivery', 'agent', 'children'];
  const remembered = useJiraDetailTab();
  const tab: DetailTab = tabs.includes(remembered) ? remembered : 'ticket';
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});
  const tabId = (t: DetailTab): string => `${ids}-tab-${t}`;
  const panelId = `${ids}-panel`;
  const select = (t: DetailTab): void => setJiraDetailTab(t);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const at = tabs.indexOf(tab);
    const n = tabs.length;
    const moves: Record<string, number> = { ArrowRight: (at + 1) % n, ArrowLeft: (at - 1 + n) % n, Home: 0, End: n - 1 };
    const to = e.key in moves ? moves[e.key] : null;
    if (to === null) return;
    e.preventDefault();
    select(tabs[to]);
    tabRefs.current[tabs[to]]?.focus();
  };

  // The parent link: one read shared with the frame's `Run ▾` (`useParentRead`), a push onto the walk when it lands for the key still shown. A READ, so
  // it does not take the write guard.
  const parent = src.parent;
  const { read: parentRead, ask: askParent } = useParentRead(parent === null ? null : parent.key);
  const parentBusy = parentRead.state === 'loading';
  const parentError = parentRead.state === 'failed' && parentAskedFor === issue.key ? parentRead.error : null;
  const openParent = (): void => {
    if (parentBusy) return;
    const asked = issue.key;
    setParentAskedFor(asked);
    void askParent().then((p) => {
      if (p !== null && keyRef.current === asked) onOpenIssue(p, childrenOf);
    });
  };
  // A stub's parent summary is `''`, so the label never ends on a stray space.
  const parentLink =
    parent === null ? null : (
      <button type="button" className="jira-detail-parent" aria-busy={parentBusy || undefined} aria-disabled={parentBusy || undefined} onClick={openParent}>
        {[parent.key, parent.summary].filter((p) => p !== '').join(' ')}
      </button>
    );

  const me = data?.me ?? null;
  const assignBlock = me === null ? 'no identity' : src.assignee?.accountId === me.accountId ? 'already assigned to you' : null;
  const moveBlock = failure !== null ? 'transitions unavailable' : detail !== null && detail.transitions.length === 0 ? 'no transitions offered' : null;

  /** An Assign or a Move: one guard, one error line, one key stamp; a landed one asks the frame to re-read only while its key is still shown. */
  const write = (path: 'assign' | 'transition', body: Record<string, string>): void => {
    const asked = issue.key;
    run(() => postWrite(path, body), {
      onSuccess: () => {
        reload();
        onWrote(keyRef.current === asked);
      },
      // `true` is "handled — draw nothing": the refusal is for a ticket this body no longer shows.
      onError: () => keyRef.current !== asked
    });
  };

  /** A Stop or an Unlink, through the same guard: a landed one reloads the status and the sessions payload, and nudges the board — no detail re-read. */
  const sessionWrite = (send: (key: string) => Promise<void>): void => {
    const asked = issue.key;
    run(() => send(asked), {
      onSuccess: () => {
        reload();
        void reloadSessions();
        onWrote(false);
      },
      onError: () => keyRef.current !== asked
    });
  };

  // The `Session` fact: the newest live session, `starting`, or `—`; from the shell's reservation while the sessions payload has not landed.
  const newest = liveLinks[0] ?? null;
  const sessionLine =
    starting !== null
      ? 'starting'
      : newest !== null
        ? [newest.name, repoBasename(newest.repo), elapsedSince(newest.startedAt, now)].filter((p) => p !== null).join(' · ')
        : sessions === null && reserved !== null
          ? [reserved.name, repoBasename(reserved.repo), elapsedSince(reserved.startedAt, now)].filter((p) => p !== null).join(' · ')
          : '—';

  // The Worktrees fold (spec §4.6), drawn by whichever tab is its home for this ticket; keyed by the key so its open state resets with the ticket.
  const worktreesFold =
    ticketTrees.length === 0 ? null : (
      <div className="jira-detail-pane">
        <WorktreesFold key={issue.key} trees={ticketTrees} issueKey={issue.key} live={sessionLive} home={data?.home ?? null} />
      </div>
    );

  /** The Delivery slot: the per-target rows, the open set this body holds, the newest live `review` link for a `fix` row's `Open session`. */
  const deliverySlot = (): ReactNode => (
    <JiraDeliveryTab
      issue={src}
      now={now}
      onReview={onReview}
      onRun={onRun}
      openRows={openRows}
      onToggleRow={toggleRow}
      onOpenRow={openRow}
      liveReviewLink={liveLinks.find((l) => l.action === 'review') ?? null}
      worktrees={worktreesFold}
    />
  );

  /** The Agent slot: today's agent band content and history, less `Run ▾` and the band's label (the frame's head and the tab's count carry those now). */
  const agentSlot = (): ReactNode => {
    const parentLine = parentLiveLine(src, sessions);
    const parentLineEl =
      parentLine === null || parent === null ? null : (
        <ParentSessionLine parentKey={parent.key} lead={parentLine.lead} more={parentLine.more} onOpen={openParent} />
      );
    const defaultAction = resolveJiraAction(settings.jiraDefaultAction, data?.skills ?? []);
    const defaultLabel =
      typeof defaultAction === 'string' ? JIRA_BUILTIN_LABELS[defaultAction] : (data?.skills.find((k) => k.id === defaultAction.skill)?.name ?? '');
    const lastRun = ended.length > 0 ? pollAge(ended[0].endedAt, now) : null;
    const bandSub = `default: ${defaultLabel}${lastRun === null ? '' : ` · last run ${lastRun}`}`;
    // The gate line explains the frame's `Run ▾`, from the chip's own state, so the line and a disabled chip can never disagree.
    const gate = data === null ? null : runChipState(issue, data, sessions);
    const runLive = liveLinks.some((l) => l.how === 'run');
    const nextLine = gate === 'live' ? 'Next Run can start once this one is quiet.' : gate === 'ready' && runLive ? 'Quiet — a new Run can start now.' : null;
    return (
      <div className="jira-detail-agent">
        <div className="jira-detail-agent-band">
          {nextLine !== null && <span className="jira-detail-next">{nextLine}</span>}
          {liveCount > 0 ? (
            <>
              {parentLineEl}
              {starting !== null && <JiraStartingCard session={starting} now={now} />}
              {liveLinks.length > 0 && (
                <JiraSessionCards
                  links={liveLinks}
                  now={now}
                  busy={busy}
                  onUnlink={(sessionId) => sessionWrite((key) => unlinkJira(key, sessionId))}
                  onStop={(sessionId) => sessionWrite((key) => stopJira(key, sessionId))}
                />
              )}
            </>
          ) : (
            <div className="jira-detail-agent-row">
              <span className="jira-detail-agent-tile" aria-hidden="true">
                <Glyph name="robot" size={16} />
              </span>
              <div className="jira-detail-agent-text">
                <span className="jira-detail-agent-none">No session on this ticket</span>
                <span className="jira-detail-agent-sub">{bandSub}</span>
                {parentLineEl}
                {underway.length > 0 && (
                  <ChildSessionLine first={underway[0]} more={underway.length - 1} onOpen={() => onOpenIssue(underway[0].issue, childrenOf)} />
                )}
              </div>
            </div>
          )}
        </div>
        {ended.length > 0 && (
          <>
            <div className="jira-detail-lbl">History</div>
            <ol className="jira-hist-list">
              {ended.map((link) => (
                <JiraHistoryLine key={`${link.sessionId ?? ''}\u0000${link.startedAt}`} link={link} now={now} />
              ))}
            </ol>
          </>
        )}
      </div>
    );
  };

  /** The Children slot: today's Children tree and comments note, as they were; the Worktrees moved to a fold (`worktreesFold`). */
  const childrenSlot = (): ReactNode => (
    <div className="jira-detail-ticket">
      {detail !== null && tree !== null && (
        <div className="jira-detail-pane">
          <ChildrenTree direct={detail.children.length} tree={tree} underway={underway} childrenOf={childrenOf} onOpenIssue={onOpenIssue} />
        </div>
      )}
      <p className="jira-modal-comments">
        Comments stay in Jira — v1 neither reads nor writes them.{' '}
        <a href={src.url} target="_blank" rel="noreferrer">
          {`${src.key} in Jira ↗`}
        </a>
      </p>
    </div>
  );

  const pane: Record<DetailTab, () => ReactNode> = {
    ticket: () => (
      <>
        <JiraTicketPane src={src} detail={detail} failure={failure} sessionLine={sessionLine} now={now} />
        {deliveryCell === null && worktreesFold}
      </>
    ),
    delivery: deliverySlot,
    agent: agentSlot,
    children: childrenSlot
  };

  return (
    <div className="jira-body">
      {/* The heading (spec §1.1): Back, the type and the key and labels as tags, then the title. The crumbs are the frame's. */}
      <div className="jira-body-head">
        <div className="jira-body-tags">
          {back !== null && (
            <Chip size={28} aria-label={`Back to ${back.key}`} title={`Back to ${back.key} ${back.summary}`} onClick={onBack}>
              <span aria-hidden="true">←</span> {back.key}
            </Chip>
          )}
          <span className="jira-card-type" data-tone={typeTone(src.type)} aria-hidden="true">
            <JiraTypeIcon type={src.type} />
          </span>
          <span className="jira-body-key">{src.key}</span>
          {src.type.name !== '' && <span className="jira-body-tag">{src.type.name}</span>}
          {src.labels.map((l) => (
            <span key={l} className="jira-body-tag">
              {l}
            </span>
          ))}
        </div>
        <h2 className="jira-detail-title">{src.summary}</h2>
      </div>
      <JiraTicketStrip
        src={src}
        busy={busy}
        transitions={detail === null ? null : detail.transitions}
        moveBlock={moveBlock}
        onMove={(id) => write('transition', { key: issue.key, transitionId: id })}
        assignBlock={assignBlock}
        onAssign={() => write('assign', { key: issue.key })}
        parentLink={parentLink}
        delivery={deliveryCell}
        agent={stripAgent({ links: liveLinks, starting }, ended.length, now)}
        onDelivery={(row) => {
          if (row !== null) openRow(row);
          select('delivery');
        }}
        onAgent={() => select('agent')}
      />
      {writeError !== null && (
        <p className="jira-modal-error" role="alert">
          {writeError}
        </p>
      )}
      {/* The parent read's own failure — after the write error, so both show and neither hides the other. */}
      {parentError !== null && (
        <p className="jira-modal-error" role="alert">
          {parentError}
        </p>
      )}
      <div className="jira-tabs" role="tablist" aria-label="Ticket sections">
        {tabs.map((t) => {
          const count = counts[t];
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t)}
              className="jira-tab"
              aria-selected={t === tab}
              aria-controls={t === tab ? panelId : undefined}
              tabIndex={t === tab ? 0 : -1}
              onClick={() => select(t)}
              onKeyDown={onTabKey}
            >
              {TAB_LABEL[t]}
              {count !== null && (
                <>
                  {' '}
                  <span className="jira-tab-count" data-live={count.live || undefined}>
                    {count.text}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="jira-tabpanel" role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
        {pane[tab]()}
      </div>
    </div>
  );
}
