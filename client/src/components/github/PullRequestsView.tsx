import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PrBandSub } from './PrBandSub';
import { PrCards } from './PrCards';
import { PrInbox } from './PrInbox';
import { PrMatrix } from './PrMatrix';
import type { PrLayoutProps } from './pr-layout-props';
import { Band } from '../ui/Band';
import { Segmented } from '../ui/Segmented';
import { useBoard } from '../../hooks/useBoard';
import { useNow } from '../../hooks/useNow';
import { useOrchestratorRunsContext } from '../../hooks/OrchestratorRunsContext';
import { usePersistedState } from '../../hooks/usePersistedState';
import { usePullRequestsContext } from '../../hooks/PullRequestsContext';
import { emptyRepoNote, parseLayout, PR_LAYOUT_KEY, PR_LAYOUT_OPTIONS, splitReach, type PrLayout } from '../../lib/pr-layouts';
import type { PrRunContext } from '../../lib/pr-run';
import { applyUpdateOutcome, findPr, groupRepos, mergeBlock, outcomeLine, updateTransition, UPDATING_MS, type PrOutcome, type UpdateMark } from '../../lib/prs';
import type { PrWriteResult } from '../../../../shared/types';

/** The page's own words for the token-less server — an instruction, because the only fix is on the host. */
const NO_TOKEN = 'no token — set BM_GITHUB_TOKEN in .env and restart';

/** How often the run-in-progress warning's clock moves. A live claim goes stale in minutes, so a quarter-minute is ample, and the run poll re-renders anyway. */
const WARNING_CLOCK_MS = 15_000;

/**
 * GitHub › PRs (.claude/DESIGN.md §8.11; source-sections spec, Goal 2 and "Left to the builder"): the open pull requests of every registered GitHub repo,
 * with merge, auto-merge and update branch — grouped by repo in Cards, ranked across repos in Inbox and Matrix.
 *
 * **Reads.** `usePullRequestsContext` is the shell's one read of `GET /api/prs` (spec §4.9a; `PullRequestsProvider`), shared with GitHub › Settings' `Access` card
 * — the shell reads while a GitHub project is registered, because the rail counts PRs that need you on every page. The run-in-progress warning (`prRunWarning`) is derived from
 * what the Board already polls: `useBoard`'s items and projects and the shell's one runs poll (`useOrchestratorRunsContext`): runs, remote runs and remote
 * launches — no request of its own.
 *
 * **Order.** Cards draws `groupRepos`' order: repos with open PRs first, most recently touched on top, then the empty ones by name; each repo's PRs newest
 * update first. Inbox and Matrix rank across repos instead (`rankPrs`). The payload's own order is never what is drawn.
 *
 * **Layouts and reach.** Three layouts — Inbox (the default), Matrix and Cards — behind a `Segmented` in the band's trailing slot (`PR_LAYOUT_OPTIONS`, all three at every
 * width: Matrix scrolls sideways on a phone rather than vanishing), the choice stored per device (`PR_LAYOUT_KEY`, read through `parseLayout` so a hand-edited
 * value is Inbox). A repo the token cannot read (`splitReach`: `forbidden`, `not-found`) is never handed to a layout, never counted in `N open in M repos`, and is named
 * only by the toolbar's `N repos hidden — no access · GitHub › Settings`, the link being `onOpenSettings` (threaded from `App` like the Sources card's, so the
 * rail's tree stays the only switch); the toolbar holds nothing but these notes and is not drawn without one. The band's sub-line is `PrBandSub`'s `N open in M
 * repos · polled <age>`. In Cards the toolbar also counts the repos it does not draw because they were read and hold nothing (`emptyRepoNote`).
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
 * slow update does not leave the row waiting forever. What each read means is `updateTransition`'s (`lib/prs.ts`), the rule's one home; this page only acts on
 * the answer. The timer's verdict lands only while the page is mounted. Marks, outcomes and timers are this page's, not a layout's, so switching layout
 * mid-update keeps the mark.
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
export default function PullRequestsView({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { data, error, refresh } = usePullRequestsContext();
  const { items, projects } = useBoard();
  const { runs, starting, remote, remoteStarting } = useOrchestratorRunsContext();
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
            const verdict = updateTransition(payload === null ? null : payload.repos, key, sha, true);
            if (verdict.dropMark) dropMark(key);
            setOutcomes((prev) => applyUpdateOutcome(prev, key, verdict.outcome));
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

  // Every read judges every mark (`updateTransition`), and this one may end a mark early, timer and all; one still on the marked head keeps it.
  useEffect(() => {
    if (data === null) return;
    for (const [key, mark] of Object.entries(marks)) {
      const verdict = updateTransition(data.repos, key, mark.sha, false);
      if (verdict.dropMark) dropMark(key);
      setOutcomes((prev) => applyUpdateOutcome(prev, key, verdict.outcome));
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
  // The band draws the switch and the count whenever the payload names a repo; the toolbar is only what is left over — the notes — and is not drawn without one.
  const counted = data !== null && data.token && data.repos.length > 0;
  const toolbarNotes = hidden.length > 0 || emptyNote !== null;
  const props: PrLayoutProps = { repos: shown, outcomes, marks, now, ctx, write, inFlight, confirming, setConfirming };

  return (
    <div className="prs">
      {/* One head for all three layouts (restyle fixes I5): the sub-line counts and dates the page, and the layout switch sits in the trailing slot — both only
          once there is a repo to count, the state the toolbar's switch was drawn in. `prs-band` is this page's layout hook for the phone, where the slot wraps
          under the title at full width. */}
      <Band
        className="prs-band"
        title="Pull requests"
        sub={counted ? <PrBandSub shown={shown} open={open} /> : "open pull requests on this machine's GitHub repos"}
      >
        {counted && (
          <div className="prs-switch">
            <Segmented<PrLayout> label="Layout" value={layout} options={PR_LAYOUT_OPTIONS} onChange={pickLayout} track />
          </div>
        )}
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
              {toolbarNotes && (
                <div className="prs-toolbar" data-testid="pr-toolbar">
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
                </div>
              )}
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
