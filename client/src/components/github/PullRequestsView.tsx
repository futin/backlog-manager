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
import { emptyRepoNote, newestPolledAt, parseLayout, PR_LAYOUT_KEY, PR_LAYOUT_OPTIONS, splitReach, type PrLayout } from '../../lib/pr-layouts';
import type { PrRunContext } from '../../lib/pr-run';
import { groupRepos, mergeBlock, outcomeLine, UPDATING_MS, type PrOutcome, type UpdateMark } from '../../lib/prs';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../../../../shared/types';

/** The page's own words for the token-less server — an instruction, because the only fix is on the host. */
const NO_TOKEN = 'no token — set BM_GITHUB_TOKEN in .env and restart';

/** How often the run-in-progress warning's clock moves. A live claim goes stale in minutes, so a quarter-minute is ample, and the run poll re-renders anyway. */
const WARNING_CLOCK_MS = 15_000;

/** What a PR whose head moved under its update mark says: the update landed, whichever read saw it first. */
const BRANCH_UPDATED: PrOutcome = { text: 'branch updated', kind: 'ok' };

/** The repo and PR a `<repo>#<number>` key names in a read, or `undefined` when that read does not list it. */
function findPr(repos: readonly PrRepoView[], key: string): { repo: PrRepoView; pr: PullRequestRow } | undefined {
  const at = key.lastIndexOf('#');
  const repo = repos.find((r) => r.repo === key.slice(0, at));
  const pr = repo?.prs.find((p) => p.number === Number(key.slice(at + 1)));
  return repo === undefined || pr === undefined ? undefined : { repo, pr };
}

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
 * **Layouts and reach.** Three layouts — Inbox (the default), Matrix and Cards — behind a `Segmented` in the toolbar (`PR_LAYOUT_OPTIONS`, all three at every
 * width: Matrix scrolls sideways on a phone rather than vanishing), the choice stored per device (`PR_LAYOUT_KEY`, read through `parseLayout` so a hand-edited
 * value is Inbox). A repo the token cannot read (`splitReach`: `forbidden`, `not-found`) is never handed to a layout, never counted in `N open`, and is named
 * only by the toolbar's `N repos hidden — no access · GitHub › Settings`, the link being `onOpenSettings` (threaded from `App` like the Sources card's, so the
 * rail's tree stays the only switch). In Cards the toolbar also counts the repos it does not draw because they were read and hold nothing (`emptyRepoNote`).
 * Empty states, in order: the PAYLOAD has no repo → `no GitHub repo registered`; it has repos but none is shown → `no repo this token can read`; otherwise the
 * layout, which says `no open pull requests` itself, once.
 *
 * **Repo heading (Cards).** The repo, `polled N s ago`, a `sync off` pill beside the server's full sentence (`repo.syncOff`, `syncOffBlock`'s one home — never
 * a client copy) when the repo's sync is off, and `showing <n> of <total>` when GitHub had more than one page. Each repo is a `Sheet`, Settings' card ground, so
 * two repos never read as one list. Inbox and Matrix say the same things once, in `PrRepoNotes`, and every layout says a repo it could not read there.
 *
 * **Writes and their outcomes.** A row asks the page to run a write (`write`); the page records the one-line outcome under `<repo>#<number>` — the server's
 * own word through `outcomeLine`, or a refusal's sentence verbatim (`prs-api`'s `errorOf`) — then re-reads, after success AND failure, because a refusal
 * such as a moved head is exactly when the row is out of date. The outcome lives here and not in the row because a merge's re-read takes the PR off the open
 * list: a repo keeps a `#12 merged` line for a PR that left it, or the most important outcome on the page would vanish with the row that earned it. A PR's
 * line is cleared the moment its next write leaves, and a repo shows only its newest `DEPARTED_KEEP` departed lines, so a page left mounted through many
 * writes does not pile them up (#396).
 *
 * **`updating…`.** GitHub answers update-branch with 202 and merges later, so the page marks the PR at the head SHA it asked from (`UpdateMark`), and the row
 * says `updating…` for as long as the mark is PRESENT — no clock of its own, so a render can never free `Update` before a read has judged the update. Any read
 * that shows the head moved drops the mark and says `branch updated`; one that no longer lists the PR drops the mark alone. After `UPDATING_MS` the mark's
 * timer re-reads once and judges THAT answer: a new head is `branch updated`, the same head (or a failed read) drops the mark and the `updating…` line, so a
 * slow update does not leave the row waiting forever. The timer's verdict lands only while the page is mounted. Marks, outcomes and timers are this page's,
 * not a layout's, so switching layout mid-update keeps the mark.
 *
 * **The Confirm.** One merge Confirm per page (`confirming`, a key), opened by a row's `Merge` and closed by Cancel, by any write of that PR leaving, by a
 * layout switch, and by a read in which its PR is gone or `mergeBlock` refuses it — so a Confirm never outlives the facts it was opened on, and a PR whose
 * checks recover does not re-open one nobody asked for.
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
  const mountedRef = useRef(true);

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
          timers.current.delete(key);
          // The mark stays until this read is in: dropping it first would free `Update` on a head the update may be moving that very moment.
          void refresh().then((payload) => {
            if (!mountedRef.current) return;
            const found = payload === null ? undefined : findPr(payload.repos, key);
            dropMark(key);
            if (payload !== null && found === undefined) return;
            if (found !== undefined && found.pr.headSha !== sha) {
              setOutcomes((prev) => ({ ...prev, [key]: BRANCH_UPDATED }));
              return;
            }
            setOutcomes((prev) => {
              if (prev[key]?.kind !== 'updating') return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          });
        }, UPDATING_MS)
      );
      setMarks((prev) => ({ ...prev, [key]: { sha } }));
    },
    [dropMark, refresh]
  );

  // Every pending timer goes with the page: a re-read for a page nobody is on is the one read this page must never make. `mountedRef` covers the one a timer
  // already started, whose answer may land after the page has gone.
  useEffect(() => {
    const pending = timers.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // A read that shows the head moved ends the mark early, timer and all, and says the update landed; one that no longer lists the PR ends the mark alone; one
  // still on the marked head keeps it.
  useEffect(() => {
    if (data === null) return;
    for (const [key, mark] of Object.entries(marks)) {
      const found = findPr(data.repos, key);
      if (found === undefined) dropMark(key);
      else if (found.pr.headSha !== mark.sha) {
        dropMark(key);
        setOutcomes((prev) => ({ ...prev, [key]: BRANCH_UPDATED }));
      }
    }
  }, [data, marks, dropMark]);

  // A read in which the confirming PR is gone, or would be refused a merge, closes its Confirm for good — not merely hides it until the PR recovers.
  useEffect(() => {
    if (data === null || confirming === null) return;
    const found = findPr(data.repos, confirming);
    if (found === undefined || mergeBlock(found.pr, found.repo) !== null) setConfirming(null);
  }, [data, confirming]);

  const write = useCallback(
    async (key: string, sha: string, call: () => Promise<PrWriteResult>): Promise<void> => {
      // The Confirm that started this write (or any other of this PR's) has done its job; it closes before the call, not when the answer lands.
      setConfirming((prev) => (prev === key ? null : prev));
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
  // A Confirm belongs to the layout it was opened in; switching closes it rather than carrying it to a row drawn somewhere else.
  const pickLayout = (next: PrLayout): void => {
    setConfirming(null);
    setStored(next);
  };
  const emptyNote = layout === 'cards' ? emptyRepoNote(shown, outcomes) : null;
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
                <Segmented<PrLayout> label="Layout" value={layout} options={PR_LAYOUT_OPTIONS} onChange={pickLayout} track />
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
                {emptyNote !== null && <span className="prs-toolbar-note">{emptyNote}</span>}
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
