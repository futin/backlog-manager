import { cardAgeStamp, crumbOf, crumbText, initialsOf, matchMarker, sessionStrip, type cardFold, type JiraCardSession } from '../../lib/jira';
import type { JiraAction, JiraBoard, JiraIssue } from '../../../../shared/types';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { LiveStrip } from '../ui/LiveStrip';
import { Marker } from '../ui/Marker';
import { Pill } from '../ui/Pill';
import { SpreadBar } from '../ui/SpreadBar';
import { JiraRunMenu } from './JiraRunMenu';

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
 * initials `initialsOf`'s, the age `cardAgeStamp`'s (a relative `4m` / `2d`, aged against the page's `now` so every card shares one clock), the fold
 * block's line and caption `cardFold`'s — this file holds no copy of any of them (spec §6.1's one-home rule).
 *
 * **A card is a TOP issue** (grouped-board spec §3–§4): every on-board descendant folds into it, and `fold` is what the card says about them — the
 * `C children · D below them` line, then `SpreadBar` with its `done · in progress · to do` caption — drawn after the foot and before the marker row,
 * and only when something is folded. The `N subtasks` marker this card used to draw is gone: `JiraIssue.subtasks` counts Jira subtasks on the board or
 * not, and a subtask off the board is not this board's business, so nothing here reads it. The age stays the top's OWN, never the newest under it (that
 * is only the column's sort key, and it is never drawn).
 *
 * **The browser never talks to Jira.** The person is initials on a disc, never Jira's `avatarUrls` — an `<img>` would be a request to Atlassian from every
 * reader's browser, with their cookies. The one link out is the issue's `url` exactly as the SERVER built it, in a new tab with no referrer; the card never
 * composes a Jira URL of its own.
 *
 * **The ring answers "why is this here"** (F1, grouped-board spec §5). `matches` holds the keys of folded issues that match the page's filter or search
 * when this top does NOT match on its own; then the card carries a 2 px `--amber-solid` inset ring (`.jira-card-match`) and, first on its marker row, a
 * `match` marker — `1 match: PAY-162`, or `N matches` with the keys in its title. A card that matches on its own needs no answer, so `matches` is empty
 * and neither is drawn; with no filter and no search every top matches itself, so nothing is ever ringed then — no special case. The ring is a page
 * class rather than a `.board-card` variant: it is this board's reading of a filter, not a look the Board's card has.
 *
 * **`Run ▾` and the live strip** (Jira phase 5, spec §6.2, §7; DESIGN.md §8.9.1). The marker row is ALWAYS drawn now — `Run ▾` is its last item, pushed to
 * the right edge (`JiraRunMenu`; it stops the card's click and Enter/Space, as the link out does). A session on this issue, or on any issue folded under
 * it, draws a `LiveStrip` (`board-card-live hatch`, the Board's look) before the face, one per session, the folded ones naming their key — a folded issue
 * is not a card, so without that its session would show nowhere on the board. `sessions` is `cardSessions`' list, computed once by the page.
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
  fold,
  matches,
  sessions,
  onOpen,
  onRun
}: {
  issue: JiraIssue;
  board: JiraBoard;
  me: { accountId: string } | null;
  now: number;
  fold: ReturnType<typeof cardFold>;
  matches: readonly string[];
  sessions: readonly JiraCardSession[];
  onOpen: (issue: JiraIssue) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const crumb = crumbText(crumbOf(issue, board, me));
  const match = matchMarker(matches);
  const open = (): void => onOpen(issue);

  return (
    <div
      className={match === null ? 'board-card' : 'board-card jira-card-match'}
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
      {/* The strips sit OUTSIDE the face, as ItemCard's does, so they reach the card's own edges (§8.3). */}
      {sessions.map((entry) => {
        const strip = sessionStrip(entry, now);
        return <LiveStrip key={entry.key} tone="session" label={strip.label} mark={strip.mark} title={strip.title} />;
      })}
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
        {fold !== null && (
          <div className="jira-card-fold">
            <div className="jira-card-fold-line">{fold.line}</div>
            <SpreadBar done={fold.progress.done} doing={fold.progress.doing} todo={fold.progress.todo} caption={fold.caption} />
          </div>
        )}
        <div className="board-card-markers" data-testid="marker-row">
          {match !== null && (
            <Marker tone="match" title={match.title}>
              {match.word}
            </Marker>
          )}
          {/* `kind`, the marker's quiet `--ink3` word: a priority is a fact about the issue, not a state this board should colour — §8's "marks state
              by ink, never by accent" — and Jira's own five-colour priority scale would be a second palette on the card. */}
          {issue.priority !== null && <Marker tone="kind">{issue.priority}</Marker>}
          <JiraRunMenu issue={issue} onPick={(action) => onRun(issue, action)} />
        </div>
      </div>
    </div>
  );
}
