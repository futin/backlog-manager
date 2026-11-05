import { useMemo, type MouseEvent, type ReactNode } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { useJiraListFilters } from '../../hooks/useJiraListFilters';
import { useTimeZone } from '../../hooks/TimeZoneContext';
import { useAction } from '../../hooks/useAction';
import { useNarrow } from '../../hooks/useNarrow';
import { openDesktopJira, repoBasename, runChipState, type JiraChildrenIndex } from '../../lib/jira';
import {
  LIST_CHIPS,
  LIST_WINDOWS,
  applyListFilters,
  buildListRows,
  forLabel,
  listDotTone,
  rowOpens,
  startedLabel,
  type ListChip,
  type ListRow,
  type ListWindow
} from '../../lib/jira-list';
import { openButtons, runLabel, stripTitle, surfaceWord } from '../../lib/jira-sessions';
import { pollAge } from '../../lib/tracker';
import { STATE_LABEL } from '../../../../shared/jira-sessions';
import type { JiraAction, JiraIssue, JiraLiveSession } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Dot } from '../ui/Dot';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Select } from '../ui/Select';
import { JiraRunMenu } from './JiraRunMenu';
import { OpenChip } from './JiraSessionCard';

const NO_LIVE: Readonly<Record<string, JiraLiveSession>> = {};

const CHIP_LABEL: Record<ListChip, string> = { all: 'All', 'needs-you': 'Needs you', working: 'Working', ended: 'Ended' };

/**
 * JiraSessionList — the Sessions page's table (it was the Board page's List view until the Sessions-page spec): one row per session, live above ended (Jira sessions spec §7.2, C7; DESIGN.md §8.9.1). It is the same sessions
 * the deck draws, as a table a person can scan, filter and search — and the only place a session on a ticket off the board, or one that has ended, is a row.
 *
 * **It draws what `lib/jira-list.ts` derived** — which sessions are in scope, which ended rows the window hides, the counts and both orders — and holds no
 * copy of any. The page hands in the loaded list's `issues`, the band's search text and the fold's `childrenOf`; everything else it reads from the shell
 * (`useJiraContext`: the Starting reservations, the skills, the site) and from the ONE sessions answer (`useJiraSessionsContext` — this view starts no poll of
 * its own, so the List, the deck and `Run ▾` can never disagree for a tick). The List's own filters are `hooks/useJiraListFilters`'s, shared with the rail
 * badge (C4), which sets `needs-you` and All tickets from outside the page.
 *
 * **The bar.** Four chips with their counts (All, Needs you, Working, Ended — each count is what the chip WOULD show under the other filters, so a pressed
 * chip does not shrink its neighbours), the Repo and Run selects, the window for ended rows (24 h, 7 d, 30 d, All; live rows are never hidden by age), and the
 * All tickets toggle that widens the scope from the picked board's tickets to every linked one.
 *
 * **The row.** State · Ticket · Run · Repo and branch · Where · Model · Context · Started · For · Open. The ticket cell is the type glyph, the key and the
 * summary as a button that opens Detail (§8.9.2) — with the fold's `childrenOf` for a ticket on the board, and none for one drawn from its link's snapshot,
 * which has no fold to hand the Children tree. **The whole row opens Detail too** (`rowOpens`): a summary-only target read as plain text until hovered, so
 * nobody found it. The summary button stays the keyboard's way in — a `tr` takes no focus — and a click on any control inside the row (`Open`, `Reopen`,
 * `Run ▾` and its panel, which is drawn inside the cell, not in a portal) is that control's alone, as is a click that ends a text selection.
 * A row that needs a person wears the amber wash the deck's strip does; an ended row is set in the quiet ink.
 * **Open** is the deck's: `openButtons(..., { wide: false })` through Detail's own `OpenChip`, so C2's Desktop rule lives in one place and its refusal draws
 * in the alert line under the table. An ended row's is `Reopen` — and `Run ▾`, but ONLY while the ticket has no live `run` link and no Starting reservation
 * (`runChipState`, the one-run gate): a second Start on a ticket that is already being run is exactly what the server would refuse. A Starting row has no
 * buttons, because every one needs a session id.
 */
export function JiraSessionList({
  issues,
  search,
  now,
  childrenOf,
  onOpenIssue,
  onRun,
  unavailable
}: {
  /** The picked board's loaded list — every issue, folded or not. */
  issues: readonly JiraIssue[];
  search: string;
  now: number;
  childrenOf: JiraChildrenIndex;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  /**
   * What the board cannot give (`jira.json` unreadable, no board, still loading, load failed), or `null`. The bar and the link-store warning draw whatever
   * this is, so `All tickets` stays reachable; the body under them gives way to this line while `All tickets` is off — with it on, the table is scoped to
   * every linked ticket and needs no board (spec C8), so the prop is ignored.
   */
  unavailable: ReactNode | null;
}) {
  const { data } = useJiraContext();
  const { data: payload } = useJiraSessionsContext();
  const { zone } = useTimeZone();
  const [want, setFilters] = useJiraListFilters();
  const handover = useAction();
  const live = data?.live ?? NO_LIVE;
  const skills = data?.skills ?? [];
  const site = data?.site ?? '';

  const board = useMemo(() => new Map(issues.map((i) => [i.key, i])), [issues]);
  // Rebuilt on the payload, the status and the scope — never on `now`, so the minute tick re-ages the rows without rebuilding them.
  const rows = useMemo(() => buildListRows(payload, live, board, want.allTickets, site), [payload, live, board, want.allTickets, site]);
  const view = useMemo(() => applyListFilters(rows, want, search, skills, now), [rows, want, search, skills, now]);
  const { filters } = view;

  const total = view.live.length + view.ended.length;
  const saveError = payload?.saveError ?? null;
  return (
    <section className="jira-list" aria-label="Sessions">
      <div className="jira-list-bar">
        <div className="jira-list-chips" role="group" aria-label="Show">
          {LIST_CHIPS.map((c) => (
            <Chip key={c} size={28} pressed={filters.chip === c} onClick={() => setFilters({ chip: c })}>
              {CHIP_LABEL[c]} <span className="jira-list-count">{view.counts[c]}</span>
            </Chip>
          ))}
        </div>
        <div className="jira-list-picks">
          <Select<string>
            label="Repo"
            value={filters.repo ?? ''}
            options={[{ value: '', label: 'All repos' }, ...view.repos.map((r) => ({ value: r, label: r }))]}
            onChange={(v) => setFilters({ repo: v === '' ? null : v })}
          />
          <Select<string>
            label="Run"
            value={filters.run ?? ''}
            options={[{ value: '', label: 'Any run' }, ...view.runs]}
            onChange={(v) => setFilters({ run: v === '' ? null : v })}
          />
          <Select<ListWindow>
            label="Ended within"
            value={filters.window}
            options={LIST_WINDOWS.map((w) => ({ value: w.value, label: w.value === 'all' ? 'Ended: all time' : `Ended: ${w.label}` }))}
            onChange={(v) => setFilters({ window: v })}
          />
          <Chip size={28} pressed={filters.allTickets} title="Include sessions on tickets that are not on this board" onClick={() => setFilters({ allTickets: !filters.allTickets })}>
            All tickets
          </Chip>
        </div>
      </div>

      {/* The link store's last save failed: every row here is memory only, and a restart drops them and every unlink with them. A save that throws costs
          nothing else by contract, so this line is the one place that says so (2026-11-04: a store in the compose stack's read-only mount, never saved). */}
      {saveError !== null && (
        <p className="jira-list-warn" role="status" aria-label="Link store">
          Jira links are not being saved — a server restart will drop them. <span className="jira-list-warn-detail">{saveError.message}</span>
        </p>
      )}

      {unavailable !== null && !filters.allTickets ? (
        <div className="board-empty">{unavailable}</div>
      ) : total === 0 ? (
        <div className="board-empty">No sessions{filters.chip === 'all' && search.trim() === '' ? '' : ' match'}</div>
      ) : (
        <div className="jira-list-scroll">
          <table className="jira-list-table">
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Ticket</th>
                <th scope="col">Run</th>
                <th scope="col">Repo · branch</th>
                <th scope="col">Where</th>
                <th scope="col">Model</th>
                <th scope="col">Context</th>
                <th scope="col">Started</th>
                <th scope="col">For</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            {view.live.length > 0 && (
              <ListGroup title="Live" count={view.live.length}>
                {view.live.map((r) => (
                  <ListRowView
                    key={r.id}
                    row={r}
                    now={now}
                    zone={zone}
                    childrenOf={childrenOf}
                    onOpenIssue={onOpenIssue}
                    onRun={onRun}
                    onHandover={(id) => handover.run(() => openDesktopJira(id))}
                  />
                ))}
              </ListGroup>
            )}
            {view.ended.length > 0 && (
              <ListGroup title="Ended" count={view.ended.length}>
                {view.ended.map((r) => (
                  <ListRowView
                    key={r.id}
                    row={r}
                    now={now}
                    zone={zone}
                    childrenOf={childrenOf}
                    onOpenIssue={onOpenIssue}
                    onRun={onRun}
                    onHandover={(id) => handover.run(() => openDesktopJira(id))}
                  />
                ))}
              </ListGroup>
            )}
          </table>
        </div>
      )}
      {handover.error !== null && (
        <p className="jira-modal-error" role="alert">
          {handover.error}
        </p>
      )}
      {(unavailable === null || filters.allTickets) && (
        <p className="jira-list-foot">
          {total} {total === 1 ? 'session' : 'sessions'}
          {filters.window !== 'all' && ` · ended sessions older than ${LIST_WINDOWS.find((w) => w.value === filters.window)?.label ?? ''} are hidden`}
          {!filters.allTickets && ' · this board only'}
        </p>
      )}
    </section>
  );
}

/** One group of the table: its own `<tbody>` so the header row and the rows under it stay one unit, and a header that says how many it holds. */
function ListGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <tbody aria-label={title}>
      <tr className="jira-list-group">
        <th scope="rowgroup" colSpan={10}>
          {title} · {count}
        </th>
      </tr>
      {children}
    </tbody>
  );
}

function ListRowView({
  row,
  now,
  zone,
  childrenOf,
  onOpenIssue,
  onRun,
  onHandover
}: {
  row: ListRow;
  now: number;
  zone: string;
  childrenOf: JiraChildrenIndex;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  onHandover: (sessionId: string) => void;
}) {
  const { data } = useJiraContext();
  const { data: payload } = useJiraSessionsContext();
  const phone = useNarrow();
  const { issue, link, starting, state } = row;
  const sessionRow = link?.row ?? null;
  const tone = listDotTone(state);
  const age = row.ended ? null : pollAge(row.since, now);
  const pct = sessionRow?.contextPct;
  const model = sessionRow?.model ?? link?.model ?? null;
  const effort = sessionRow?.effort ?? link?.effort ?? null;
  const where = link === null ? null : surfaceWord(link, sessionRow);
  const run = link !== null ? runLabel(link, data?.skills ?? []) : (starting?.name ?? '');
  const sessionId = link?.sessionId ?? null;
  const buttons = link !== null && sessionId !== null ? openButtons(link, sessionRow, state, { phone, wide: false }) : null;
  // The one-run gate, read where the deck's and Detail's are: a live `run` link or a Starting reservation hides `Run ▾`, a live branch link does not.
  const canRun = row.ended && data !== null && runChipState(issue, data, payload) !== 'live';
  const open = (): void => onOpenIssue(issue, row.onBoard ? childrenOf : null);
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>): void => {
    if (rowOpens(e.currentTarget, e.target, window.getSelection()?.toString() ?? '')) open();
  };

  return (
    <tr
      className="jira-list-row"
      data-state={state}
      data-key={row.key}
      data-ended={row.ended ? 'true' : undefined}
      aria-label={`Session on ${row.key}`}
      onClick={onRowClick}
    >
      <td className="jira-list-state" title={stripTitle(state)}>
        <div className="jira-list-flex">
          {tone !== null && <Dot tone={tone} breathe={tone === 'live'} />}
          <span>{STATE_LABEL[state]}</span>
          {age !== null && <span className="jira-list-mark">{age}</span>}
        </div>
      </td>
      <td className="jira-list-ticket">
        <div className="jira-list-flex">
          <span className="jira-card-type" title={issue.type.name}>
            <JiraTypeIcon type={issue.type} />
          </span>
          <span className="jira-card-key">{row.key}</span>
          <button type="button" className="jira-list-title" onClick={open}>
            {issue.summary}
          </button>
        </div>
      </td>
      <td className="jira-list-run">{run}</td>
      <td className="jira-list-repo">
        <span>{repoBasename(row.repo)}</span>
        {row.branch !== null && row.branch !== '' && <span className="jira-list-branch">{row.branch}</span>}
      </td>
      <td>{where ?? '—'}</td>
      <td title={effort ?? undefined}>{model ?? '—'}</td>
      <td className="jira-list-ctx">
        {pct === undefined ? (
          '—'
        ) : (
          <>
            <span className="jira-list-ctx-bar" aria-hidden="true">
              <i style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
            </span>
            {Math.round(pct)}%
          </>
        )}
      </td>
      <td>{startedLabel(row.startedAt, now, zone)}</td>
      <td>{forLabel(row, now)}</td>
      <td className="jira-list-open">
        <div className="jira-list-flex">
          {buttons !== null && sessionId !== null && (
            <>
              <OpenChip button={buttons.primary} sessionId={sessionId} row={sessionRow} launch={link?.surface ?? null} primary={!row.ended} onHandover={onHandover} />
              {buttons.secondary !== null && <OpenChip button={buttons.secondary} sessionId={sessionId} row={sessionRow} launch={link?.surface ?? null} primary={false} onHandover={onHandover} />}
            </>
          )}
          {canRun && <JiraRunMenu issue={issue} onPick={(action) => onRun(issue, action)} />}
        </div>
      </td>
    </tr>
  );
}
