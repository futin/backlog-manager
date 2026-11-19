import { useJiraContext } from '../../hooks/JiraContext';
import { useTimeZone } from '../../hooks/TimeZoneContext';
import { displayPath, issueDatesLine, priorityTone } from '../../lib/jira';
import { formatCreated } from '../../lib/item-age';
import type { JiraIssue, JiraIssueDetail } from '../../../../shared/types';
import { Fact } from '../ui/Fact';
import { Glyph } from '../ui/Glyphs';
import { Description } from './Description';

/**
 * JiraTicketPane — the Detail body's `Ticket` tab (Jira detail tabs spec §1.4; DESIGN.md §8.9.2): two columns, the description on the left and a `Details`
 * pane on the right, stacked under 700 px. It is today's Ticket column minus what the strip took (Status, Assignee, Sprint, Parent — spec §3): the facts left
 * here are the ones a reader looks up rather than watches, which is why they can sit behind a tab while the strip's cannot.
 *
 * **Every fact keeps today's reading and `Fact`'s rule** — a fact with nothing to say draws nothing: no `Labels` without labels, no `Priority` without one,
 * no `On boards` until the detail names a board the shell's status knows. `Resolved` is new (the mock's row): `JiraIssue.resolved` as a short date through
 * `formatCreated`, the same reading `Created · updated` gives its first half, and only when the ticket carries one. `Repository` keeps today's hint for an
 * unmapped project, and `Session` is handed in already worded, because the body reads the same sessions for the strip and both must agree.
 *
 * **The description is where the read's state shows.** `loading…` while the detail is out, the server's sentence when it failed (`could not read the
 * ticket — …`), `no description` for an empty one — the facts beside it are drawn from the card's copy meanwhile, so a failed read never blanks them.
 */
export function JiraTicketPane({
  src,
  detail,
  failure,
  sessionLine,
  now
}: {
  src: JiraIssue;
  detail: JiraIssueDetail | null;
  failure: string | null;
  /** The `Session` fact's words — `<name> · <repo> · <elapsed>`, `starting` or `—` — read by the body. */
  sessionLine: string;
  now: number;
}) {
  const { zone } = useTimeZone();
  const { data } = useJiraContext();
  const boardNames = detail === null || data === null ? [] : data.boards.filter((b) => detail.boards.includes(b.id)).map((b) => b.name);
  const paths = data?.repos[src.project.key] ?? [];
  const prio = src.priority === null || src.priority === '' ? null : priorityTone(src.priority);

  return (
    <div className="jira-ticket-grid">
      <div className="item-body jira-detail-pane">
        {failure !== null ? (
          <div className="drawer-empty">{`could not read the ticket — ${failure}`}</div>
        ) : detail === null ? (
          <div className="drawer-empty">loading…</div>
        ) : detail.description.trim() === '' ? (
          <p className="jira-modal-none">no description</p>
        ) : (
          // Keyed on the issue, so a walk step opens the next description collapsed rather than inheriting this one's `Show more`.
          <Description key={detail.key} markdown={detail.description} />
        )}
      </div>
      <section className="jira-detail-pane" aria-label="Details">
        <div className="jira-detail-lbl">Details</div>
        <dl className="jira-detail-facts">
          {src.reporter !== null && (
            <Fact label="Reporter" icon={<Glyph name="person" />}>
              {src.reporter}
            </Fact>
          )}
          {prio !== null && src.priority !== null && (
            <Fact label="Priority" icon={<Glyph name="flag" />}>
              <span className="jira-card-prio" data-tone={prio} title={`priority ${src.priority}`}>
                {prio !== 'other' && <Glyph name={prio === 'high' ? 'up' : prio === 'med' ? 'equals' : 'down'} size={10} />}
                {src.priority}
              </span>
            </Fact>
          )}
          {src.labels.length > 0 && (
            <Fact label="Labels" icon={<Glyph name="tag" />}>
              {src.labels.map((l) => (
                <span key={l} className="jira-detail-label">
                  {l}
                </span>
              ))}
            </Fact>
          )}
          <Fact label="Created · updated" icon={<Glyph name="calendar" />}>
            {issueDatesLine(src, now, zone)}
          </Fact>
          {src.resolved !== null && (
            <Fact label="Resolved" icon={<Glyph name="calendar" />}>
              {formatCreated(src.resolved, now, zone)}
            </Fact>
          )}
          {boardNames.length > 0 && (
            <Fact label="On boards" icon={<Glyph name="grid" />}>
              {boardNames.join(', ')}
            </Fact>
          )}
          <Fact label="Repository" icon={<Glyph name="branch" />}>
            {data === null || paths.length === 0 ? (
              `no repository mapped for ${src.project.key} — Jira › Setup › Repositories`
            ) : (
              <span className="item-facts-path">{paths.map((p) => displayPath(p, data.home)).join(', ')}</span>
            )}
          </Fact>
          <Fact label="Session" icon={<Glyph name="play" />}>
            {sessionLine}
          </Fact>
        </dl>
      </section>
    </div>
  );
}
