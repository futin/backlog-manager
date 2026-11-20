import { deliveryTargets } from '../../client/src/lib/delivery';
import { stripAgent, stripDelivery } from '../../client/src/lib/jira-strip';
import type { SessionLink } from '../../client/src/lib/jira-sessions';
import { pollAge } from '../../client/src/lib/tracker';
import { STATE_LABEL, type JiraSessionState } from '../../shared/jira-sessions';
import type { GitlabMr, JiraLiveSession } from '../../shared/types';

/**
 * The Detail body's summary strip as data (Jira detail tabs spec §1.2): which Delivery pills draw, in which order, with which words and tones, and which
 * live session leads the Agent cell. Pure, so every stamp is relative to a fixed `now` handed in.
 */

const now = Date.parse('2026-11-19T12:00:00Z');
const minutesAgo = (m: number): string => new Date(now - m * 60_000).toISOString();

let nextIid = 100;
function mr(over: Partial<GitlabMr>): GitlabMr {
  const iid = over.iid ?? nextIid++;
  return {
    project: 'acme/pay-api',
    iid,
    title: `PAY-12 | change ${iid}`,
    webUrl: `https://gitlab.example.test/acme/pay-api/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    sourceBranch: 'pay-12-refunds',
    targetBranch: 'develop',
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(30),
    mergedAt: null,
    pipeline: 'success',
    keys: ['PAY-12'],
    review: null,
    ...over
  };
}

describe('stripDelivery', () => {
  it('draws one pill per target, `<target> · <word>` in deliveryLook’s tone, keyed by the Delivery row id', () => {
    const targets = deliveryTargets([
      mr({ iid: 1, targetBranch: 'develop', pipeline: 'failed', updatedAt: minutesAgo(20) }),
      mr({ iid: 2, targetBranch: 'demo', pipeline: 'success', updatedAt: minutesAgo(10) })
    ]);
    const { pills, more } = stripDelivery(targets, false, now);
    expect(pills).toEqual([
      { key: 'acme/pay-api\u0000develop', label: 'develop · pipeline failed', tone: 'red' },
      { key: 'acme/pay-api\u0000demo', label: 'demo · pipeline passed', tone: 'green' }
    ]);
    expect(more).toBeNull();
  });

  it('leads each pill with the repo basename only when the targets span more than one project', () => {
    const targets = deliveryTargets([
      mr({ iid: 1, project: 'acme/pay-api', targetBranch: 'develop', updatedAt: minutesAgo(20) }),
      mr({ iid: 2, project: 'acme/pay-web', targetBranch: 'develop', pipeline: 'running', updatedAt: minutesAgo(10) })
    ]);
    expect(stripDelivery(targets, true, now).pills.map((p) => p.label)).toEqual(['pay-web → develop · pipeline running', 'pay-api → develop · pipeline passed']);
    expect(stripDelivery(targets, false, now).pills.map((p) => p.label)).toEqual(['develop · pipeline running', 'develop · pipeline passed']);
  });

  it('Review Focus 4: five targets → red, amber, amber, then `+2` in the tone of the first folded pill (green)', () => {
    // leadOrder over five open leads is newest first: green 1 h, grey 2 h, amber 3 h, amber 4 h, red 5 h.
    const targets = deliveryTargets([
      mr({ iid: 11, targetBranch: 'develop', pipeline: 'success', updatedAt: minutesAgo(60) }),
      mr({ iid: 12, targetBranch: 'demo', pipeline: null, updatedAt: minutesAgo(120) }),
      mr({ iid: 13, targetBranch: 'staging', pipeline: 'running', updatedAt: minutesAgo(180) }),
      mr({ iid: 14, targetBranch: 'release', pipeline: 'running', updatedAt: minutesAgo(240) }),
      mr({ iid: 15, targetBranch: 'main', pipeline: 'failed', updatedAt: minutesAgo(300) })
    ]);
    expect(targets.map((t) => t.target)).toEqual(['develop', 'demo', 'staging', 'release', 'main']);
    const { pills, more } = stripDelivery(targets, false, now);
    expect(pills.map((p) => [p.label, p.tone])).toEqual([
      ['main · pipeline failed', 'red'],
      ['staging · pipeline running', 'amber'],
      ['release · pipeline running', 'amber']
    ]);
    expect(more).toEqual({ count: 2, tone: 'green' });
  });

  it('folds into `+N` in the worst folded tone when that is not the first in leadOrder', () => {
    // Three reds and one amber: the reds fill the three places, so the amber is the one folded and `+1` wears amber.
    const targets = deliveryTargets([
      mr({ iid: 21, targetBranch: 'develop', pipeline: 'running', updatedAt: minutesAgo(10) }),
      mr({ iid: 22, targetBranch: 'demo', pipeline: 'failed', updatedAt: minutesAgo(20) }),
      mr({ iid: 23, targetBranch: 'staging', pipeline: 'failed', updatedAt: minutesAgo(30) }),
      mr({ iid: 24, targetBranch: 'release', pipeline: 'failed', updatedAt: minutesAgo(40) })
    ]);
    const { pills, more } = stripDelivery(targets, false, now);
    expect(pills.map((p) => p.tone)).toEqual(['red', 'red', 'red']);
    expect(more).toEqual({ count: 1, tone: 'amber' });
  });

  it('draws nothing for no targets', () => {
    expect(stripDelivery([], false, now)).toEqual({ pills: [], more: null });
  });
});

function link(over: Partial<SessionLink> & { state: JiraSessionState }): SessionLink {
  return {
    key: 'PAY-12',
    sessionId: `s-${over.state}-${over.startedAt ?? ''}`,
    how: 'run',
    action: 'execute',
    name: 'Execute PAY-12',
    repo: '/Users/dana/pay',
    branch: null,
    surface: 'dashboard',
    model: null,
    effort: null,
    snapshot: { summary: 'Refund partial captures', type: 'Story', parentKey: 'PAY-3' },
    startedAt: minutesAgo(5),
    endedAt: null,
    endReason: null,
    quietSince: null,
    reattachedAt: null,
    row: null,
    stateSince: minutesAgo(5),
    ...over
  };
}

const RESERVED: JiraLiveSession = { name: 'Execute PAY-12', sessionId: null, startedAt: minutesAgo(1), repo: '/Users/dana/pay', starting: true };

describe('stripAgent', () => {
  it('T27: a session waiting on an answer leads over a newer working one, with `+1` for the other', () => {
    const working = link({ state: 'working', startedAt: minutesAgo(3), stateSince: minutesAgo(3) });
    const waiting = link({ state: 'answer', startedAt: minutesAgo(10), stateSince: minutesAgo(10) });
    const got = stripAgent({ links: [working, waiting], starting: null }, 5, now);
    expect(got).toEqual({ lead: { state: 'answer', text: `${STATE_LABEL.answer} · ${pollAge(minutesAgo(10), now)}` }, more: 1 });
    expect(pollAge(minutesAgo(10), now)).toBe('10m');
  });

  it('a working session leads over a starting reservation, which leads over a quiet one; newest first within a state', () => {
    const olderWorking = link({ state: 'working', startedAt: minutesAgo(40), stateSince: minutesAgo(40) });
    const newerWorking = link({ state: 'working', startedAt: minutesAgo(8), stateSince: minutesAgo(7) });
    const quiet = link({ state: 'quiet', startedAt: minutesAgo(2), stateSince: minutesAgo(2) });
    expect(stripAgent({ links: [olderWorking, quiet, newerWorking], starting: RESERVED }, 0, now)).toEqual({
      lead: { state: 'working', text: `${STATE_LABEL.working} · 7m` },
      more: 3
    });
    expect(stripAgent({ links: [quiet], starting: RESERVED }, 0, now)).toEqual({ lead: { state: 'starting', text: `${STATE_LABEL.starting} · 1m` }, more: 1 });
  });

  it('a starting reservation alone takes its age from `startedAt`', () => {
    const reserved = { ...RESERVED, startedAt: minutesAgo(4) };
    expect(stripAgent({ links: [], starting: reserved }, 2, now)).toEqual({ lead: { state: 'starting', text: `${STATE_LABEL.starting} · 4m` }, more: 0 });
  });

  it('with nothing live: `idle · N ended`, or `no sessions` on a ticket that never had one', () => {
    expect(stripAgent({ links: [], starting: null }, 5, now)).toEqual({ idle: 'idle · 5 ended' });
    expect(stripAgent({ links: [], starting: null }, 0, now)).toEqual({ idle: 'no sessions' });
  });
});
