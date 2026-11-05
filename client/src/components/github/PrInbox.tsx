import { useEffect, useMemo, useState } from 'react';

import { GlyphTile } from '../ui/GlyphTile';
import { Pill } from '../ui/Pill';
import { Segmented } from '../ui/Segmented';
import { PrActions } from './PrActions';
import { PrFoot } from './PrFoot';
import { PrRepoNotes } from './PrRepoNotes';
import type { PrLayoutProps } from './pr-layout-props';
import {
  ageText,
  LEVELS,
  LEVEL_LABEL,
  checksGlyph,
  checksTone,
  levelCounts,
  prPills,
  rankPrs,
  transientFailures,
  type PrLevel,
  type RankedPr
} from '../../lib/pr-layouts';
import { prRunWarning } from '../../lib/pr-run';
import type { PrWriteResult } from '../../../../shared/types';

/**
 * GitHub › PRs, Inbox layout (.claude/DESIGN.md §8.11; specs `2026-10-29-prs-layouts-design.md`, "Inbox", and `2026-10-30-prs-page-fixes-design.md`,
 * "Inbox"): the dashboard Git inbox's shape for pull requests — three count tiles that filter, the PRs that need a person first, everything else after a
 * `Quiet` heading. It decides nothing: the level, the rank, the verdict and the steps are `lib/pr-layouts.ts`'s, the run warning is `lib/pr-run.ts`'s, and
 * every write is `PrActions`' and `PrFoot`'s, so the three layouts cannot triage one PR three ways.
 *
 * **The triage is one `Segmented`** (label `Triage`): a button per level with its count, no `all` option. Clicking one filters, clicking the pressed one again
 * clears — `Segmented` only reports the value, so the toggle is this file's. The filter is held here as a
 * LEVEL, not as a list of keys, so a PR that a re-read moves out of the selected level simply leaves the list and the empty filter says
 * `No pull request at this level.` — a tile that still selected a PR the data no longer puts there would be lying. An option for an empty level stays drawn, so
 * the person who selected it can see why the list is empty and click it off. A filter that hides the row whose Confirm is open closes that Confirm: a row out
 * of the list is out of the list, whatever took it, and a Confirm nothing draws would still hold the Escape stack.
 *
 * **Every row is keyed by `<repo>#<number>`, never by index.** Two repos can each have a `#7`, and a re-read reorders the list; a row that remounted because
 * its position changed would lose its place under the person's eye. The open Confirm is the page's (`PrLayoutProps.confirming`), so it follows the key, not
 * the position.
 *
 * **One row, loud or quiet.** A 32 px `GlyphTile` in the checks tone (`checksTone` / `checksGlyph`; conflicts, behind and changes-requested are pills, never the
 * tile), the `#n` link, title and repo; the pill row (`prPills` — the facts a verdict line and a quiet line used to say in prose); the meta line
 * `author · head → base · age` with the run warning as one warn pill after it; then the foot (the Confirm, then the outcome line). The four keys and their
 * why-line are the row's right-hand side, top-aligned with the title, and wrap under the text when the title would get less than 320 px — and always below the
 * narrow breakpoint. The run warning is said once, as that pill. A quiet row carries the same keys as every other row and its `#n` is a link and nothing more.
 *
 * **Can't read.** A shown repo whose last read was `rate-limited` or `error` keeps its rows — still ranked, still actionable, a failed refresh is no reason to
 * stop offering a merge. Its `Can't read` line, like every note that is not a PR (outcomes of merged ones, the sync-off sentence, `showing n of total`), is
 * `PrRepoNotes`'.
 */

/** `author · head → base · age`, then the run warning when a run still works the branch — the line under a row's facts. */
function RowMeta({ r, now, warning }: { r: RankedPr; now: number; warning: string | null }) {
  const age = ageText(r.pr.updatedAt, now);
  return (
    <div className="prs-meta">
      <span>{r.pr.author ?? 'ghost'}</span>
      <span aria-hidden="true">·</span>
      <span className="prs-branches">{`${r.pr.head} → ${r.pr.base}`}</span>
      {age !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span>{age}</span>
        </>
      )}
      {warning !== null && <Pill tone="warn">{warning}</Pill>}
    </div>
  );
}

function InboxRow({ r, props }: { r: RankedPr; props: PrLayoutProps }) {
  const { pr, repo, key } = r;
  // The mark's presence, not its clock: `Update` frees, and `updating…` leaves the row, only when the page's timer has judged the re-read.
  const updating = props.marks[key] !== undefined;
  const outcome = props.outcomes[key];
  const warning = prRunWarning(pr, repo.repo, props.ctx, props.now);
  const write = (call: () => Promise<PrWriteResult>) => props.write(key, pr.headSha, call);
  const pills = prPills(pr);
  return (
    <li className="prs-row" data-testid={`pr-row-${key}`}>
      <GlyphTile glyph={checksGlyph(pr.checks)} tone={checksTone(pr.checks)} size={32} />
      <div className="prs-row-main">
        <div className="prs-row-title">
          <a className="prs-num" href={pr.url} target="_blank" rel="noreferrer noopener">
            #{pr.number}
          </a>
          <span className="prs-title">{pr.title}</span>
          <span className="prs-inbox-repo">{repo.repo}</span>
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
        <RowMeta r={r} now={props.now} warning={warning} />
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

export function PrInbox(props: PrLayoutProps) {
  const { repos, outcomes } = props;
  const [filter, setFilter] = useState<PrLevel | null>(null);
  const ranked = useMemo(() => rankPrs(repos), [repos]);
  const counts = levelCounts(ranked);
  const failures = transientFailures(repos);

  const visible = filter === null ? ranked : ranked.filter((r) => r.level === filter);
  const loud = visible.filter((r) => r.level !== 'quiet');
  const quiet = visible.filter((r) => r.level === 'quiet');

  // A filter that hides the confirming row closes its Confirm. Only a row still ranked counts: one the re-read dropped is the page's to close.
  const { confirming, setConfirming } = props;
  const hidden = confirming !== null && ranked.some((r) => r.key === confirming) && !visible.some((r) => r.key === confirming);
  useEffect(() => {
    if (hidden) setConfirming(null);
  }, [hidden, setConfirming]);

  return (
    <div className="prs-inbox" data-testid="pr-inbox">
      <PrRepoNotes repos={repos} outcomes={outcomes} part="above" />
      {/* With nothing ranked there are no tiles to draw. `no open pull requests` claims a read nobody got while a shown repo failed, so it waits for a clean
          read (Matrix says the same, `PrMatrix`); the `Can't read` lines below are then the page's whole answer. */}
      {ranked.length === 0 ? (
        failures.length === 0 && <p className="prs-status">no open pull requests</p>
      ) : (
        <>
          <div className="prs-inbox-triage">
            <Segmented<PrLevel | 'all'>
              label="Triage"
              value={filter ?? 'all'}
              options={LEVELS.map((level) => ({ value: level, label: LEVEL_LABEL[level], count: counts[level] }))}
              onChange={(v) => setFilter((current) => (v === 'all' || current === v ? null : v))}
            />
          </div>
          {visible.length === 0 && <p className="prs-status">No pull request at this level.</p>}
          {loud.length > 0 && (
            <ul className="prs-inbox-list">
              {loud.map((r) => (
                <InboxRow key={r.key} r={r} props={props} />
              ))}
            </ul>
          )}
          {quiet.length > 0 && (
            <>
              <h3 className="prs-inbox-heading">Quiet</h3>
              <ul className="prs-inbox-list">
                {quiet.map((r) => (
                  <InboxRow key={r.key} r={r} props={props} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <PrRepoNotes repos={repos} outcomes={outcomes} part="below" />
    </div>
  );
}
