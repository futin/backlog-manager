import { useEffect, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useNow } from '../../hooks/useNow';
import { JIRA_BOARD_FILTER_FROM, JIRA_BOARD_KEY, boardRowLine, boardsForSetup } from '../../lib/jira';
import type { JiraPage } from '../../lib/jira-page';
import type { JiraBoard, JiraBoardStatus } from '../../../../shared/types';
import { Band } from '../ui/Band';
import { Chip } from '../ui/Chip';
import { Pill } from '../ui/Pill';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { JiraBoardSheet, errorOf, type JiraProjectList } from './JiraBoardSheet';
import { JiraConnectionGroup } from './JiraConnectionGroup';
import { JiraReposGroup } from './JiraReposGroup';

/**
 * Jira › Setup (Jira phase 2, spec §6.4; `Setup.html`, `BoardsTen.html`; DESIGN.md §8.9.3, and §8.6 for the card language it borrows whole).
 *
 * Settings' shape on purpose: a band (`Setup`, the `this machine` pill — everything on this page is written to `~/.backlog-manager/settings/jira.json` on
 * the host, so it is Settings › Shared's scope word), then cards composed from `SettingsGroup` / `SettingsRow` in Settings' own two hand-balanced columns
 * (`.set-cols` / `.set-col`, folding to one at Settings' 1100 px — which also covers the plan's "stacking below 700 px"; a third breakpoint for the same
 * card language would let the two pages fold at different widths for no reason). Hand-balanced for §8.6's reason: a masonry reflow would move a card to
 * the other side as its neighbour grew a row. The left column is Boards, then Repositories; the right is Connection and, in phase 5,
 * Skills — the mock's split, which keeps the two cards a person edits on one side and the report on the other.
 *
 * **The Boards card** (this task): a `New board` chip in the head; one row per board in `boardsForSetup`'s order (by name, `off` boards last), each its name
 * over `boardRowLine`'s sentence with the last sweep's failure in red beside it, and two chips — `Open board`, which stores the pick under
 * `JIRA_BOARD_KEY` and then calls `onOpenJiraPage('board')`, the rail's own navigation threaded down from `App` (so it means what the tree's `Board` entry
 * means, by construction — this page draws no page switch of its own, the Runs/Settings rule), and `Edit`, which opens `JiraBoardSheet`. From the sixth
 * board (`JIRA_BOARD_FILTER_FROM`) a filter field sits above the rows, a case-insensitive substring of the name, per mount and never persisted. A
 * `jira.json` the server cannot read says so in the card, in the Board page's own words, never as `No boards yet` (Review Focus 2) — an empty card would
 * invite a person to recreate boards that are still in the file.
 *
 * The pick is written straight to `localStorage` rather than through a `usePersistedState` of this page's own: that hook writes in an effect, and this page
 * unmounts in the same commit `onOpenJiraPage` causes, so its effect would never run — while the Board page's `usePersistedState` reads the key in its
 * initializer as it mounts. The value is JSON, as that hook stores it; `pickBoard` resolves it against the live list, so a stale value can never become a
 * request (Review Focus 3).
 *
 * **The ONE `/api/jira/projects` read** is this page's, per mount (spec §5: fetched when Setup opens, never on the poll). The sheet's `Unresolved in a
 * project…` `Select` and the Repositories card are handed the list; neither fetches it, so opening the sheet five times costs Jira nothing.
 */
export function JiraSetupView({ onOpenJiraPage }: { onOpenJiraPage: (p: JiraPage) => void }) {
  const { data } = useJiraContext();
  const projects = useProjectsOnce();
  // The board the sheet edits, snapshotted when it opened (`null` inside = a new board; the outer `null` = no sheet). See JiraBoardSheet's header for why
  // a status reload must not re-seed it.
  const [sheet, setSheet] = useState<{ board: JiraBoard | null } | null>(null);

  const openBoard = (b: JiraBoardStatus): void => {
    try {
      localStorage.setItem(JIRA_BOARD_KEY, JSON.stringify(b.id));
    } catch {
      /* private mode / quota: the Board page then draws its own fallback pick, which is still a board */
    }
    onOpenJiraPage('board');
  };

  return (
    <div className="set jira-setup">
      <Band title="Setup" sub="the boards this machine follows, and where each Jira project's code lives · ~/.backlog-manager/settings/jira.json">
        <Pill tone="neutral">this machine</Pill>
      </Band>
      <div className="set-cols">
        <div className="set-col">
          <BoardsGroup
            boards={data?.boards ?? []}
            unreadable={data?.configUnreadable ?? null}
            onNew={() => setSheet({ board: null })}
            onEdit={(b) => setSheet({ board: b })}
            onOpen={openBoard}
          />
          <JiraReposGroup projects={projects} />
        </div>
        <div className="set-col">
          <JiraConnectionGroup />
        </div>
      </div>
      {sheet !== null && (
        <JiraBoardSheet board={sheet.board} projects={projects} onClose={() => setSheet(null)} onSaved={() => setSheet(null)} />
      )}
    </div>
  );
}

/** `GET /api/jira/projects`, once per mount of this page. A failure is kept as the server's sentence, so the `Select` that needs it can say why it is empty. */
function useProjectsOnce(): JiraProjectList {
  const [state, setState] = useState<JiraProjectList>({ list: null, error: null });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/jira/projects');
        const body: unknown = await res.json().catch(() => null);
        if (!live) return;
        if (res.ok && Array.isArray(body)) setState({ list: body as { key: string; name: string }[], error: null });
        else setState({ list: null, error: errorOf(body, `the project list could not be read (HTTP ${res.status})`) });
      } catch {
        if (live) setState({ list: null, error: 'the project list could not be read — the server did not answer' });
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function BoardsGroup({
  boards,
  unreadable,
  onNew,
  onEdit,
  onOpen
}: {
  boards: readonly JiraBoardStatus[];
  unreadable: string | null;
  onNew: () => void;
  onEdit: (b: JiraBoardStatus) => void;
  onOpen: (b: JiraBoardStatus) => void;
}) {
  // Each row's age reads `polled 12 s ago` under a minute (`pollAge`), so the clock ticks by the second, as the Board page's band does.
  const now = useNow(true, 1_000);
  const [filter, setFilter] = useState('');
  const sorted = boardsForSetup(boards);
  const filtering = sorted.length >= JIRA_BOARD_FILTER_FROM;
  const needle = filter.trim().toLowerCase();
  const shown = filtering && needle !== '' ? sorted.filter((b) => b.name.toLowerCase().includes(needle)) : sorted;

  return (
    <SettingsGroup
      title="Boards"
      scope="this machine · a board is a named set of roots and queries, polled on its own interval"
      right={
        <Chip size={28} onClick={onNew}>
          New board
        </Chip>
      }
    >
      {unreadable !== null ? (
        <div className="set-row">
          <span className="set-error">jira.json cannot be read — {unreadable}</span>
        </div>
      ) : sorted.length === 0 ? (
        <div className="set-row">
          <span className="set-hint">No boards yet — New board starts one. A board needs at least one root or one query.</span>
        </div>
      ) : (
        <>
          {filtering && (
            <div className="set-row jira-setup-filter">
              <input
                className="set-text"
                type="text"
                aria-label="Filter boards"
                placeholder="filter boards"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <span className="set-hint">sorted by name · off boards last</span>
            </div>
          )}
          {shown.map((b) => {
            const line = boardRowLine(b, now);
            return (
              <SettingsRow
                key={b.id}
                name={b.name}
                hint={
                  <>
                    {line.text}
                    {line.failure !== null && (
                      <>
                        {' · '}
                        <span className="jira-setup-failure">{line.failure}</span>
                      </>
                    )}
                  </>
                }
              >
                <Chip size={28} aria-label={`Open board ${b.name}`} onClick={() => onOpen(b)}>
                  Open board
                </Chip>
                <Chip size={28} aria-label={`Edit ${b.name}`} onClick={() => onEdit(b)}>
                  Edit
                </Chip>
              </SettingsRow>
            );
          })}
        </>
      )}
    </SettingsGroup>
  );
}
