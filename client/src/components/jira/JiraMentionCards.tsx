import type { JiraMentionIssue } from '../../../../shared/types';
import { initialsOf, statusTone, typeTone } from '../../lib/jira';
import { askedAge, earlierText, excerptParts, mentionCards, mentionIssueType, type JiraMentionRow } from '../../lib/jira-mentions';
import { Chip } from '../ui/Chip';
import { Glyph } from '../ui/Glyphs';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';

/**
 * DESIGN.md §8.9.1 — Jira › Mentions › Cards: one card per ticket (Jira mentions phase 1, Task 9; spec "The page", Cards; mock `ListB.dc.html`).
 *
 * **One card per TICKET, quoting the newest mention.** `mentionCards` groups the rows the page filtered; the quote is the newest open comment ("Mara Ilić asked
 * you · 2 h ago" over the excerpt, every `@<me>` the List's tinted chip), and `+N earlier mention(s)` says what else the thread holds. The card wears the board
 * card's marks — the type tile, the status dot, the initials disc — and the page's own `.jira-mentions-card` classes for the frame and the two-column grid, which
 * falls to one column below 1000 px by a CSS media rule, the way `.board-columns` steps down (no `useNarrow`: the Board's columns do not use it either).
 *
 * **Asked by is an initials disc, never the avatar** (§8.9: the browser never talks to Jira). The one link out is the server-built focused-comment `url`, of the
 * NEWEST mention, in a new tab with no referrer, worded `Reply in Jira` here and `Open in Jira` in the List.
 *
 * **Dismiss is the ticket's**, the same `onDismiss(issue)` the List calls, which posts every open id on it. A card whose ticket is dismissed (Show dismissed on)
 * is dimmed and offers `Restore` instead; its link stays. The click that opens the mention modal is Task 10's, so a card carries no handler beyond its buttons.
 */
export function JiraMentionCards({
  rows,
  me,
  now,
  onDismiss,
  onRestore
}: {
  rows: readonly JiraMentionRow[];
  /** The user's Jira display name, for the `@` chip; `null` draws the excerpt plain. */
  me: string | null;
  now: number;
  onDismiss: (issue: JiraMentionIssue) => void;
  onRestore: (issue: JiraMentionIssue) => void;
}) {
  return (
    <div className="jira-mentions-cards" role="list" aria-label="Mentions">
      {mentionCards(rows).map(({ issue, mention, earlier, dismissed }) => {
        const type = mentionIssueType(issue.type);
        const more = earlierText(earlier);
        return (
          <article key={issue.key} className="jira-mentions-card" role="listitem" data-key={issue.key} data-dismissed={dismissed ? '' : undefined}>
            <div className="jira-mentions-card-head">
              <span className="jira-card-type" data-tone={typeTone(type)} title={issue.type} aria-hidden="true">
                <JiraTypeIcon type={type} />
              </span>
              <span className="jira-card-key">{issue.key}</span>
              <span className="jira-mentions-card-sum" title={issue.summary}>
                {issue.summary}
              </span>
              <span className="jira-card-status">
                <span className="jira-status-dot" data-tone={statusTone(issue.status.category)} aria-hidden="true" />
                {issue.status.name}
              </span>
            </div>
            <div className="jira-mentions-quote">
              <span className="jira-mentions-quote-meta">
                <span className="jira-card-av" aria-hidden="true">
                  {initialsOf(mention.author.name)}
                </span>
                {`${mention.author.name} asked you`}
                {askedAge(mention.created, now) !== null && ` · ${askedAge(mention.created, now)}`}
              </span>
              <span className="jira-mentions-quote-text">
                {excerptParts(mention.excerpt, me).map((p, i) =>
                  p.me ? (
                    <span key={i} className="jira-mentions-at">
                      {p.text}
                    </span>
                  ) : (
                    p.text
                  )
                )}
              </span>
            </div>
            <div className="jira-mentions-card-foot">
              {more !== null && <span className="jira-mentions-card-more">{more}</span>}
              <span className={issue.boards.length === 0 ? 'jira-mentions-card-boards muted' : 'jira-mentions-card-boards'}>
                {issue.boards.length === 0 ? 'on none of your boards' : `on ${issue.boards.join(', ')}`}
              </span>
              <span className="jira-mentions-card-acts">
                {dismissed ? (
                  <Chip size={28} onClick={() => onRestore(issue)}>
                    Restore
                  </Chip>
                ) : (
                  <Chip size={28} onClick={() => onDismiss(issue)}>
                    Dismiss
                  </Chip>
                )}
                <Chip size={28} as="a" href={mention.url} icon={<Glyph name="external" />}>
                  Reply in Jira
                </Chip>
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
