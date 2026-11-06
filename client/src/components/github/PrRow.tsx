import type { ReactNode } from 'react';
import { Glyph } from '../ui/Glyphs';
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
 * One pull request's row, the anatomy Inbox and Cards share (.claude/DESIGN.md §8.11, "Row anatomy"): a `GlyphTile` in the checks tone (`checksTone` /
 * `checksGlyph`; conflicts, behind and changes-requested are pills, never the tile), the `#n` link and title, ONE wrapping line of the pills (`prPills`) and then
 * the meta `author · head → base · age` (each `·` trailing inside the item before it) with the run warning as one warn pill after it, then the foot (the Confirm, then the outcome line); the key strip is
 * the row's right-hand side. It decides nothing — the pills, the tile and the warning are `lib/pr-layouts.ts`' and `lib/pr-run.ts`' — so the two layouts that
 * draw it cannot read one PR two ways.
 *
 * **What the layout hands in.** `tileSize` is 40 in Inbox and 28 in Cards (the mocks' `.tile.lg` and `.tile`, `PRs.dc.html` and `PRsLayouts.dc.html`): the row
 * does not guess which layout drew it. `repoLabel` is Inbox's: its rows are a list across repos, so the meta line opens with the repo's short name
 * (`repoShortName`, computed by the layout, which knows the shown set); a Cards row sits under its repo's head and passes none.
 *
 * **Pills and meta are one line.** `.prs-line` is the one flex-wrap container, so a narrow row wraps pills and meta as a single flow instead of stacking two
 * boxes; the two inner wrappers stay (`.prs-chips`, `.prs-meta`) as `display: contents`, which keeps the meta's children addressable as a list. Branch names
 * stay in the body face: the mock sets them in mono, and design guard 2 allows one font-family, on body.
 *
 * The row is keyed by the caller on `<repo>#<number>`, never by index, and the open Confirm is the page's (`PrLayoutProps.confirming`), so it follows the key.
 */
export function PrRow({
  repo,
  pr,
  props,
  tileSize,
  repoLabel
}: {
  repo: PrRepoView;
  pr: PullRequestRow;
  props: PrLayoutProps;
  tileSize: 28 | 40;
  repoLabel?: string;
}) {
  const key = prKey(repo.repo, pr.number);
  // The mark's presence, not its clock: `Update` frees, and `updating…` leaves the row, only when the page's timer has judged the re-read.
  const updating = props.marks[key] !== undefined;
  const outcome = props.outcomes[key];
  const warning = prRunWarning(pr, repo.repo, props.ctx, props.now);
  const author = pr.author ?? 'ghost';
  const age = ageText(pr.updatedAt, props.now);
  const pills = prPills(pr);
  const metaItems: { key: string; node: ReactNode }[] = [];
  if (repoLabel !== undefined) {
    metaItems.push({
      key: 'repo',
      // The full name on hover: the short form drops the owner, which is the one thing two same-named repos would differ by.
      node: (
        <span className="prs-inbox-repo" title={repo.repo}>
          {repoLabel}
        </span>
      )
    });
  }
  metaItems.push({
    key: 'author',
    node: (
      <span className="prs-author">
        {/* The mock's initials disc (`.av`, as the Jira card's foot draws one): one letter, uppercased HERE, because design guard 4 allows exactly one
            `text-transform` rule. Decoration — the login is written beside it. */}
        <span className="prs-av" aria-hidden="true">
          {Array.from(author)[0].toUpperCase()}
        </span>
        <span>{author}</span>
      </span>
    )
  });
  metaItems.push({
    key: 'branches',
    // The branch glyph leads `head → base` as in the mock; Matrix's sub-line draws none.
    node: (
      <span className="prs-branch-pair">
        <Glyph name="branch" />
        <span className="prs-branches">{`${pr.head} → ${pr.base}`}</span>
      </span>
    )
  });
  if (age !== null) metaItems.push({ key: 'age', node: <span>{age}</span> });
  const write = (call: () => Promise<PrWriteResult>) => props.write(key, pr.headSha, call);
  return (
    <li className="prs-row" data-testid={`pr-row-${key}`}>
      <GlyphTile glyph={checksGlyph(pr.checks)} tone={checksTone(pr.checks)} size={tileSize} />
      <div className="prs-row-main">
        <div className="prs-row-title">
          <a className="prs-num" href={pr.url} target="_blank" rel="noreferrer noopener">
            #{pr.number}
          </a>
          <span className="prs-title">{pr.title}</span>
        </div>
        <div className="prs-line">
          {pills.length > 0 && (
            <div className="prs-chips">
              {pills.map((chip) => (
                <Pill key={chip.label} tone={chip.tone} glyph={chip.glyph}>
                  {chip.label}
                </Pill>
              ))}
            </div>
          )}
          <div className="prs-meta">
            {metaItems.map((item, i) => (
              // Each separator is the TRAILING child of the item before it, so a wrap can never strand a `·` at the start of a line or leave one alone at the
              // end of one: the item and its dot are one flex item and break together. The last item has none.
              <span key={item.key} className="prs-meta-item">
                {item.node}
                {i < metaItems.length - 1 && (
                  <span className="prs-sep" aria-hidden="true">
                    ·
                  </span>
                )}
              </span>
            ))}
            {warning !== null && <Pill tone="warn">{warning}</Pill>}
          </div>
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
