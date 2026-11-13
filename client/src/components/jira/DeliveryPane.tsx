import { useMemo } from 'react';

import { useGitlabContext } from '../../hooks/GitlabContext';
import { deliveryIndex, deliveryLook, deliveryShown, mrRepo, ticketDelivery, type TrackStep } from '../../lib/delivery';
import { polledPhrase } from '../../lib/jira';
import { pollAge } from '../../lib/tracker';
import type { GitlabMr, JiraIssue } from '../../../../shared/types';
import { DeliveryTrack } from '../ui/DeliveryTrack';

/**
 * DeliveryPane — Jira Detail's Delivery pane (GitLab connection spec §7.1, mock `OptionC.dc.html`; DESIGN.md §8.9.2's Agent column, in its
 * `.jira-detail-pane` ground and `.jira-detail-lbl` head). It sits in the Agent column under the sessions band and above History, because what became of a
 * ticket's work — pushed, opened, built, merged — is the sequel to the session that did it, and the Ticket column is Jira's facts.
 *
 * Every word and tone comes from `lib/delivery.ts` — `ticketDelivery` picks the lead MR (own, else the parent's for a sub-task) or says why there is none,
 * `deliveryLook` gives the word, tone and track — so this pane can never show an MR the card and the List row do not, nor call a pipeline something they do
 * not. What the pane adds is only its own arrangement: the head (`Delivery`, the `!iid ↗` link out, `<repo> → <target>`, `via <PARENT>` when inherited, and
 * `polled <age>` of the lead MR's own project pushed right), the track with each step's word, and the `Also:` line.
 *
 * It reads the shell's one GitLab answer (`useGitlabContext`) and draws NOTHING while delivery is not shown at all (unconfigured, unarmed, or a payload the
 * browser could not fetch — `deliveryShown`) or for a ticket whose Jira project maps no GitLab project (`hidden`): one rule for all four surfaces (spec §7,
 * "Which tickets draw delivery at all"), and an empty pane would read as a claim that there is nothing to deliver. Nothing here waits on GitLab — a payload
 * not yet arrived is `null`, which draws nothing, and the rest of the dialog renders as it always has.
 *
 * Links go out in a new tab with no referrer, the `Open in Jira ↗` link's rule: the dialog is the board's, and a GitLab page must not learn the board's
 * address from the click.
 */

/**
 * The word under each step (spec §7.1): Pushed and MR open carry the MR's created-at age — the moment its branch was pushed and the MR opened are one GitLab
 * fact, and the payload has no earlier one — Merged its merged-at age, and Pipeline the table's word for an open, non-draft MR. A draft's word, `draft`, sits
 * at MR open, where its grey mark is (spec §7, "A draft MR is `draft` at MR open"). A merged MR's Pipeline step is drawn reached with no word, and a closed
 * MR's is `off`: pipeline status is not read for either (§6.3), and a word there would be a guess.
 */
function stepWords(mr: GitlabMr, now: number): Partial<Record<TrackStep['step'], string>> {
  const created = pollAge(mr.createdAt, now) ?? undefined;
  const words: Partial<Record<TrackStep['step'], string>> = { pushed: created, open: created };
  if (mr.state === 'merged') {
    const merged = mr.mergedAt === null ? null : pollAge(mr.mergedAt, now);
    if (merged !== null) words.merged = merged;
  } else if (mr.state === 'opened') {
    if (mr.draft) words.open = 'draft';
    else words.pipeline = deliveryLook(mr).word;
  }
  return words;
}

/** An MR's link out: `!iid` with the arrow beside it, `aria-hidden` so the link's name is the MR it opens and not a glyph. */
function MrLink({ mr, className }: { mr: GitlabMr; className: string }) {
  return (
    <a className={className} href={mr.webUrl} target="_blank" rel="noopener noreferrer" title={mr.title}>
      {`!${mr.iid}`}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

/** The unknown lines (spec §7, "Known versus none") — an answer that is not yet trustworthy says so, and says where to look when it is a failure. */
const UNKNOWN_LINE = {
  'not-read': 'GitLab not read yet',
  failed: 'GitLab could not be read — Settings › Shared › Sources',
  capped: 'more merge requests than were read — some may be missing'
} as const;

export function DeliveryPane({ issue, now }: { issue: JiraIssue; now: number }) {
  const { data } = useGitlabContext();
  // Built once per payload, not per render: the dialog re-renders every clock tick, and the index is a scan of every MR the server holds.
  const index = useMemo(() => (data === null || !deliveryShown(data) ? null : deliveryIndex(data)), [data]);
  if (index === null) return null;
  const d = ticketDelivery(issue, index);
  if (d.kind === 'hidden') return null;

  if (d.kind !== 'mrs') {
    const line =
      d.kind === 'none' ? `no merge request for ${issue.key} in ${d.repos.join(', ')} in the last 30 days` : UNKNOWN_LINE[d.why];
    return (
      <section className="jira-detail-pane jira-dlv" aria-label="Delivery">
        <div className="jira-dlv-head">
          <div className="jira-detail-lbl">Delivery</div>
        </div>
        <p className="jira-dlv-none">{line}</p>
      </section>
    );
  }

  const { lead, also, via } = d;
  const look = deliveryLook(lead);
  return (
    <section className="jira-detail-pane jira-dlv" aria-label="Delivery">
      <div className="jira-dlv-head">
        <div className="jira-detail-lbl">Delivery</div>
        <MrLink mr={lead} className="jira-dlv-link" />
        {via !== null && <span className="jira-dlv-via">{`via ${via}`}</span>}
        <span className="jira-dlv-meta jira-dlv-target">{`${mrRepo(lead, index)} → ${lead.targetBranch}`}</span>
        <span className="jira-dlv-meta jira-dlv-polled">{polledPhrase(d.polledAt, now)}</span>
      </div>
      <DeliveryTrack track={look.track} words={stepWords(lead, now)} compact={false} />
      {also.length > 0 && (
        <div className="jira-dlv-also">
          <span className="jira-dlv-meta">Also:</span>
          {also.map((mr) => {
            const other = deliveryLook(mr);
            // `updatedAt`'s age: the time the lead order reads, so the line's ages explain why these are not the lead.
            const age = pollAge(mr.updatedAt, now);
            return (
              <span key={`${mr.project}!${mr.iid}`} className="jira-dlv-also-mr">
                <MrLink mr={mr} className="jira-dlv-link small" />
                <span className="jira-dlv-word" data-tone={other.tone}>
                  {other.word}
                </span>
                <span className="jira-dlv-meta">{age === null ? mrRepo(mr, index) : `${mrRepo(mr, index)} · ${age}`}</span>
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}
