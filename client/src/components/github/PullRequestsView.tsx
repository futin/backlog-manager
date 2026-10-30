import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PolledAge, PrCards } from './PrCards';
import { PrInbox } from './PrInbox';
import { PrMatrix } from './PrMatrix';
import type { PrLayoutProps } from './pr-layout-props';
import { Band } from '../ui/Band';
import { Pill } from '../ui/Pill';
import { Segmented } from '../ui/Segmented';
import { useBoard } from '../../hooks/useBoard';
import { useNow } from '../../hooks/useNow';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { usePersistedState } from '../../hooks/usePersistedState';
import { usePullRequests } from '../../hooks/usePullRequests';
import { useReportWorking } from '../../hooks/useReportWorking';
import { newestPolledAt, parseLayout, PR_LAYOUT_KEY, PR_LAYOUT_OPTIONS, splitReach, type PrLayout } from '../../lib/pr-layouts';
import type { PrRunContext } from '../../lib/pr-run';
import { groupRepos, outcomeLine, UPDATING_MS, type PrOutcome, type UpdateMark } from '../../lib/prs';
import type { PrWriteResult } from '../../../../shared/types';

/** The page's own words for the token-less server — an instruction, because the only fix is on the host. */
const NO_TOKEN = 'no token — set BM_GITHUB_TOKEN in .env and restart';

/** How often the run-in-progress warning's clock moves. A live claim goes stale in minutes, so a quarter-minute is ample, and the run poll re-renders anyway. */
const WARNING_CLOCK_MS = 15_000;

/**
 * GitHub › PRs (.claude/DESIGN.md §8.11; source-sections spec, Goal 2 and "Left to the builder"): the open pull requests of every registered GitHub repo,
 * with merge, auto-merge and update branch — grouped by repo in Cards, ranked across repos in Inbox and Matrix.
 *
 * **Reads.** `usePullRequests` is the page's one read of `GET /api/prs`, and this page is one of its two mounts (the other is GitHub › Settings' `Access` card)
 * — leaving both is what stops PR reads, because the server's PR cache has no timer of its own. The run-in-progress warning (`prRunWarning`) is derived from
 * what the Board already polls: `useBoard`'s items and projects and `useOrchestratorRuns`' runs, remote runs and remote launches — no request of its own.
 * `onWorking` is every view's rail-cursor report (`useReportWorking`, §8.0), and since this page runs a `useOrchestratorRuns()` for the warning anyway, it
 * reports the same reading Board and Archive do: a run on this machine working, not the page loading — a cursor that blinked on a page read would say a run
 * started when none had.
 *
 * **Order.** Cards draws `groupRepos`' order: repos with open PRs first, most recently touched on top, then the empty ones by name; each repo's PRs newest
 * update first. Inbox and Matrix rank across repos instead (`rankPrs`). The payload's own order is never what is drawn.
 *
 * **Layouts and reach.** Three layouts — Inbox (the default), Matrix and Cards — behind a `Segmented` in the toolbar, the choice stored per device
 * (`PR_LAYOUT_KEY`, read through `parseLayout` so a hand-edited value is Inbox). Matrix is wide-only: a narrow window DRAWS a stored `matrix` as Inbox
 * (`drawableLayout`) and the switcher offers no Matrix, but the stored word is only ever written by a click, never by a draw, so the choice returns with the
 * window. A repo the token cannot read (`splitReach`: `forbidden`, `not-found`) is never handed to a layout, never counted in `N open`, and is named only by
 * the toolbar's `N repos hidden — no access · GitHub › Settings`, the link being `onOpenSettings` (threaded from `App` like the Sources card's, so the rail's
 * tree stays the only switch). Empty states, in order: the PAYLOAD has no repo → `no GitHub repo registered`; it has repos but none is shown → `no repo this
 * token can read`; otherwise the layout, which says `no open pull requests` itself (Inbox and Matrix, and only while every shown repo read cleanly).
 *
 * **Repo heading (Cards).** The repo, `polled N s ago`, a `sync off` pill beside the server's full sentence (`repo.syncOff`, `syncOffBlock`'s one home — never
 * a client copy) when the repo's sync is off, the read's `detail` when its last read was not `ok`, and `showing <n> of <total>` when GitHub had more than one
 * page. Each repo is a `Sheet`, Settings' card ground, so two repos never read as one list. Inbox and Matrix say the same things once, in `PrRepoNotes`.
 *
 * **Writes and their outcomes.** A row asks the page to run a write (`write`); the page records the one-line outcome under `<repo>#<number>` — the server's
 * own word through `outcomeLine`, or a refusal's sentence verbatim (`prs-api`'s `errorOf`) — then re-reads, after success AND failure, because a refusal
 * such as a moved head is exactly when the row is out of date. The outcome lives here and not in the row because a merge's re-read takes the PR off the open
 * list: a repo keeps a `#12 merged` line for a PR that left it, or the most important outcome on the page would vanish with the row that earned it. A PR's
 * line is cleared the moment its next write leaves, and a repo shows only its newest `DEPARTED_KEEP` departed lines, so a page left mounted through many
 * writes does not pile them up (#396).
 *
 * **`updating…`.** GitHub answers update-branch with 202 and merges later, so the page marks the PR at the head SHA it asked from (`UpdateMark`) and the row
 * says `updating…` while `isUpdating` — until a read shows a new head, or `UPDATING_MS` pass. At that moment the page re-reads once (a timer per mark), so the
 * row is not left on a head the update has long since moved; a read that shows the head moved first drops the mark and its timer. Marks, outcomes and the
 * clock are this page's, not a layout's, so switching layout mid-update keeps the mark.
 *
 * **In flight.** A strip's own busy state dies when the strip unmounts — an Inbox fold, a Matrix collapse, a layout switch — and a key that came back while its
 * write still ran would send a head SHA the write may already have moved. So `write` also holds `<repo>#<number>` in `inFlight` from before the call until the
 * re-read after it has settled (success AND failure), and every layout hands it to `PrActions` as `busy`.
 *
 * No Escape handler here (`Confirm` joins `useDialogEscape` itself) and no page switch (the rail's GitHub tree is the only one). The page scrolls in the well
 * like Settings and reserves no height, so it reads no strip token at all.
 *
 * Default export, because `App` loads it lazily like every other page.
 */
export default function PullRequestsView({ onWorking, onOpenSettings }: { onWorking?: (working: boolean) => void; onOpenSettings?: () => void }) {
  const { data, error, refresh } = usePullRequests();
  const { items, projects } = useBoard();
  const { runs, starting, remote, remoteStarting } = useOrchestratorRuns();
  useReportWorking(runs, starting, onWorking);
  const now = useNow(true, WARNING_CLOCK_MS);

  const [outcomes, setOutcomes] = useState<Record<string, PrOutcome>>({});
  const [marks, setMarks] = useState<Record<string, UpdateMark>>({});
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  // The one open merge Confirm on the page, by `<repo>#<number>` — page state beside the outcomes and marks, so a layout switch cannot strand one.
  const [confirming, setConfirming] = useState<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dropMark = useCallback((key: string) => {
    const timer = timers.current.get(key);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(key);
    setMarks((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const markUpdating = useCallback(
    (key: string, sha: string) => {
      const existing = timers.current.get(key);
      if (existing !== undefined) clearTimeout(existing);
      timers.current.set(
        key,
        setTimeout(() => {
          dropMark(key);
          void refresh();
        }, UPDATING_MS)
      );
      setMarks((prev) => ({ ...prev, [key]: { sha, until: Date.now() + UPDATING_MS } }));
    },
    [dropMark, refresh]
  );

  // Every pending timer goes with the page: a re-read for a page nobody is on is the one read this page must never make.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // A read that shows the head moved — or the PR gone — ends the mark early, timer and all; one still on the marked head keeps it.
  useEffect(() => {
    if (data === null) return;
    for (const [key, mark] of Object.entries(marks)) {
      const [repoName, number] = [key.slice(0, key.lastIndexOf('#')), Number(key.slice(key.lastIndexOf('#') + 1))];
      const pr = data.repos.find((r) => r.repo === repoName)?.prs.find((p) => p.number === number);
      if (pr === undefined || pr.headSha !== mark.sha) dropMark(key);
    }
  }, [data, marks, dropMark]);

  const write = useCallback(
    async (key: string, sha: string, call: () => Promise<PrWriteResult>): Promise<void> => {
      setInFlight((prev) => new Set(prev).add(key));
      // The last outcome answered the last write; a new one is leaving, so the old line goes now rather than standing beside a write it says nothing about
      // (the Jira modal clears its error the same way). Dropping the key also makes the re-add below land last, which is the order `departedOutcomes` caps by.
      setOutcomes((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        let outcome: PrOutcome;
        try {
          const result = await call();
          outcome = { text: outcomeLine(result), kind: result.outcome === 'update-requested' ? 'updating' : 'ok' };
          if (result.outcome === 'update-requested') markUpdating(key, sha);
        } catch (e) {
          outcome = { text: e instanceof Error ? e.message : String(e), kind: 'error' };
        }
        setOutcomes((prev) => ({ ...prev, [key]: outcome }));
        await refresh();
      } finally {
        setInFlight((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [markUpdating, refresh]
  );

  const ctx: PrRunContext = useMemo(
    () => ({ projects: projects ?? [], items: items?.items ?? [], runs, remote, remoteStarting }),
    [projects, items, runs, remote, remoteStarting]
  );
  const { shown, hidden } = useMemo(() => splitReach(data === null ? [] : groupRepos(data.repos)), [data]);
  const open = shown.reduce((n, r) => n + r.total, 0);

  const [stored, setStored] = usePersistedState<PrLayout>(PR_LAYOUT_KEY, 'inbox');
  const layout = parseLayout(stored);
  const props: PrLayoutProps = { repos: shown, outcomes, marks, now, ctx, write, inFlight, confirming, setConfirming };

  return (
    <div className="prs">
      <Band title="Pull requests" sub="open pull requests on this machine's GitHub repos">
        {data !== null && data.token && <Pill tone="neutral">{`${open} open`}</Pill>}
      </Band>
      {data === null ? (
        <p className="prs-status" role={error === null ? undefined : 'alert'}>
          {error === null ? 'loading…' : `pull requests unavailable — ${error}`}
        </p>
      ) : !data.token ? (
        <p className="prs-status">{NO_TOKEN}</p>
      ) : (
        <>
          {error !== null && (
            <p className="prs-status prs-status-error" role="alert">
              {`refresh failed — ${error}`}
            </p>
          )}
          {data.repos.length === 0 ? (
            <p className="prs-status">no GitHub repo registered</p>
          ) : (
            <>
              <div className="prs-toolbar" data-testid="pr-toolbar">
                <Segmented<PrLayout> label="Layout" value={layout} options={PR_LAYOUT_OPTIONS} onChange={setStored} track />
                {hidden.length > 0 && (
                  <p className="prs-toolbar-note">
                    {`${hidden.length} ${hidden.length === 1 ? 'repo' : 'repos'} hidden — no access`}
                    {onOpenSettings !== undefined && (
                      <>
                        {' · '}
                        {/* A button, not an anchor: the destination is the shell's own state (the Sources card's `GitHub › Settings ↗` is the
                            precedent). `prs-textlink`, not `set-link`: that is §8.6's bordered row control and reads as a button inside a sentence. */}
                        <button type="button" className="prs-textlink" onClick={onOpenSettings}>
                          GitHub › Settings
                        </button>
                      </>
                    )}
                  </p>
                )}
                <span className="prs-toolbar-age">
                  <PolledAge polledAt={newestPolledAt(shown)} />
                </span>
              </div>
              {shown.length === 0 ? (
                <p className="prs-status">no repo this token can read</p>
              ) : layout === 'inbox' ? (
                <PrInbox {...props} />
              ) : layout === 'matrix' ? (
                <PrMatrix {...props} />
              ) : (
                <PrCards {...props} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
