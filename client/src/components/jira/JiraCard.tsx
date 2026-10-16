import { cardAgeStamp, crumbOf, crumbText, initialsOf, subtasksMarker } from '../../lib/jira';
import type { JiraBoard, JiraIssue } from '../../../../shared/types';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Marker } from '../ui/Marker';
import { Pill } from '../ui/Pill';

/**
 * JiraCard — one issue on the Jira board (Jira phase 2, spec §6.2; DESIGN.md §8.9.1, which applies §8.3's card to a Jira issue).
 *
 * **It is the Board's card, not a second one.** The ground, the radius, the face's padding and gap, the title's 14/500 and the marker row are `.board-card`,
 * `.board-card-face`, `.board-card-title`, `.board-card-foot`, `.board-card-meta` and `.board-card-markers` — composed, never restated — so a density or
 * theme change to the Board's card moves this one with it. What a Jira issue has that a backlog item does not is ONE row: the head (type icon, key, crumb),
 * which is the only family this file adds (`.jira-card-*`), plus the initials disc in the foot. The column already says the status CATEGORY; the pill
 * carries the RAW status name, because `In Review` and `In Progress` are one column and two very different facts to the person reading it.
 *
 * **Everything the card prints comes from `lib/jira.ts`.** The crumb's words (`root`, `↳ PAY-120 Refund flows`, `Assigned to me`) are `crumbText`'s, the
 * initials `initialsOf`'s, the age `cardAgeStamp`'s (a relative `4m` / `2d`, aged against the page's `now` so every card shares one clock), the subtasks marker
 * `subtasksMarker`'s — this file holds no copy of any of them (spec §6.1's one-home rule).
 *
 * **The browser never talks to Jira.** The person is initials on a disc, never Jira's `avatarUrls` — an `<img>` would be a request to Atlassian from every
 * reader's browser, with their cookies. The one link out is the issue's `url` exactly as the SERVER built it, in a new tab with no referrer; the card never
 * composes a Jira URL of its own.
 *
 * No `Run ▾` and no live strip: both are phase 5 (spec §12). The marker row draws only when it has something to say (a priority, a subtask count), the way
 * the Board's draws only when a marker applies.
 *
 * The whole card is a `role="button"` that opens the issue (`onOpen`, which the page wires to the issue modal's slot), Enter and Space included, exactly as
 * `ItemCard`; the link out stops both the click and those two keys for the reasons `ItemCard`'s own link spells out at length — without it one click opens
 * Jira AND the modal, and the card's `preventDefault()` on Enter would cancel the anchor's own activation.
 */
export function JiraCard({
  issue,
  board,
  me,
  now,
  onOpen
}: {
  issue: JiraIssue;
  board: JiraBoard;
  me: { accountId: string } | null;
  now: number;
  onOpen: (issue: JiraIssue) => void;
}) {
  const crumb = crumbText(crumbOf(issue, board, me));
  const subtasks = subtasksMarker(issue.subtasks);
  const open = (): void => onOpen(issue);

  return (
    <div
      className="board-card"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="board-card-face">
        <div className="jira-card-head">
          {/* The type is the icon's title rather than a word on the row: the key and the crumb need the width, and the type is the reading a person
              hovers for, not the one they scan by. */}
          <span className="jira-card-type" title={issue.type.name}>
            <JiraTypeIcon type={issue.type} />
          </span>
          <span className="jira-card-key">{issue.key}</span>
          {crumb !== null && <span className="jira-card-crumb">{crumb}</span>}
        </div>
        <div className="board-card-title">{issue.summary}</div>
        <div className="board-card-foot">
          <span className="jira-card-who">
            {/* Initials only (never an avatar image — see the header); an unassigned issue draws the empty disc, so the row does not shift by a disc's
                width between one card and the next. */}
            <span className={issue.assignee === null ? 'jira-card-av none' : 'jira-card-av'} aria-hidden="true">
              {issue.assignee === null ? '' : initialsOf(issue.assignee.name)}
            </span>
            <span className="jira-card-name">{issue.assignee === null ? 'unassigned' : issue.assignee.name}</span>
          </span>
          <Pill tone="neutral">{issue.status.name}</Pill>
          <span className="board-card-meta">{cardAgeStamp(issue, now)}</span>
          <a
            className="board-card-link"
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`open ${issue.key} in Jira`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
            }}
          >
            ↗
          </a>
        </div>
        {(issue.priority !== null || subtasks !== null) && (
          <div className="board-card-markers" data-testid="marker-row">
            {/* `kind`, the marker's quiet `--ink3` word: a priority is a fact about the issue, not a state this board should colour — §8's "marks state
                by ink, never by accent" — and Jira's own five-colour priority scale would be a second palette on the card. */}
            {issue.priority !== null && <Marker tone="kind">{issue.priority}</Marker>}
            {subtasks !== null && <Marker tone="kind">{subtasks}</Marker>}
          </div>
        )}
      </div>
    </div>
  );
}
