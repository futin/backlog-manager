import { useEffect, useMemo, useState } from 'react';

import { Dot } from '../ui/Dot';
import { Segmented } from '../ui/Segmented';
import { PrRow } from './PrRow';
import { PrRepoNotes } from './PrRepoNotes';
import type { PrLayoutProps } from './pr-layout-props';
import {
  LEVELS,
  LEVEL_DOT,
  LEVEL_LABEL,
  levelCounts,
  rankPrs,
  repoShortName,
  transientFailures,
  type PrLevel
} from '../../lib/pr-layouts';

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
 * **Each row is its own card** — a rule of the list (`.prs-inbox-list > .prs-row`), not of `PrRow`, so Cards' rows stay boxless inside their repo card. The triage's
 * `Needs you` and `Worth a look` lead with their level `Dot` (Quiet none, as the mock), and `Quiet` is a section label with room above it.
 *
 * **Every row is keyed by `<repo>#<number>`, never by index.** Two repos can each have a `#7`, and a re-read reorders the list; a row that remounted because
 * its position changed would lose its place under the person's eye. The open Confirm is the page's (`PrLayoutProps.confirming`), so it follows the key, not
 * the position.
 *
 * **One row, loud or quiet.** `PrRow` (shared with Cards, which draws it at 28 px and without the repo name): a 40 px checks `GlyphTile`, the `#n` link and title, then ONE
 * wrapping line — the pills, then the meta that opens with the repo's short name (`repoShortName`: the last segment, the full `owner/name` only where two shown
 * repos share it) and carries the run warning as one warn pill — then the foot; the keys and their why-line are the row's right-hand side, top-aligned with the
 * title, and wrap under the text when the title would get less than 320 px — and always below the narrow breakpoint. A quiet row carries the same keys as every
 * other row and its `#n` is a link and nothing more.
 *
 * **Can't read.** A shown repo whose last read was `rate-limited` or `error` keeps its rows — still ranked, still actionable, a failed refresh is no reason to
 * stop offering a merge. Its `Can't read` line, like every note that is not a PR (outcomes of merged ones, the sync-off sentence, `showing n of total`), is
 * `PrRepoNotes`'.
 */

export function PrInbox(props: PrLayoutProps) {
  const { repos, outcomes } = props;
  const [filter, setFilter] = useState<PrLevel | null>(null);
  const ranked = useMemo(() => rankPrs(repos), [repos]);
  const counts = levelCounts(ranked);
  const failures = transientFailures(repos);
  const shownNames = useMemo(() => repos.map((r) => r.repo), [repos]);

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
            {/* The track skin, the page's layout switch's own: the mock draws both as one recessed ground, and the default stroked row read as three loose
                chips beside it (ui-verify D3, 2026-11-05). */}
            <Segmented<PrLevel | 'all'>
              track
              label="Triage"
              value={filter ?? 'all'}
              options={LEVELS.map((level) => ({
                value: level,
                label: LEVEL_LABEL[level],
                count: counts[level],
                // The level's own dot, the one Matrix's rows lead with (`LEVEL_DOT`); Quiet's is `undefined` and the mock draws none there.
                leading: LEVEL_DOT[level] ? <Dot tone={LEVEL_DOT[level]} /> : undefined
              }))}
              onChange={(v) => setFilter((current) => (v === 'all' || current === v ? null : v))}
            />
          </div>
          {visible.length === 0 && <p className="prs-status">No pull request at this level.</p>}
          {loud.length > 0 && (
            <ul className="prs-inbox-list">
              {loud.map((r) => (
                <PrRow key={r.key} repo={r.repo} pr={r.pr} props={props} tileSize={40} repoLabel={repoShortName(r.repo.repo, shownNames)} />
              ))}
            </ul>
          )}
          {quiet.length > 0 && (
            <>
              <h3 className="prs-inbox-heading">Quiet</h3>
              <ul className="prs-inbox-list">
                {quiet.map((r) => (
                  <PrRow key={r.key} repo={r.repo} pr={r.pr} props={props} tileSize={40} repoLabel={repoShortName(r.repo.repo, shownNames)} />
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
