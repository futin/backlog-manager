import { useJiraContext } from '../../hooks/JiraContext';
import { useAction } from '../../hooks/useAction';
import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { useNarrow } from '../../hooks/useNarrow';
import { ticketDelivery } from '../../lib/delivery';
import { openDesktopJira } from '../../lib/jira';
import { deckCrumb, deckTally, type DeckEntry } from '../../lib/jira-deck';
import { openButtons, stripTitle } from '../../lib/jira-sessions';
import { sessionTone } from '../../lib/tones';
import { pollAge } from '../../lib/tracker';
import { STATE_LABEL } from '../../../../shared/jira-sessions';
import type { JiraIssue } from '../../../../shared/types';
import { FoldMark } from '../ui/FoldMark';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Meter } from '../ui/Meter';
import { MrChip } from './MrChip';
import { SessionOpen } from './SessionOpen';

/**
 * JiraAgentDeck — the live sessions on the picked board, one card each, above the status shelves (Jira sessions spec §7.1; DESIGN.md §8.9.1).
 *
 * **It draws what `lib/jira-deck.ts` derived** — the order (Needs you, Working, Quiet, Starting and Lost contact; newest first within), which sessions belong
 * to this board, and the crumb's words — and holds no copy of any of them. The page hands in the entries ALREADY filtered by the page's search and filters, so
 * the deck and the shelves answer one filter. With nothing live the section is not drawn at all: an empty "Agents" heading on every quiet board would be a
 * line of furniture, and the band's switch already says where the sessions are.
 *
 * **The card is a session's face, not a ticket's.** It wears `.ui-stripe` in the state's tone (`sessionTone`); its first line is the tone's dot, spec §6's
 * words for the state and how long THIS server has seen the session in it (no phase: none is served); the head — type glyph, the session's OWN key and, only
 * when the session runs on a ticket folded under another card, a `↳ <top>` pill; the summary, a button that opens Detail on that ticket; the crumb
 * `run · repo · surface · model`; the MR chip on a line of its own (below); a 4 px context `Meter`; and `SessionOpen`, the split Open. The card is not a `role="button"` the way a shelf row is: it has buttons of its own,
 * and a card that is itself one would nest them.
 *
 * **The MR chip** (GitLab connection spec §7.2, mock `Cards.dc.html`): a ticket with a live session is the one most likely to have an open MR, so the deck
 * card draws `MrChip` too. It has no foot, worktree chip or Run menu to sit beside, so the chip takes its own line between the crumb and the meter, and it is
 * the lead MR of the issue the CARD is about — the session's own ticket, which may be a folded child of the top — not the top's: the session is the work, and
 * its MR is the work's. Nothing is drawn while that ticket has no MR or delivery is not shown at all.
 *
 * **Buttons are `openButtons`' (§7.5), the deck's narrow reading** (`wide: false`: `Desktop`, where Detail says `Open in Desktop`). They are drawn by `SessionOpen`, which reads `openTarget` as `OpenChip` does, so C2's Desktop rule (hidden on a phone, disabled with its title while a hand-over could fork a live transcript, the guarded `jira-open-desktop`
 * POST for a dashboard session at rest) lives in one place. That POST's refusal draws under the buttons in the card's own alert line. A Starting card has none:
 * every button needs the session's id, and a reservation has no id yet.
 */
export function JiraAgentDeck({ entries, now, onOpenIssue }: { entries: readonly DeckEntry[]; now: number; onOpenIssue: (issue: JiraIssue) => void }) {
  if (entries.length === 0) return null;
  const tally = deckTally(entries);
  return (
    <section className="jira-deck" aria-label="Agents">
      <div className="jira-deck-head">
        <h3>Agents</h3>
        {tally.needs > 0 && <span className="jira-deck-need">{tally.needs} need you</span>}
        {tally.working > 0 && <span>{tally.working} working</span>}
      </div>
      <div className="jira-deck-cards">
        {entries.map((e) => (
          <DeckCard key={e.id} entry={e} now={now} onOpenIssue={onOpenIssue} />
        ))}
      </div>
    </section>
  );
}

function DeckCard({ entry, now, onOpenIssue }: { entry: DeckEntry; now: number; onOpenIssue: (issue: JiraIssue) => void }) {
  const { data } = useJiraContext();
  const phone = useNarrow();
  const handover = useAction();
  const { issue, link, state } = entry;
  const row = link?.row ?? null;
  const crumb = deckCrumb(entry, data?.skills ?? [], { lead: false });
  const pct = row?.contextPct;
  const sessionId = link?.sessionId ?? null;
  const buttons = link !== null && sessionId !== null ? openButtons(link, row, state, { phone, wide: false }) : null;
  const tone = sessionTone(state);
  const age = pollAge(entry.since, now);
  const folded = issue.key !== entry.top.key;
  const index = useDeliveryIndex();
  const delivery = index === null ? null : ticketDelivery(issue, index);

  return (
    <article className="jira-deck-card ui-stripe" aria-label={`Session on ${issue.key}`} data-state={state} data-key={issue.key} data-tone={tone}>
      <div className="jira-deck-face">
        <div className="jira-deck-state" title={stripTitle(state)}>
          <i className="ui-stripe-dot" data-tone={tone} aria-hidden="true" />
          {age === null ? STATE_LABEL[state] : `${STATE_LABEL[state]} · ${age}`}
        </div>
        <div className="jira-card-head">
          <span className="jira-card-type" title={issue.type.name}>
            <JiraTypeIcon type={issue.type} />
          </span>
          <span className="jira-card-key">{issue.key}</span>
          {folded && <FoldMark issueKey={entry.top.key} />}
        </div>
        <button type="button" className="jira-deck-title" onClick={() => onOpenIssue(issue)}>
          {issue.summary}
        </button>
        {crumb !== '' && <span className="jira-card-crumb">{crumb}</span>}
        {delivery?.kind === 'mrs' && (
          <div className="jira-deck-mr">
            <MrChip delivery={delivery} now={now} />
          </div>
        )}
        {pct !== undefined && (
          <Meter label="context" value={`${Math.round(pct)}%`} fraction={pct / 100} tone={pct >= 90 ? 'red' : pct >= 70 ? 'amber' : 'green'} width="fill" height={4} />
        )}
        {buttons !== null && sessionId !== null && (
          <div className="jira-deck-acts">
            <SessionOpen
              issueKey={issue.key}
              sessionId={sessionId}
              row={row}
              launch={link?.surface ?? null}
              state={state}
              buttons={buttons}
              onHandover={(id) => handover.run(() => openDesktopJira(id))}
            />
          </div>
        )}
        {handover.error !== null && (
          <p className="jira-modal-error" role="alert">
            {handover.error}
          </p>
        )}
      </div>
    </article>
  );
}
