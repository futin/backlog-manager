import { projectDispatchGate } from '../../../shared/agent';
import type { DispatchGate } from '../../../shared/agent';
import { prKey } from './prs';
import type { AgentsStatus, PrRepoView, PrResolveOutcome, PrResolveState, ProjectSummary, PullRequestRow } from '../../../shared/types';

/**
 * The GitHub › PRs page's Resolve conflicts row, derived (spec 2026-11-17-pr-conflict-resolve-design.md, "The board"). Pure and stateless: the hook owns
 * when the resolve states are read, the row only asks these what to draw. Kept apart from `prs.ts` because the inputs are a second read
 * (`GET /api/agents/pr-resolve`) and the agents gate, neither of which the PR helpers there know about.
 */

/**
 * The last outcome that still describes THIS PR, or `null`. An outcome is a claim about one head, so it stops showing the moment the PR moves on:
 *  - `stopped` / `up-to-date` show while the PR is at the head the resolve read (`headSha`; the skill writes `fromSha` there for both), because a push by
 *    somebody else makes the reason stale and the next click deserves a clean row;
 *  - `pushed` shows while the PR is still at `fromSha` (GitHub's PR cache, up to its TTL, has not seen our push yet) or at `headSha` while GitHub still
 *    reads the PR `conflicting` or `unknown` (it has seen the push and not finished re-computing mergeability). Once it reads `mergeable` the note has
 *    done its job, and any other head is somebody else's push.
 */
export function shownOutcome(pr: PullRequestRow, outcome: PrResolveOutcome | null): PrResolveOutcome | null {
  if (outcome === null) return null;
  if (outcome.outcome === 'pushed') {
    if (pr.headSha === outcome.fromSha) return outcome;
    if (pr.headSha === outcome.headSha && pr.mergeable !== 'mergeable') return outcome;
    return null;
  }
  return pr.headSha === outcome.headSha ? outcome : null;
}

/**
 * Why Resolve conflicts is disabled, or `null`: the first of the spec table's rows that holds, in the route's own ladder order so the sentence a person sees
 * before the click is the one the route would refuse with. A stopped outcome is deliberately NOT a block — the row is enabled again for another try. The
 * caller never asks with a `hidden` gate (an environment-level block removes the row; `.claude/rules/board.md`), so only `disabled` is read here.
 * `warning` is `prRunWarning`'s text for this PR, passed in because it needs the run context this module does not hold; it is last, as the one board-only reason.
 */
export function resolveBlock(
  pr: PullRequestRow,
  repo: PrRepoView,
  gate: DispatchGate,
  state: PrResolveState | undefined,
  warning: string | null
): string | null {
  if (repo.syncOff !== null) return 'sync off';
  if (gate.control === 'disabled') return gate.reason;
  if (pr.crossRepository) return 'fork — cannot push';
  if (pr.mergeable === 'unknown') return 'mergeability pending';
  if (pr.mergeable === 'mergeable') return 'no conflicts';
  if (state?.live != null) return 'resolving…';
  if (shownOutcome(pr, state?.outcome ?? null)?.outcome === 'pushed') return 'resolved — waiting for GitHub';
  return warning;
}

/**
 * The dispatch gate for resolving a PR of `repo`, or `null` while the agents status is unread. The session starts in the repo's FIRST registered project's
 * path (the path the PR writes already resolve), so that project's gate is the one asked — a second project on the same repo cannot make a launch possible
 * the route would refuse. No project on the repo is `hidden` with no reason: there is nothing to say and nothing to draw.
 */
export function resolveGateFor(status: AgentsStatus | null, repo: string, projects: readonly ProjectSummary[]): DispatchGate | null {
  if (status === null) return null;
  const project = projects.find((p) => p.repo === repo);
  if (project === undefined) return { control: 'hidden', reason: '' };
  return projectDispatchGate(status, project.path);
}

/** The resolve states keyed by `prKey`. Built over the whole payload, so a PR no repo shows is still in the map; only a row that draws that PR reads it. */
export function resolveIndex(states: readonly PrResolveState[]): ReadonlyMap<string, PrResolveState> {
  return new Map(states.map((s) => [prKey(s.repo, s.number), s]));
}
