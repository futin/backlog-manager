import type { JiraMentionIssue } from '../../../../shared/types';
import { elapsedSince } from '../../lib/item-age';
import { initialsOf, statusTone, typeTone } from '../../lib/jira';
import { excerptParts, mentionIssueType, type JiraMentionRow } from '../../lib/jira-mentions';
import { browserPlatform, fullPageTitle, wantsPage } from '../../lib/open-intent';
import { Chip } from '../ui/Chip';
import { Glyph } from '../ui/Glyphs';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Pill } from '../ui/Pill';

/**
 * DESIGN.md §8.9.7 — Jira › Mentions › List: one row per open mention, in the Board › List's table language (Jira mentions phase 1, Task 8; spec "The page";
 * mock `Main.dc.html`).
 *
 * **The Board's table, not a second one.** The frame, the scroll box, the 44 px single-line rows, the hover fill and the cell marks are `JiraIssueList`'s
 * `.jira-issues-*` classes, worn as they are: the type tile (`.jira-card-type`), the status dot (`.jira-status-dot`) and the initials disc (`.jira-card-av`)
 * mean here what they mean on a board card. `JiraIssueList` is not lifted into a shared shell: its frame is four elements and its rows share no cell with these
 * past the marks, so a shell would be a component with a prop per difference. What differs is the column set — Key, Summary, Asked by, Comment, Status, Boards,
 * When, actions — so the table also wears `.jira-mentions-table`, which re-sizes every column (the issue table's widths are keyed by position, and its
 * Session-first order is not this one's).
 *
 * **Asked by is an initials disc, never the avatar.** The payload carries Jira's avatar URL, but DESIGN.md §8.9's standing rule is that the browser never talks
 * to Jira — no avatar image — so the disc is `initialsOf` on the magenta tint, the board card's own.
 *
 * **The Comment cell** is the excerpt on one ellipsised line, the whole excerpt in the cell's `title`, with every `@<me>` drawn as a tinted chip where the
 * comment put it (`excerptParts`). **Boards** names the boards holding the ticket, or a muted `none`.
 *
 * **Actions fade in on hover or focus**, the Run cell's rule: `Dismiss` (every open mention on the TICKET — the user answers a thread, not a comment) or, on
 * a dismissed row, `Restore`, then `Open ticket page` (a document icon chip, the board's full page for the ticket; the key button does the same on a Cmd-, Ctrl- or
 * middle-click, `wantsPage`, as a card or row on the Board does) and `Open in Jira`, a link to the focused comment in a new tab with no referrer. A dismissed
 * row (Show dismissed on) is dimmed, its actions always shown, since Restore is the only thing to do with it.
 *
 * **The key and the excerpt open the mention modal on THIS row's mention** (`onOpen`, Task 10): each is a `.jira-mentions-open` button worn as the text it
 * replaces, so the keyboard reaches them and the cell keeps its ellipsis. Not the whole row — its Dismiss and Open in Jira sit in it, and a row-wide click
 * target would make every miss of those a dialog.
 */
export function JiraMentionList({
  rows,
  me,
  now,
  onDismiss,
  onRestore,
  onOpen,
  onOpenPage
}: {
  rows: readonly JiraMentionRow[];
  /** The user's Jira display name, for the `@` chip; `null` draws the excerpt plain. */
  me: string | null;
  now: number;
  onDismiss: (issue: JiraMentionIssue) => void;
  onRestore: (issue: JiraMentionIssue) => void;
  onOpen: (row: JiraMentionRow) => void;
  /** Opens the ticket's full page: the `Open ticket page` icon chip, and a Cmd-, Ctrl- or middle-click on the key (`wantsPage`). */
  onOpenPage: (issue: JiraMentionIssue) => void;
}) {
  return (
    <div className="jira-issues-frame">
      <div className="jira-issues-scroll" role="region" aria-label="Mentions">
        <table className="jira-issues-table jira-mentions-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Summary</th>
              <th scope="col">Asked by</th>
              <th scope="col">Comment</th>
              <th scope="col">Status</th>
              <th scope="col">Boards</th>
              <th scope="col">When</th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <MentionRow key={row.mention.commentId} row={row} me={me} now={now} onDismiss={onDismiss} onRestore={onRestore} onOpen={onOpen} onOpenPage={onOpenPage} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MentionRow({
  row,
  me,
  now,
  onDismiss,
  onRestore,
  onOpen,
  onOpenPage
}: {
  row: JiraMentionRow;
  me: string | null;
  now: number;
  onDismiss: (issue: JiraMentionIssue) => void;
  onRestore: (issue: JiraMentionIssue) => void;
  onOpen: (row: JiraMentionRow) => void;
  /** Opens the ticket's full page: the `Open ticket page` icon chip, and a Cmd-, Ctrl- or middle-click on the key (`wantsPage`). */
  onOpenPage: (issue: JiraMentionIssue) => void;
}) {
  const { issue, mention, dismissed } = row;
  const type = mentionIssueType(issue.type);
  return (
    <tr className="jira-issues-row jira-mentions-row" data-key={issue.key} data-dismissed={dismissed ? '' : undefined}>
      <td className="jira-issues-key">
        <button
          type="button"
          className="jira-mentions-open"
          title={fullPageTitle(browserPlatform())}
          onClick={(e) => (wantsPage(e) ? onOpenPage(issue) : onOpen(row))}
          onAuxClick={(e) => {
            if (wantsPage(e)) onOpenPage(issue);
          }}
        >
          {issue.key}
        </button>
      </td>
      <td title={issue.summary}>
        <span className="jira-issues-flex">
          <span className="jira-card-type" data-tone={typeTone(type)} title={issue.type} aria-hidden="true">
            <JiraTypeIcon type={type} />
          </span>
          <span className="jira-issues-cut">{issue.summary}</span>
          {/* Phase 2: a drafted reply waits on the reader — the warn tone, "waiting on a person". Every row of the ticket carries it: the draft is the
              ticket's. The `.jira-mentions-marker` wrapper holds it at its own width: as a bare flex child of the row it shrank to 25 px ("Draft read")
              beside a long summary, because `.ui-pill` carries no `flex: none` and guard 7 forbids page CSS naming it (ui-verify). */}
          {issue.draft !== null && (
            <span className="jira-mentions-marker">
              <Pill tone="warn">Draft ready</Pill>
            </span>
          )}
        </span>
      </td>
      <td>
        <span className="jira-issues-flex">
          <span className="jira-card-av" aria-hidden="true">
            {initialsOf(mention.author.name)}
          </span>
          <span className="jira-issues-cut">{mention.author.name}</span>
        </span>
      </td>
      <td className="jira-mentions-comment" data-col="comment" title={mention.excerpt}>
        <button type="button" className="jira-mentions-open" onClick={() => onOpen(row)}>
          {excerptParts(mention.excerpt, me).map((p, i) =>
            p.me ? (
              <span key={i} className="jira-mentions-at">
                {p.text}
              </span>
            ) : (
              p.text
            )
          )}
        </button>
      </td>
      <td>
        <span className="jira-issues-flex">
          <span className="jira-status-dot" data-tone={statusTone(issue.status.category)} aria-hidden="true" />
          <span className="jira-issues-cut">{issue.status.name}</span>
        </span>
      </td>
      <td className={issue.boards.length === 0 ? 'jira-issues-muted' : undefined} data-col="boards" title={issue.boards.join(', ') || undefined}>
        {issue.boards.length === 0 ? 'none' : issue.boards.join(', ')}
      </td>
      <td className="jira-issues-updated">{elapsedSince(mention.created, now) ?? ''}</td>
      <td className="jira-issues-act">
        <span className="jira-mentions-acts">
          {dismissed ? (
            <Chip size={28} onClick={() => onRestore(issue)}>
              Restore
            </Chip>
          ) : (
            <Chip size={28} onClick={() => onDismiss(issue)}>
              Dismiss
            </Chip>
          )}
          <Chip size={28} icon={<Glyph name="document" />} aria-label="Open ticket page" title="Open ticket page" onClick={() => onOpenPage(issue)}>
            {null}
          </Chip>
          <Chip size={28} as="a" href={mention.url} icon={<Glyph name="external" />} aria-label="Open in Jira" title="Open in Jira">
            {null}
          </Chip>
        </span>
      </td>
    </tr>
  );
}
