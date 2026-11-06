import { useNow } from '../../hooks/useNow';
import { newestPolledAt, openRepoCount } from '../../lib/pr-layouts';
import { pollAge } from '../../lib/tracker';
import type { PrRepoView } from '../../../../shared/types';

/**
 * The band's sub-line for GitHub › PRs, shared by all three layouts (restyle fixes I5; mocks `PRs.dc.html` and `PRsLayouts.dc.html`): a live dot, then
 * `N open in M repos · polled 12 s ago`. `N` is the sum of the shown repos' `total` and `M` the shown repos holding at least one open PR (`openRepoCount`), so
 * a repo the token cannot read counts in neither; one repo reads `in 1 repo`.
 *
 * The age is the newest shown repo's (`newestPolledAt`) through `pollAge` — the reading the tracker chip, the Jira board and Cards' repo heads already use — on
 * a one-second clock of its own, for the reason `PolledAge` and `JiraBandSub` give: the age is the one reading that moves every second, and ticking the whole
 * page for it would re-render every row. With no shown repo read yet there is no age, and the ` · polled …` tail goes with it rather than saying `polled never`.
 * The dot is a page-local span (`.prs-band-dot`), not `.ui-dot`: `Dot` has no live-green tone of this size and design guard 7 forbids restyling it from here.
 */
export function PrBandSub({ shown, open }: { shown: readonly PrRepoView[]; open: number }) {
  const polledAt = newestPolledAt(shown);
  const now = useNow(polledAt !== null, 1_000);
  const age = pollAge(polledAt, now);
  const repos = openRepoCount(shown);
  return (
    <span className="prs-band-sub">
      <span className="prs-band-dot" aria-hidden="true" />
      {`${open} open in ${repos} ${repos === 1 ? 'repo' : 'repos'}${age === null ? '' : ` · polled ${age} ago`}`}
    </span>
  );
}
