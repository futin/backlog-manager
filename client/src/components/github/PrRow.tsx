import { GlyphTile } from '../ui/GlyphTile';
import { Pill } from '../ui/Pill';
import { PrActions } from './PrActions';
import { PrFoot } from './PrFoot';
import type { PrLayoutProps } from './pr-layout-props';
import { ageText, checksGlyph, checksTone, prPills } from '../../lib/pr-layouts';
import { prRunWarning } from '../../lib/pr-run';
import { prKey } from '../../lib/prs';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

/**
 * One pull request's row, the anatomy Inbox and Cards share (.claude/DESIGN.md §8.11, "Row anatomy"): a 32 px `GlyphTile` in the checks tone (`checksTone` /
 * `checksGlyph`; conflicts, behind and changes-requested are pills, never the tile), the `#n` link and title, the pill row (`prPills`), the meta line
 * `author · head → base · age` with the run warning as one warn pill after it, then the foot (the Confirm, then the outcome line); the key strip is the row's
 * right-hand side. It decides nothing — the pills, the tile and the warning are `lib/pr-layouts.ts`' and `lib/pr-run.ts`' — so the two layouts that draw it
 * cannot read one PR two ways. `showRepo` is Inbox's: its rows are a list across repos and say whose each is; a Cards row sits under its repo's head.
 *
 * The row is keyed by the caller on `<repo>#<number>`, never by index, and the open Confirm is the page's (`PrLayoutProps.confirming`), so it follows the key.
 */
export function PrRow({ repo, pr, props, showRepo = false }: { repo: PrRepoView; pr: PullRequestRow; props: PrLayoutProps; showRepo?: boolean }) {
  const key = prKey(repo.repo, pr.number);
  // The mark's presence, not its clock: `Update` frees, and `updating…` leaves the row, only when the page's timer has judged the re-read.
  const updating = props.marks[key] !== undefined;
  const outcome = props.outcomes[key];
  const warning = prRunWarning(pr, repo.repo, props.ctx, props.now);
  const age = ageText(pr.updatedAt, props.now);
  const pills = prPills(pr);
  const write = (call: () => Promise<PrWriteResult>) => props.write(key, pr.headSha, call);
  return (
    <li className="prs-row" data-testid={`pr-row-${key}`}>
      <GlyphTile glyph={checksGlyph(pr.checks)} tone={checksTone(pr.checks)} size={32} />
      <div className="prs-row-main">
        <div className="prs-row-title">
          <a className="prs-num" href={pr.url} target="_blank" rel="noreferrer noopener">
            #{pr.number}
          </a>
          <span className="prs-title">{pr.title}</span>
          {showRepo && <span className="prs-inbox-repo">{repo.repo}</span>}
        </div>
        {pills.length > 0 && (
          <div className="prs-chips">
            {pills.map((chip) => (
              <Pill key={chip.label} tone={chip.tone}>
                {chip.label}
              </Pill>
            ))}
          </div>
        )}
        <div className="prs-meta">
          <span>{pr.author ?? 'ghost'}</span>
          <span aria-hidden="true">·</span>
          <span className="prs-branches">{`${pr.head} → ${pr.base}`}</span>
          {age !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{age}</span>
            </>
          )}
          {warning !== null && <Pill tone="warn">{warning}</Pill>}
        </div>
        <PrFoot
          repo={repo}
          pr={pr}
          outcome={outcome}
          updating={updating}
          confirming={props.confirming === key}
          onDismiss={() => props.setConfirming(null)}
          onWrite={write}
        />
      </div>
      <PrActions
        repo={repo}
        pr={pr}
        updating={updating}
        outcome={outcome}
        busy={props.inFlight.has(key)}
        onMerge={() => props.setConfirming(key)}
        onWrite={write}
      />
    </li>
  );
}
