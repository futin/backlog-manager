import type { PrRunContext } from '../../lib/pr-run';
import type { PrOutcome, UpdateMark } from '../../lib/prs';
import type { PrRepoView, PrWriteResult } from '../../../../shared/types';

/**
 * What every GitHub › PRs layout is handed by the page (`.claude/DESIGN.md` §8.11; spec `2026-10-29-prs-layouts-design.md`, "What every layout carries"). One
 * type, so Inbox and Matrix cannot drift into asking the page for different things — the page owns the writes, their outcomes, the update marks and the clock,
 * and a layout only places them.
 *
 * `repos` are the SHOWN repos only (`splitReach`): the page never hands a no-access repo down, so no layout re-tests reach. `write` is the page's `write`: the
 * layout keys it by `<repo>#<number>` and the PR's head SHA, and it resolves once the outcome is recorded and the page has re-read.
 */
export interface PrLayoutProps {
  repos: PrRepoView[];
  outcomes: Record<string, PrOutcome>;
  marks: Record<string, UpdateMark>;
  /** The page's clock, for the run warning, the `updating…` mark and the age a row prints. */
  now: number;
  ctx: PrRunContext;
  write: (key: string, sha: string, call: () => Promise<PrWriteResult>) => Promise<void>;
  /**
   * The `<repo>#<number>` of every PR with a write still running. The page adds a key before the call and removes it once the re-read after the outcome has
   * settled, so a strip a layout draws LATER (an unfolded Inbox line, a re-opened Matrix row, a switched layout) is disabled from its first paint — a strip's
   * own busy state dies with the strip.
   */
  inFlight: ReadonlySet<string>;
  /**
   * The `<repo>#<number>` of the one row whose merge Confirm is open, or `null`. Page state, not a row's, so there is one Confirm on the page: `Merge` on a
   * second row moves it, and a layout switch or a re-read that drops the row cannot leave one behind that nothing draws (Escape would still find it on the
   * stack). A row draws it in its foot (`PrFoot`) while this names it.
   */
  confirming: string | null;
  /** `Merge` sets this row's key; Cancel, Escape and the page's `write` (when the write leaving is this row's) clear it. */
  setConfirming: (key: string | null) => void;
}
