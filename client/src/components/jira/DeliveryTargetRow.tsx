import { useState, type ReactNode } from 'react';

import { deliveryLook, olderMrsLine, type DeliveryNext, type DeliveryTarget } from '../../lib/delivery';
import { reviewStepWord } from '../../lib/review-copy';
import { pollAge } from '../../lib/tracker';
import { Chevron } from '../ui/Chevron';
import { DeliveryTrack } from '../ui/DeliveryTrack';
import { Fold } from '../ui/Fold';
import { DeliveryPane, MrLink } from './DeliveryPane';

/**
 * DeliveryTargetRow — one delivery target of a ticket, as a fold row (Jira detail tabs spec §4.2, §4.3; mock `Main.html` `details.tgt` and `details.older`;
 * DESIGN.md §8.9.6, Delivery › target rows). One row per (project, target branch), because a merge into `develop` says nothing about `demo`: the reader asked
 * for every MR per target, not one lead per ticket.
 *
 * **Folded**, the summary line is the target at a glance and only folds — no button on it: the chevron, `into <target>`, the repo basename only when the
 * ticket's targets span two projects (`repo`, the caller's call), the lead's `!iid` link out, its title (ellipsised), the compact five-dot track with the
 * next dot ringed and ignored dots grey, the state pill (`deliveryNext`'s `pill`: `next: …` in the action colour when something is next, else
 * `deliveryLook`'s word in its tone), the review word at `--ink3`, `+N earlier` and the lead's age. **Open**, it adds `DeliveryPane` for the lead with the
 * next row in it, then the older MRs' own fold.
 *
 * **Open is the caller's state** (`open`, `onToggle`), not the element's: the body keys it by row id so a strip pill can open a row and a poll that swaps the
 * lead keeps it open; `ui/Fold` draws the controlled `<details>`. The older fold is this row's own, closed by default and kept across polls (the row is
 * keyed by target, not by lead).
 */

export function DeliveryTargetRow({
  target,
  next,
  repo,
  open,
  onToggle,
  now,
  onUnignore,
  children
}: {
  target: DeliveryTarget;
  next: DeliveryNext;
  /** The repo basename, or `null` when every target is in one project. */
  repo: string | null;
  open: boolean;
  onToggle: () => void;
  now: number;
  onUnignore: (step: 'review' | 'pipeline') => void;
  /** The next row for the lead. */
  children?: ReactNode;
}) {
  const [olderOpen, setOlderOpen] = useState(false);
  const { lead, older } = target;
  const look = deliveryLook(lead, now);
  const review = lead.state === 'opened' ? reviewStepWord(lead.review, now) : null;
  const age = pollAge(lead.updatedAt, now);
  const olderLine = olderMrsLine(target);
  const ignored = { review: next.ignored.review, pipeline: next.ignored.pipeline };

  const head = (
    <>
      <Chevron dir={open ? 'down' : 'right'} />
      <span className="jira-dlv-into">
        into <b>{target.target}</b>
      </span>
      {repo !== null && <span className="jira-dlv-repo">{repo}</span>}
      <MrLink mr={lead} className="jira-dlv-link" />
      <span className="jira-dlv-title" title={lead.title}>
        {lead.title}
      </span>
      <DeliveryTrack track={look.track} compact next={next.step} ignored={ignored} />
      <span className="jira-dlv-word" data-tone={next.step === null ? look.tone : 'next'}>
        {next.pill}
      </span>
      {review !== null && <span className="jira-dlv-meta">{review}</span>}
      {older.length > 0 && <span className="jira-dlv-meta">{`+${older.length} earlier`}</span>}
      {age !== null && <span className="jira-dlv-meta">{age}</span>}
    </>
  );

  return (
    <Fold className="jira-dlv-tgt" open={open} onToggle={onToggle} head={head}>
      <div className="jira-dlv-tbody">
        <DeliveryPane mr={lead} now={now} next={next} onUnignore={onUnignore}>
          {children}
        </DeliveryPane>
        {olderLine !== null && (
          <Fold className="jira-dlv-older" open={olderOpen} onToggle={() => setOlderOpen((o) => !o)} head={olderLine}>
            <ol className="jira-dlv-older-list">
              {older.map((m) => {
                const l = deliveryLook(m, now);
                const mAge = pollAge(m.updatedAt, now);
                return (
                  <li key={`${m.project}!${m.iid}`} className="jira-dlv-orow">
                    <MrLink mr={m} className="jira-dlv-link small" />
                    <span className="jira-dlv-word" data-tone={l.tone}>
                      {l.word}
                    </span>
                    <span className="jira-dlv-otitle" title={m.title}>
                      {m.sourceBranch !== lead.sourceBranch && <span className="jira-dlv-from">{`from ${m.sourceBranch}`}</span>}
                      {m.title}
                    </span>
                    <span className="jira-dlv-meta">{mAge ?? ''}</span>
                  </li>
                );
              })}
            </ol>
          </Fold>
        )}
      </div>
    </Fold>
  );
}
