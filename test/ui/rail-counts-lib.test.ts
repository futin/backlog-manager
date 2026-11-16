import { railCounts, sectionTotal, type RailCount, type SectionCounts } from '../../client/src/lib/rail-counts';
import { repo, row } from '../helpers/pr-fixtures';
import type { PullRequestsPayload } from '../../shared/types';

/**
 * The rail's pending counts (`docs/superpowers/specs/2026-11-16-rail-pending-counts-design.md`): which page carries which number, its tone, its exact
 * accessible name, and the top row's sum. The PR fixtures discriminate `total` from the listed rows (a repo whose `total` is 5 lists 2), so a count read from
 * the rows instead of `openPrCount` would not pass by coincidence.
 */

const NONE = { prs: null, liveRuns: 0, jiraNeedsYou: 0 };

/** A one-repo payload with `total` open PRs, of which the first `needYou` rank Needs you (changes requested) and the rest are quiet. */
function prs(total: number, needYou: number, listed = Math.max(needYou, Math.min(total, 2))): PullRequestsPayload {
  const rows = Array.from({ length: listed }, (_, i) =>
    i < needYou ? row({ number: i + 1, review: 'changes-requested' }) : row({ number: i + 1, review: 'approved', checks: 'success' })
  );
  return { token: true, repos: [repo({ repo: 'a/x', total, truncated: listed < total, prs: rows })] };
}

describe('railCounts', () => {
  it('is empty when nothing is pending', () => {
    expect(railCounts(NONE)).toEqual({});
    expect(railCounts({ ...NONE, prs: { token: true, repos: [] } })).toEqual({});
  });

  it("counts every open PR, the repo's total rather than its listed rows, grey while none needs you", () => {
    expect(railCounts({ ...NONE, prs: prs(5, 0) })).toEqual({ github: { prs: { n: 5, tone: 'neutral', label: '5 open PRs' } } });
    expect(railCounts({ ...NONE, prs: prs(1, 0, 1) }).github?.prs?.label).toBe('1 open PR');
  });

  it('turns the PRs count amber and names how many need you', () => {
    expect(railCounts({ ...NONE, prs: prs(5, 1) }).github?.prs).toEqual({ n: 5, tone: 'warn', label: '5 open PRs, 1 needs you' });
    expect(railCounts({ ...NONE, prs: prs(5, 2) }).github?.prs?.label).toBe('5 open PRs, 2 need you');
    expect(railCounts({ ...NONE, prs: prs(1, 1, 1) }).github?.prs?.label).toBe('1 open PR, 1 needs you');
  });

  it('counts live runs on History, grey', () => {
    expect(railCounts({ ...NONE, liveRuns: 1 })).toEqual({ runs: { runs: { n: 1, tone: 'neutral', label: '1 live run' } } });
    expect(railCounts({ ...NONE, liveRuns: 2 }).runs?.runs?.label).toBe('2 live runs');
  });

  it('counts Jira sessions that need you on Sessions, amber, carrying the open handler it was given', () => {
    const open = (): void => undefined;
    expect(railCounts({ ...NONE, jiraNeedsYou: 3, openJiraNeedsYou: open })).toEqual({
      jira: { sessions: { n: 3, tone: 'warn', label: '3 sessions need you', onOpen: open } }
    });
    expect(railCounts({ ...NONE, jiraNeedsYou: 1 }).jira?.sessions?.label).toBe('1 session needs you');
  });

  it('keeps each section to its own number when all three are pending', () => {
    const open = (): void => undefined;
    const c = railCounts({ prs: prs(4, 0), liveRuns: 2, jiraNeedsYou: 1, openJiraNeedsYou: open });
    expect(c.github?.prs?.n).toBe(4);
    expect(c.runs?.runs?.n).toBe(2);
    expect(c.jira?.sessions?.n).toBe(1);
    expect(c.github?.prs?.onOpen).toBeUndefined();
    expect(c.runs?.runs?.onOpen).toBeUndefined();
  });
});

describe('sectionTotal', () => {
  const entry = (n: number, tone: RailCount['tone'], label: string, onOpen?: () => void): RailCount => (onOpen ? { n, tone, label, onOpen } : { n, tone, label });

  it('is null with no entry', () => {
    expect(sectionTotal(undefined, ['a'])).toBeNull();
    expect(sectionTotal({}, ['a'])).toBeNull();
  });

  it('sums, takes amber from any entry, and labels in tree order', () => {
    const entries: SectionCounts = { a: entry(2, 'neutral', 'A', () => undefined), b: entry(3, 'warn', 'B', () => undefined) };
    expect(sectionTotal(entries, ['b', 'a'])).toEqual({ n: 5, tone: 'warn', label: 'B; A' });
  });

  it("carries the one entry's open handler", () => {
    const open = (): void => undefined;
    expect(sectionTotal({ a: entry(2, 'warn', 'A', open) }, ['a'])?.onOpen).toBe(open);
  });

  it('stays grey when every entry is grey', () => {
    expect(sectionTotal({ a: entry(1, 'neutral', 'A'), b: entry(1, 'neutral', 'B') }, ['a', 'b'])?.tone).toBe('neutral');
  });

  it('ignores an entry for a page the tree does not draw', () => {
    expect(sectionTotal({ x: entry(3, 'warn', 'X') }, ['a'])).toBeNull();
  });
});
