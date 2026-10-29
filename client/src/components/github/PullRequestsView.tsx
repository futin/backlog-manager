import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PrRow, type PrOutcome } from './PrRow';
import { Band } from '../ui/Band';
import { Pill } from '../ui/Pill';
import { Sheet, SheetHead } from '../ui/Sheet';
import { useBoard } from '../../hooks/useBoard';
import { useNow } from '../../hooks/useNow';
import { useOrchestratorRuns } from '../../hooks/useOrchestratorRuns';
import { usePullRequests } from '../../hooks/usePullRequests';
import { useReportWorking } from '../../hooks/useReportWorking';
import { prRunWarning, type PrRunContext } from '../../lib/pr-run';
import { groupRepos, isUpdating, outcomeLine, UPDATING_MS } from '../../lib/prs';
import { pollAge } from '../../lib/tracker';
import type { PrRepoView, PrWriteResult } from '../../../../shared/types';

/** The page's own words for the token-less server — an instruction, because the only fix is on the host. */
const NO_TOKEN = 'no token — set BM_GITHUB_TOKEN in .env and restart';

/** How often the run-in-progress warning's clock moves. A live claim goes stale in minutes, so a quarter-minute is ample, and the run poll re-renders anyway. */
const WARNING_CLOCK_MS = 15_000;

/** An `update-requested` mark: the head SHA the update was asked at, and when the row stops saying `updating…` if that head never moved. */
interface UpdateMark {
  sha: string;
  until: number;
}

/**
 * `polled 12 s ago`, on a one-second clock of its own: the age is the only reading on the page that moves every second, so it owns its own `useNow` and
 * re-renders a span, not every row of every repo.
 */
function PolledAge({ polledAt }: { polledAt: string | null }) {
  const now = useNow(polledAt !== null, 1_000);
  const age = pollAge(polledAt, now);
  return age === null ? null : <span>{`polled ${age} ago`}</span>;
}

/**
 * GitHub › PRs (.claude/DESIGN.md §8.11; source-sections spec, Goal 2 and "Left to the builder"): the open pull requests of every registered GitHub repo,
 * grouped by repo, with merge, auto-merge and update branch.
 *
 * **Reads.** `usePullRequests` is the page's one read of `GET /api/prs`, and this page is its only mount — leaving the page is what stops PR reads, because
 * the server's PR cache has no timer of its own. The run-in-progress warning (`prRunWarning`) is derived from what the Board already polls: `useBoard`'s items
 * and projects and `useOrchestratorRuns`' runs, remote runs and remote launches — no request of its own. `onWorking` is every view's rail-cursor report
 * (`useReportWorking`, §8.0), and since this page runs a `useOrchestratorRuns()` for the warning anyway, it reports the same reading Board and Archive do: a
 * run on this machine working, not the page loading — a cursor that blinked on a page read would say a run started when none had.
 *
 * **Order.** `groupRepos`: repos with open PRs first, most recently touched on top, then the empty ones by name; each repo's PRs newest update first. The
 * payload's own order is never what is drawn.
 *
 * **Repo heading.** The repo, `polled N s ago`, a `sync off` pill beside the server's full sentence (`repo.syncOff`, `syncOffBlock`'s one home — never a client
 * copy) when the repo's sync is off, the read's `detail` when its last read was not `ok`, and `showing <n> of <total>` when GitHub had more than one page.
 * Each repo is a `Sheet`, Settings' card ground, so two repos never read as one list.
 *
 * **Writes and their outcomes.** A row asks the page to run a write (`write`); the page records the one-line outcome under `<repo>#<number>` — the server's
 * own word through `outcomeLine`, or a refusal's sentence verbatim (`prs-api`'s `errorOf`) — then re-reads, after success AND failure, because a refusal
 * such as a moved head is exactly when the row is out of date. The outcome lives here and not in the row because a merge's re-read takes the PR off the open
 * list: a repo keeps a `#12 merged` line for a PR that left it, or the most important outcome on the page would vanish with the row that earned it.
 *
 * **`updating…`.** GitHub answers update-branch with 202 and merges later, so the page marks the PR at the head SHA it asked from (`UpdateMark`) and the row
 * says `updating…` while `isUpdating` — until a read shows a new head, or `UPDATING_MS` pass. At that moment the page re-reads once (a timer per mark), so the
 * row is not left on a head the update has long since moved; a read that shows the head moved first drops the mark and its timer.
 *
 * No Escape handler here (`Confirm` joins `useDialogEscape` itself) and no page switch (the rail's GitHub tree is the only one). The page scrolls in the well
 * like Settings and reserves no height, so it reads no strip token at all.
 *
 * Default export, because `App` loads it lazily like every other page.
 */
export default function PullRequestsView({ onWorking }: { onWorking?: (working: boolean) => void }) {
  const { data, error, refresh } = usePullRequests();
  const { items, projects } = useBoard();
  const { runs, starting, remote, remoteStarting } = useOrchestratorRuns();
  useReportWorking(runs, starting, onWorking);
  const now = useNow(true, WARNING_CLOCK_MS);

  const [outcomes, setOutcomes] = useState<Record<string, PrOutcome>>({});
  const [marks, setMarks] = useState<Record<string, UpdateMark>>({});
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
    },
    [markUpdating, refresh]
  );

  const ctx: PrRunContext = useMemo(
    () => ({ projects: projects ?? [], items: items?.items ?? [], runs, remote, remoteStarting }),
    [projects, items, runs, remote, remoteStarting]
  );
  const repos = useMemo(() => (data === null ? [] : groupRepos(data.repos)), [data]);
  const open = repos.reduce((n, r) => n + r.total, 0);

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
          {repos.length === 0 && <p className="prs-status">no GitHub repo registered</p>}
          {repos.map((repo) => (
            <RepoSheet key={repo.repo} repo={repo} outcomes={outcomes} marks={marks} now={now} ctx={ctx} write={write} />
          ))}
        </>
      )}
    </div>
  );
}

/** One repo's card: its heading and its rows, plus a line for each PR a write of this page took off the list. */
function RepoSheet({
  repo,
  outcomes,
  marks,
  now,
  ctx,
  write
}: {
  repo: PrRepoView;
  outcomes: Record<string, PrOutcome>;
  marks: Record<string, UpdateMark>;
  now: number;
  ctx: PrRunContext;
  write: (key: string, sha: string, call: () => Promise<PrWriteResult>) => Promise<void>;
}) {
  const listed = new Set(repo.prs.map((pr) => `${repo.repo}#${pr.number}`));
  // A PR a write of this page took off the list (merged) keeps its line; an `updating…` one does not, since there is no row left to be updating.
  const departed = Object.entries(outcomes).filter(
    ([key, outcome]) => key.startsWith(`${repo.repo}#`) && !listed.has(key) && outcome.kind !== 'updating'
  );
  const readings = [
    repo.truncated ? `showing ${repo.prs.length} of ${repo.total}` : null,
    repo.polledAt !== null && repo.prs.length === 0 ? 'no open pull requests' : null
  ].filter((r): r is string => r !== null);

  return (
    <Sheet as="section" className="prs-repo">
      <div className="prs-repo-inner" data-testid={`pr-repo-${repo.repo}`}>
        <div className="prs-repo-head" data-testid={`pr-head-${repo.repo}`}>
          <SheetHead
            title={repo.repo}
            sub={
              <span className="prs-repo-sub">
                <PolledAge polledAt={repo.polledAt} />
                {readings.map((r) => (
                  <span key={r}>{r}</span>
                ))}
              </span>
            }
            right={repo.syncOff !== null ? <Pill tone="warn">sync off</Pill> : undefined}
          />
          {repo.syncOff !== null && <p className="prs-note">{repo.syncOff}</p>}
          {repo.access !== 'ok' && repo.detail !== null && <p className="prs-note prs-note-bad">{repo.detail}</p>}
        </div>
        {repo.prs.length > 0 && (
          <ul className="prs-list" aria-label={`${repo.repo} pull requests`}>
            {repo.prs.map((pr) => {
              const key = `${repo.repo}#${pr.number}`;
              return (
                <PrRow
                  key={pr.number}
                  repo={repo}
                  pr={pr}
                  warning={prRunWarning(pr, repo.repo, ctx, now)}
                  outcome={outcomes[key]}
                  updating={isUpdating(marks[key], pr, now)}
                  onWrite={(call) => write(key, pr.headSha, call)}
                />
              );
            })}
          </ul>
        )}
        {departed.map(([key, outcome]) => (
          <p key={key} className={outcome.kind === 'error' ? 'prs-outcome prs-outcome-error' : 'prs-outcome'}>
            {`#${key.slice(repo.repo.length + 1)} ${outcome.text}`}
          </p>
        ))}
      </div>
    </Sheet>
  );
}
