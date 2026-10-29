import { useMemo, useState } from 'react';

import { Dot } from '../ui/Dot';
import { Pill } from '../ui/Pill';
import { PrActions } from './PrActions';
import { PrOutcomeLine } from './PrOutcomeLine';
import { PrRepoNotes } from './PrRepoNotes';
import type { PrLayoutProps } from './pr-layout-props';
import { elapsedSince } from '../../lib/item-age';
import { LEVELS, LEVEL_DOT, LEVEL_LABEL, levelCounts, prProblems, prVerdict, quietFacts, rankPrs, transientFailures, type PrLevel, type RankedPr } from '../../lib/pr-layouts';
import { prRunWarning } from '../../lib/pr-run';
import { isUpdating } from '../../lib/prs';

/**
 * GitHub › PRs, Inbox layout (.claude/DESIGN.md §8.11; spec `2026-10-29-prs-layouts-design.md`, "Inbox"): the dashboard Git inbox's shape for pull requests —
 * three count tiles that filter, the PRs that need a person as full items, everything else as one line each. It decides nothing: the level, the rank, the
 * verdict and the steps are `lib/pr-layouts.ts`'s, the run warning is `lib/pr-run.ts`'s, and every write is `PrActions`'s, so the three layouts cannot triage
 * one PR three ways.
 *
 * **Tiles are toggles.** A `<button aria-pressed>` per level — dot, count, label. Clicking one filters, clicking it again clears. The filter is held here as a
 * LEVEL, not as a list of keys, so a PR that a re-read moves out of the selected level simply leaves the list and the empty filter says
 * `No pull request at this level.` — a tile that still selected a PR the data no longer puts there would be lying. A tile for an empty level stays drawn, so
 * the person who selected it can see why the list is empty and click it off.
 *
 * **Every item is keyed by `<repo>#<number>`, never by index.** Two repos can each have a `#7`, and a re-read reorders the list; `PrActions` keeps a write in
 * flight and an open `Confirm` in its own state, and an item that remounted because its position changed would drop the very Confirm a person is reading.
 *
 * **A loud item** (Needs you, Worth a look): dot, `#n` link, title, repo; the verdict, then the steps (the calm ones muted — the run warning and `Approved.`
 * are worth reading beside a problem, not acting on); `author · head → base · age`; the compact actions on the right, which wrap under on a narrow window.
 * **A quiet line** is dot, `#n`, title, repo, `quietFacts` and — when a run is still working the branch — the warning in the warn tone, because a clean
 * `backlog/<id>` PR an orchestrator run has not finished with is exactly a Quiet PR. Its actions are one click further: a separate toggle button
 * (`aria-expanded`) beside the link, NOT a button wrapping it, because a link inside a button is invalid interactive nesting. The strip stays MOUNTED while
 * collapsed (`hidden`) so a write already in flight keeps its busy state if the line is folded. The outcome line is drawn whether or not the line is open —
 * a collapsed part never hides the result of a write (spec, "What every layout carries").
 *
 * **Can't read.** A shown repo whose last read was `rate-limited` or `error` keeps its rows — still ranked, still actionable, a failed refresh is no reason to
 * stop offering a merge — and gets one extra line with its `detail`. The notes (`PrRepoNotes`) carry what is not a PR: outcomes of merged ones, the sync-off
 * sentence, `showing n of total`.
 */

/** `3h ago`, `just now`; `null` when the timestamp cannot be aged, in which case the meta line leaves the age out. */
function ageText(updatedAt: string, now: number): string | null {
  const age = elapsedSince(updatedAt, now);
  return age === null ? null : age === 'now' ? 'just now' : `${age} ago`;
}

/** `author · head → base · age` — the line under a loud item's verdict. */
function ItemMeta({ r, now }: { r: RankedPr; now: number }) {
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
    </div>
  );
}

function LoudItem({ r, props }: { r: RankedPr; props: PrLayoutProps }) {
  const { pr, repo, key } = r;
  const warning = prRunWarning(pr, repo.repo, props.ctx, props.now);
  const { verdict, steps } = prVerdict(prProblems(pr, warning));
  return (
    <li className="prs-inbox-item" data-testid={`pr-item-${key}`}>
      <div className="prs-inbox-main">
        <div className="prs-row-title">
          <Dot size={10} tone={LEVEL_DOT[r.level]} />
          <a className="prs-num" href={pr.url} target="_blank" rel="noreferrer noopener">
            #{pr.number}
          </a>
          <span className="prs-title">{pr.title}</span>
          <span className="prs-inbox-repo">{repo.repo}</span>
        </div>
        {verdict !== null && <p className="prs-inbox-verdict">{verdict}</p>}
        {steps.length > 0 && (
          <ul className="prs-inbox-steps">
            {steps.map((step) => (
              <li key={step.text} className={step.calm ? 'prs-inbox-step prs-inbox-step-calm' : 'prs-inbox-step'}>
                {step.text}
              </li>
            ))}
          </ul>
        )}
        <ItemMeta r={r} now={props.now} />
      </div>
      <div className="prs-inbox-keys">
        <PrActions repo={repo} pr={pr} onWrite={(call) => props.write(key, pr.headSha, call)} variant="compact" />
      </div>
      <PrOutcomeLine outcome={props.outcomes[key]} updating={isUpdating(props.marks[key], pr, props.now)} />
    </li>
  );
}

function QuietLine({ r, props }: { r: RankedPr; props: PrLayoutProps }) {
  const { pr, repo, key } = r;
  const [expanded, setExpanded] = useState(false);
  const warning = prRunWarning(pr, repo.repo, props.ctx, props.now);
  const facts = quietFacts(pr);
  return (
    <li className="prs-inbox-quiet" data-testid={`pr-quiet-${key}`}>
      <div className="prs-inbox-quiet-row">
        <Dot size={10} tone={LEVEL_DOT[r.level]} />
        <a className="prs-num" href={pr.url} target="_blank" rel="noreferrer noopener">
          #{pr.number}
        </a>
        <span className="prs-title">{pr.title}</span>
        <span className="prs-inbox-repo">{repo.repo}</span>
        {facts !== '' && <span className="prs-inbox-facts">{facts}</span>}
        {warning !== null && <Pill tone="warn">{warning}</Pill>}
        <button type="button" className="prs-inbox-toggle" aria-expanded={expanded} aria-label={`Actions for #${pr.number}`} onClick={() => setExpanded((open) => !open)}>
          {expanded ? 'Hide' : 'Actions'}
        </button>
      </div>
      <PrOutcomeLine outcome={props.outcomes[key]} updating={isUpdating(props.marks[key], pr, props.now)} />
      <div className="prs-inbox-quiet-actions" hidden={!expanded}>
        <PrActions repo={repo} pr={pr} onWrite={(call) => props.write(key, pr.headSha, call)} variant="compact" />
      </div>
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

  return (
    <div className="prs-inbox" data-testid="pr-inbox">
      <PrRepoNotes repos={repos} outcomes={outcomes} part="above" />
      {ranked.length === 0 ? (
        <p className="prs-status">no open pull requests</p>
      ) : (
        <>
          <div className="prs-inbox-tiles">
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className="prs-tile"
                aria-pressed={filter === level}
                data-testid={`pr-tile-${level}`}
                onClick={() => setFilter((current) => (current === level ? null : level))}
              >
                <Dot size={10} tone={LEVEL_DOT[level]} />
                <b className="prs-tile-n">{counts[level]}</b> <span>{LEVEL_LABEL[level]}</span>
              </button>
            ))}
          </div>
          {visible.length === 0 && <p className="prs-status">No pull request at this level.</p>}
          {loud.length > 0 && (
            <ul className="prs-inbox-list">
              {loud.map((r) => (
                <LoudItem key={r.key} r={r} props={props} />
              ))}
            </ul>
          )}
          {quiet.length > 0 && (
            <>
              <h3 className="prs-inbox-heading">Quiet</h3>
              <ul className="prs-inbox-list">
                {quiet.map((r) => (
                  <QuietLine key={r.key} r={r} props={props} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {failures.length > 0 && (
        <>
          <h3 className="prs-inbox-heading">Can&apos;t read</h3>
          <ul className="prs-inbox-list">
            {failures.map((repo) => (
              <li key={repo.repo} className="prs-inbox-cantread" data-testid={`pr-cantread-${repo.repo}`}>
                {`${repo.repo} — ${repo.detail ?? repo.access}`}
              </li>
            ))}
          </ul>
        </>
      )}
      <PrRepoNotes repos={repos} outcomes={outcomes} part="below" />
    </div>
  );
}
