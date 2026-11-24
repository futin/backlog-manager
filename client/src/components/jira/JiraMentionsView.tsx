import { useMemo, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraMentionsContext } from '../../hooks/JiraMentionsContext';
import { useJiraMentionsDismissed, useJiraMentionsView } from '../../hooks/useJiraMentionsView';
import { useNow } from '../../hooks/useNow';
import { useTimeZone } from '../../hooks/TimeZoneContext';
import {
  JIRA_MENTIONS_VIEWS,
  matchesMentionSearch,
  mentionCards,
  mentionRows,
  mentionsBand,
  mentionStepIndex,
  type JiraMentionsView as ViewMode,
  type MentionStep
} from '../../lib/jira-mentions';
import type { JiraPage } from '../../lib/jira-page';
import type { JiraMentionIssue } from '../../../../shared/types';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { Glyph } from '../ui/Glyphs';
import { Segmented } from '../ui/Segmented';
import { JiraMentionCards } from './JiraMentionCards';
import { JiraMentionList } from './JiraMentionList';
import { MentionModalHost } from './MentionModalHost';

const VIEW_LABELS: Record<ViewMode, string> = { list: 'List', cards: 'Cards' };

/**
 * DESIGN.md §8.9.7 — Jira › Mentions: the comments that @-mention the user and still wait on them (Jira mentions phase 1, Task 8; spec "The page", "Sync now,
 * two ways"; mocks `Main.dc.html`, band states `Sync.dc.html`).
 *
 * **One read for the section — the provider is the one caller.** `useJiraMentionsContext` hands this page the shell's single `useJiraMentions` instance
 * (`JiraMentionsProvider` in `App`); the List, and the Cards and the modal after it, take its values as props, so the whole section is one timer aimed at the
 * server's clock and one newest-read counter, never two pollers that could disagree for an interval.
 *
 * **The band is the Board page's.** `Band` titled `Mentions`; the switch is `Segmented track` as `JiraViewSwitch` draws it, over this page's own remembered
 * view (`useJiraMentionsView`) — a view of one page, so the rail stays the only page switch; then the `.board-band-search` field, the `Show dismissed · N`
 * chip (pressed while on, worded `Hide dismissed` then, as the mock draws it) and the mentions-only `Sync now`. Every word of the sub-line and the chip's
 * state is `mentionsBand`'s (`lib/jira-mentions.ts`): the count line, the failure in `.jira-band-sub.failing`'s red (the Board band's own red), the 429 wait
 * end and the cap. The chip's refresh glyph turns while a check is out — `checking` is the hook's, which also covers "never stamped and nothing blocks it",
 * so a first visit spins until the poller's first check lands.
 *
 * **The states that are not rows.** No answer yet — `loading…`; every read failed — `Mentions unavailable`, the Board's `board unavailable` shape. Unconfigured
 * — the other pages' pointer to Setup (`onOpenJiraPage('setup')`, the rail's own navigation threaded down from `App`). Configured but never checked — the
 * band says why (checking, the wait, the access sentence) and the body draws nothing: an empty table there would read as "Nothing waiting", which a check that
 * has not happened cannot say. A cache whose last check FAILED keeps its rows (Review Focus 2) and the body never says "Nothing waiting" while `detail` is
 * set; only a healthy, stamped, empty answer does.
 *
 * Dismiss and Restore are the hook's, which never reject — a refusal lands in `error` and the band says it in red — and replace the payload on success, so
 * the row leaves (or comes back) from the answer itself, not from a guess made here.
 *
 * **The mention modal's WALK is held here** (Task 10; the dialog itself is drawn by `MentionModalHost`, which the board reuses), because its prev/next walks the order THIS page draws: the List's rows (one per mention, the search
 * applied) or the Cards' cards (one per ticket, `mentionCards` over the same search), Show dismissed applied to both. `opened` is the stop the reader is on —
 * a ticket and a mention — and its place in the order is recomputed on every render (`mentionStepIndex`: by comment id in the List, by key in the Cards), so
 * a poll that reorders or recounts the page moves `Mention i of N` and never the dialog. A stop that LEFT the order (answered, dismissed with Show dismissed
 * off, filtered out) stays on screen with no position; its neighbours are then the ones around the last place it held (`lastAt`), so Previous is the row
 * that was before it and Next the one that took its place. The ticket's state for the footer is the host's read of the same answer: in `issues`, in `dismissed`, or
 * in neither.
 *
 * **The reply's writes are wired in `MentionModalHost`** (phase 2, Task 8; lifted from here by the board link's Task 4), so the modal stays a view of props: `Draft a reply` and `Redraft` are `dispatchReply` with
 * the launch defaults from Settings, `Stop` is `stopJira`, and each re-reads this page's hook AND the shell's sessions context on success, because the
 * modal's state is the two answers together (`issue.session` from the mentions store, the `(key, sessionId)` link that Open session needs from the
 * sessions poll). Discard and Post reply are the hook's own writes, whose answers replace the payload. The repo picker's list is `replyRepos` over the shell
 * status's `repos` — the ticket's project first — and a `Draft ready` marker on the List row and the card is the List's and the Cards' own (`draft !== null`).
 */
export function JiraMentionsView({ onOpenJiraPage }: { onOpenJiraPage: (p: JiraPage) => void }) {
  const { data, loading, error, checking, sweep, dismiss, restore } = useJiraMentionsContext();
  const access = useJiraContext().data?.access;
  const { zone } = useTimeZone();
  // `checked 1 min ago` and the `When` column (`2h`) move by the minute; a wait end disappears within a minute of passing.
  const now = useNow(true);
  const [view, setView] = useJiraMentionsView();
  const [showDismissed, setShowDismissed] = useJiraMentionsDismissed();
  const [search, setSearch] = useState('');
  const [opened, setOpened] = useState<MentionStep | null>(null);
  // The last index `opened` held in the order — written during render, on the render that found it, and read only on one that did not (see the header).
  const lastAt = useRef(0);

  const configured = data !== null && data.configured ? data : null;
  // Cards quote a ticket's newest mention whatever the search matched, so they take `visible` (no search) and filter by ticket themselves.
  const visible = useMemo(() => (configured === null ? [] : mentionRows(configured, showDismissed)), [configured, showDismissed]);
  const rows = useMemo(() => visible.filter((r) => matchesMentionSearch(r, search)), [visible, search]);
  const byTicket = view === 'cards';
  const order: readonly MentionStep[] = useMemo(() => (byTicket ? mentionCards(visible, search) : rows), [byTicket, visible, search, rows]);

  if (data === null || !data.configured) {
    return (
      <div className="board" data-testid="jira-mentions-page">
        <Band title="Mentions" />
        {data === null ? (
          <div className="board-empty">{loading || error === null ? 'loading…' : 'Mentions unavailable'}</div>
        ) : (
          <div className="board-empty">
            {data.detail ?? 'Jira is not set up'}
            <Chip size={28} onClick={() => onOpenJiraPage('setup')}>
              Open Setup
            </Chip>
          </div>
        )}
      </div>
    );
  }

  const band = mentionsBand({ data, checking, access, error, now, zone, view });
  const nDismissed = data.dismissed.length;
  const ids = (issue: JiraMentionIssue): string[] => issue.mentions.map((m) => m.commentId);
  const healthyEmpty = data.polledAt !== null && data.detail === null && data.issues.length === 0;

  const at = opened === null ? -1 : mentionStepIndex(order, opened, byTicket);
  if (at !== -1) lastAt.current = at;
  const prev = opened === null ? undefined : at !== -1 ? order[at - 1] : order[lastAt.current - 1];
  const next = opened === null ? undefined : at !== -1 ? order[at + 1] : order[lastAt.current];
  // The stop as the page draws it now (a card's quoted mention may have moved under a poll), else as it was opened.
  const shown = opened === null ? null : at !== -1 ? order[at] : opened;

  return (
    <div className="board" data-testid="jira-mentions-page">
      <Band
        title="Mentions"
        sub={
          <span className="jira-band-sub">
            {band.lead}
            {band.fail !== null && (
              <>
                {band.lead !== '' && ' · '}
                <span className="jira-band-sub failing">{band.fail}</span>
              </>
            )}
            {band.tail !== null && ` · ${band.tail}`}
          </span>
        }
      >
        <Segmented<ViewMode> track label="View" value={view} options={JIRA_MENTIONS_VIEWS.map((v) => ({ value: v, label: VIEW_LABELS[v] }))} onChange={setView} />
        <input
          type="search"
          className="board-band-search"
          aria-label="Search mentions"
          placeholder="search mentions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Chip pressed={showDismissed} disabled={!showDismissed && nDismissed === 0} onClick={() => setShowDismissed(!showDismissed)}>
          {showDismissed ? 'Hide dismissed' : `Show dismissed · ${nDismissed}`}
        </Chip>
        <Chip
          icon={
            <span className="jira-mentions-spin" data-on={checking ? '' : undefined}>
              <Glyph name="refresh" />
            </span>
          }
          disabled={band.disabled}
          title={band.title}
          onClick={() => void sweep()}
        >
          Sync now
        </Chip>
      </Band>

      {rows.length > 0 ? (
        view === 'cards' ? (
          <JiraMentionCards
            rows={visible}
            search={search}
            me={data.me}
            now={now}
            onDismiss={(issue) => void dismiss(issue.key, ids(issue))}
            onRestore={(issue) => void restore(issue.key)}
            onOpen={setOpened}
          />
        ) : (
          <JiraMentionList
            rows={rows}
            me={data.me}
            now={now}
            onDismiss={(issue) => void dismiss(issue.key, ids(issue))}
            onRestore={(issue) => void restore(issue.key)}
            onOpen={setOpened}
          />
        )
      ) : search.trim() !== '' && (data.issues.length > 0 || (showDismissed && nDismissed > 0)) ? (
        <div className="board-empty">No mentions match</div>
      ) : healthyEmpty ? (
        <div className="board-empty">{`Nothing waiting on you in the last ${data.window} days.`}</div>
      ) : null}

      {shown !== null && (
        <MentionModalHost
          issue={shown.issue}
          mention={shown.mention}
          position={at === -1 ? null : { at: at + 1, of: order.length }}
          onPrev={prev === undefined ? null : () => setOpened(prev)}
          onNext={next === undefined ? null : () => setOpened(next)}
          onClose={() => setOpened(null)}
          onOpenPage={null}
        />
      )}
    </div>
  );
}
