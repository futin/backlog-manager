import { useEffect, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { JIRA_COLUMNS, displayPath, initialsOf, issueDatesLine, modalTree, progressLine, type JiraChildrenIndex } from '../../lib/jira';
import { renderMarkdown } from '../../lib/markdown';
import type { JiraIssue, JiraIssueDetail } from '../../../../shared/types';
import { Fact } from '../ui/Fact';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Modal } from '../ui/Modal';
import { Pill } from '../ui/Pill';
import { SpreadBar } from '../ui/SpreadBar';

/**
 * JiraIssueModal — one Jira issue's detail, READ-ONLY (Jira phase 2, spec §6.3 minus its controls; DESIGN.md §8.9.2, which applies §8.7's sidecar to a
 * Jira issue).
 *
 * **It is the item modal's twin, not a second modal design.** It composes `ui/Modal` exactly as `board/ItemModal.tsx` does — so the scrim, the close
 * control, the Escape key (the LIFO stack in `useDialogEscape`, called by the shell and never here) and the 700 px fold are the shell's — and draws the same
 * facts column through `ui/Fact` and the same body through `.item-body`. `Modal`'s composer list is `[ItemModal, JiraIssueModal]` and a third is a design
 * change.
 *
 * **Phase 2 has no controls.** No `Assign to me`, `Move to…`, `Run ▾` or `Stop session`, and no `session` fact: the controls row is ABSENT, not drawn
 * disabled, because a disabled control is a promise that a later phase has not kept yet. `JiraIssueDetail.session` is still typed `null`, and so is unread.
 *
 * **Two sources, one column.** The card hands over the `JiraIssue` it was drawn from, and every fact the card already carries is drawn from it at once —
 * the modal opens with a full column rather than a spinner. The detail (`GET /api/jira/issue/:key`, read fresh on open) then supplies the three things a
 * card cannot: the description, the children, and the boards that hold the issue; it also replaces the card's copy, which may be one poll old. A failed read
 * leaves the card's facts exactly as they were and says so where the body would be, with the server's own sentence (`could not read the ticket — Jira
 * unreachable: timeout`), because a column that blanked on a Jira blip would take the readable half down with the unreadable one.
 *
 * **The browser never talks to Jira.** The one request is to `/api/jira/issue/…`; the link out is the issue's `url` as the SERVER built it, rendered as
 * given in a new tab with no referrer, and the description goes in through `renderMarkdown` — the sanitising renderer that drops raw HTML and refuses a
 * `javascript:` href (see its header), which matters more here than on a backlog item, because this text was typed by anyone with access to the Jira site.
 *
 * **State belongs to a key.** The held answer is stamped with the issue key it was read for, and only that key's answer is read: reopening the modal on
 * another issue while a read is in flight never paints the first issue's description under the second one's title, and a late answer for a key the modal
 * has left is dropped. Facts that come from the detail (`on boards`) are simply absent while the held answer is for another key — and also once it has landed, if none of the
 * boards it names is one the shell's status knows (a board deleted a moment ago): the spec lists the fact unconditionally, but a label with nothing under it is
 * the empty fact `Fact`'s own header says never to draw.
 *
 * Repositories are read from the shell's one status (`useJiraContext`): the mapped paths for the issue's PROJECT key through `displayPath` (the same `~`
 * reading the Setup card gives), or the hint that says where to map one. The `created · updated` line (`issueDatesLine`) takes `Date.now()` once per render and ticks nothing — the modal is
 * opened, read and closed, the reasoning `ItemModal` gives for the same choice.
 *
 * **Children are a tree, and a row swaps THIS modal's issue** (DESIGN.md §8.9.2; grouped-board spec §6). The detail's `children` are the direct children,
 * fresh; under each hang its descendants from `childrenOf`, the board's fold index as it stood when the card was clicked (`modalTree`). That snapshot is not
 * refreshed by later board polls: the tree costs no Jira call beyond the one read this modal already makes, and a row a poll moved is at worst one poll old
 * while the direct children never are. `null` (no board behind the modal) draws the direct children only. The head row counts the DIRECT children in its
 * pill and says `N in all` only when the tree draws more rows than that; the spread bar counts the rows as drawn. No filter marking inside the tree — the
 * filter ring is the card's (spec §8 non-goal). A row click hands the row's issue and the SAME snapshot to `onOpenIssue`, which is the very setter the board
 * calls, so `JiraView` swaps the one modal's issue and the key-stamped read below fetches the new detail. Never a second `Modal`: Escape has one owner, and a
 * stack of issue modals would make it close one layer of a walk the reader thinks of as one dialog.
 */

type Held = { key: string; detail: JiraIssueDetail } | { key: string; failure: string };

/** What a status category reads as in a fact — `JIRA_COLUMNS`' own labels, lower-cased, so the column and the modal never name one category two ways. */
function categoryWord(category: JiraIssue['status']['category']): string {
  return (JIRA_COLUMNS.find((c) => c.category === category)?.label ?? 'To Do').toLowerCase();
}

/** The sentence a failed read carries: the server's `{ error }` when it sent one, else the HTTP status, else whatever the network said. */
async function failureOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    /* not JSON — fall through to the status */
  }
  return `HTTP ${res.status}`;
}

/**
 * The shape guard the detail is read through (`isJiraStatusPayload`'s role and reason): the three fields the body MAPS or READS without a null-safe
 * expression. A body missing one would throw inside a render and React would unmount the whole page under the modal, so it is a failed read instead.
 */
function isIssueDetail(value: unknown): value is JiraIssueDetail {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.description === 'string' && Array.isArray(d.children) && Array.isArray(d.boards);
}

export function JiraIssueModal({
  issue,
  childrenOf,
  onOpenIssue,
  onClose
}: {
  issue: JiraIssue;
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  onClose: () => void;
}) {
  const { data } = useJiraContext();
  const [held, setHeld] = useState<Held | null>(null);

  useEffect(() => {
    let alive = true;
    const key = issue.key;
    setHeld(null);
    fetch(`/api/jira/issue/${encodeURIComponent(key)}`)
      .then(async (res) => {
        if (!res.ok) return { key, failure: await failureOf(res) } as Held;
        const body: unknown = await res.json();
        return isIssueDetail(body) ? ({ key, detail: body } as Held) : ({ key, failure: 'malformed response' } as Held);
      })
      .catch((e: unknown) => ({ key, failure: e instanceof Error ? e.message : String(e) }) as Held)
      .then((next) => {
        if (alive) setHeld(next);
      });
    return () => {
      alive = false;
    };
  }, [issue.key]);

  const mine = held !== null && held.key === issue.key ? held : null;
  const detail = mine !== null && 'detail' in mine ? mine.detail : null;
  const failure = mine !== null && 'failure' in mine ? mine.failure : null;
  // The detail's copy is the fresher one; the card's is what the column draws until it lands (or for good, when the read fails).
  const src: JiraIssue = detail ?? issue;

  const now = Date.now();
  const boardNames = detail === null || data === null ? [] : data.boards.filter((b) => detail.boards.includes(b.id)).map((b) => b.name);
  const paths = data?.repos[src.project.key] ?? [];
  const typeLine = [src.type.name, src.parent === null ? null : `${src.parent.key} ${src.parent.summary}`].filter((p) => p !== null).join(' · ');
  const priorityLine = [src.priority, src.sprint].filter((p) => p !== null && p !== '').join(' · ');
  const people = `${src.assignee === null ? 'unassigned' : src.assignee.name}${src.reporter === null ? '' : ` · ${src.reporter}`}`;

  const facts = (
    <div className="item-facts">
      <div className="jira-modal-key">
        <span className="jira-modal-keyname">{src.key}</span>
        <a href={src.url} target="_blank" rel="noreferrer">
          open in Jira ↗
        </a>
      </div>
      <dl className="item-facts-list">
        <Fact label="type · parent">{typeLine}</Fact>
        <Fact label="status">{`${src.status.name} · ${categoryWord(src.status.category)}`}</Fact>
        {priorityLine !== '' && <Fact label="priority · sprint">{priorityLine}</Fact>}
        <Fact label="assignee · reporter">{people}</Fact>
        {src.labels.length > 0 && <Fact label="labels">{src.labels.join(', ')}</Fact>}
        <Fact label="created · updated">{issueDatesLine(src, now)}</Fact>
        {boardNames.length > 0 && <Fact label="on boards">{boardNames.join(', ')}</Fact>}
        <Fact label="repository">
          {data === null || paths.length === 0 ? (
            `no repository mapped for ${src.project.key} — Jira › Setup › Repositories`
          ) : (
            <span className="item-facts-path">{paths.map((p) => displayPath(p, data.home)).join(', ')}</span>
          )}
        </Fact>
      </dl>
    </div>
  );

  return (
    <Modal label={`${src.key} ${src.summary}`} facts={facts} onClose={onClose}>
      <h2 className="item-body-title">{src.summary}</h2>
      <div className="item-body">
        {failure !== null ? (
          <div className="drawer-empty">{`could not read the ticket — ${failure}`}</div>
        ) : detail === null ? (
          <div className="drawer-empty">loading…</div>
        ) : (
          <>
            {detail.description.trim() === '' ? (
              <p className="jira-modal-none">no description</p>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.description) }} />
            )}
            {detail.children.length > 0 && <ChildrenTree selfKey={detail.key} direct={detail.children} childrenOf={childrenOf} onOpenIssue={onOpenIssue} />}
          </>
        )}
        <p className="jira-modal-comments">
          Comments stay in Jira — v1 neither reads nor writes them.{' '}
          <a href={src.url} target="_blank" rel="noreferrer">
            {`${src.key} in Jira ↗`}
          </a>
        </p>
      </div>
    </Modal>
  );
}

/** The Children section — head row, spread bar, tree — over `modalTree` (see the header). Drawn only when the detail has direct children. */
function ChildrenTree({
  selfKey,
  direct,
  childrenOf,
  onOpenIssue
}: {
  selfKey: string;
  direct: readonly JiraIssue[];
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
}) {
  const { rows, progress } = modalTree(selfKey, direct, childrenOf);
  return (
    <>
      <div className="jira-tree-head">
        <h3>Children</h3>
        <Pill tone="neutral">{direct.length}</Pill>
        {rows.length > direct.length && <span className="jira-tree-all">{`${rows.length} in all`}</span>}
      </div>
      {/* Wrapped, because the spacing is this surface's and the primitive's own selectors stay in the ui block (design-guard 7). */}
      <div className="jira-tree-spread">
        <SpreadBar done={progress.done} doing={progress.doing} todo={progress.todo} caption={progressLine(progress)} />
      </div>
      <ul className="jira-tree">
        {rows.map(({ issue: row, depth }) => (
          // The indent is the one inline style: a depth is data, and a class per depth would cap how deep a tree may go.
          <li key={row.key} data-depth={depth} style={{ paddingLeft: depth * 22 }}>
            <button type="button" className="jira-tree-row" onClick={() => onOpenIssue(row, childrenOf)}>
              <JiraTypeIcon type={row.type} />
              {/* The spaces between the spans are what the button's accessible name reads as word breaks: `PAY-162 Ledger rounding fix`. */}
              <span className="jira-tree-key">{row.key}</span> <span className="jira-tree-summary">{row.summary}</span>{' '}
              {/* The card's own disc: initials or the empty one, never an image, so every row's status pill lines up. */}
              <span className={row.assignee === null ? 'jira-card-av none' : 'jira-card-av'} aria-hidden="true">
                {row.assignee === null ? '' : initialsOf(row.assignee.name)}
              </span>
              <Pill tone="neutral">{row.status.name}</Pill>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
