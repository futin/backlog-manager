/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { JIRA_IGNORED_STEPS_KEY, useIgnoredSteps } from '../../client/src/hooks/useIgnoredSteps';
import { ignoreKey } from '../../client/src/lib/ignored-steps';
import type { GitlabMr, GitlabReview } from '../../shared/types';
import { daysAgoStamp } from '../helpers/dates';

/*
  The ignore store (Jira detail tabs spec §4.5.1, T29 and T30, Review Focus 5): the module store over `lib/ignored-steps.ts`. The pure half has its own suite
  (`test/gitlab/ignored-steps.test.ts`); these cases are the store round trip — a write reaches every mounted reader, survives a remount through
  `localStorage`, prunes only the writing ticket's own merged MRs, and still reaches the screen when storage throws.
*/

type Api = ReturnType<typeof useIgnoredSteps>;
let api: Api;

function Reader({ id }: { id: string }) {
  const hook = useIgnoredSteps();
  if (id === 'a') api = hook;
  return <span data-testid={id}>{Object.keys(hook.entries).sort().join(',')}</span>;
}

function review(over: Partial<GitlabReview> = {}): GitlabReview {
  return {
    open: 0,
    resolved: 0,
    worst: null,
    bySeverity: { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 },
    triggeredAt: null,
    landedAt: null,
    commitsSince: 0,
    capped: false,
    readAt: daysAgoStamp(0),
    failed: false,
    ...over
  };
}

function mr(iid: number, over: Partial<GitlabMr> = {}): GitlabMr {
  return {
    project: 'acme/pay-api',
    iid,
    title: `PAY-7 | change ${iid}`,
    webUrl: `https://gitlab.example.test/acme/pay-api/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    sourceBranch: `pay-7-change-${iid}`,
    targetBranch: 'develop',
    createdAt: daysAgoStamp(30 + iid),
    updatedAt: daysAgoStamp(1 + iid / 100),
    mergedAt: null,
    pipeline: 'failed',
    keys: ['PAY-7'],
    review: null,
    ...over
  };
}

const stored = (): unknown => JSON.parse(localStorage.getItem(JIRA_IGNORED_STEPS_KEY) ?? 'null');

beforeEach(() => {
  localStorage.clear();
});

describe('the ignore store', () => {
  it('reads {} with nothing stored, and for a stored value that is not JSON', () => {
    render(<Reader id="a" />);
    expect(api.entries).toEqual({});
    localStorage.setItem(JIRA_IGNORED_STEPS_KEY, '{not json');
    render(<Reader id="b" />);
    expect(screen.getByTestId('b')).toHaveTextContent('');
  });

  it('records the state and the stamp the step shows, per MR and per half (two keys)', () => {
    render(<Reader id="a" />);
    const a = mr(41, { updatedAt: daysAgoStamp(2), pipeline: 'failed' });
    const b = mr(42, { updatedAt: daysAgoStamp(3), pipeline: 'canceled' });
    act(() => api.ignore(a, 'pipeline', null));
    act(() => api.ignore(b, 'review', null));
    expect(api.entries).toEqual({
      [ignoreKey(a)]: { pipeline: { status: 'failed', updatedAt: a.updatedAt } },
      [ignoreKey(b)]: { review: { state: 'unread', landedAt: null } }
    });
  });

  it('keeps the other half on ignore and on unignore, and removes an entry that is left empty', () => {
    render(<Reader id="a" />);
    const a = mr(41);
    act(() => api.ignore(a, 'pipeline', null));
    act(() => api.ignore(a, 'review', null));
    expect(Object.keys(api.entries[ignoreKey(a)]).sort()).toEqual(['pipeline', 'review']);
    act(() => api.unignore(a, 'review', null));
    expect(Object.keys(api.entries[ignoreKey(a)])).toEqual(['pipeline']);
    act(() => api.unignore(a, 'pipeline', null));
    expect(api.entries).toEqual({});
    expect(stored()).toEqual({});
  });

  it('applies two writes in one handler on top of each other', () => {
    render(<Reader id="a" />);
    const a = mr(41);
    const b = mr(42);
    act(() => {
      api.ignore(a, 'pipeline', null);
      api.ignore(b, 'pipeline', null);
    });
    expect(Object.keys(api.entries).sort()).toEqual([ignoreKey(a), ignoreKey(b)]);
  });

  it('survives a write, an unmount and a remount for a `none` and an `unread` review (T29)', () => {
    const none = mr(41, { review: review({ triggeredAt: null, landedAt: null }) });
    const unread = mr(42, { review: null });
    const first = render(<Reader id="a" />);
    act(() => api.ignore(none, 'review', null));
    act(() => api.ignore(unread, 'review', null));
    first.unmount();
    expect(stored()).toEqual({
      [ignoreKey(none)]: { review: { state: 'none', landedAt: null } },
      [ignoreKey(unread)]: { review: { state: 'unread', landedAt: null } }
    });
    render(<Reader id="a" />);
    expect(api.entries).toEqual(stored());
  });

  it('reaches a second mounted reader on one write', () => {
    render(
      <>
        <Reader id="a" />
        <Reader id="b" />
      </>
    );
    act(() => api.ignore(mr(41), 'pipeline', null));
    expect(screen.getByTestId('a')).toHaveTextContent('acme/pay-api!41');
    expect(screen.getByTestId('b')).toHaveTextContent('acme/pay-api!41');
  });

  describe('the prune on a write (T30)', () => {
    const open = mr(41);
    const mergedOther = mr(7, { state: 'merged', mergedAt: daysAgoStamp(1), pipeline: null });
    const mergedOwn = mr(41, { state: 'merged', mergedAt: daysAgoStamp(1), pipeline: null });

    it("leaves ticket A's `!41` when ticket B's write holds a merged `!7`", () => {
      render(<Reader id="a" />);
      act(() => api.ignore(open, 'pipeline', null));
      const bOpen = mr(9, { project: 'acme/pay-web', keys: ['PAY-8'] });
      act(() => api.ignore(bOpen, 'pipeline', [bOpen, mergedOther]));
      expect(Object.keys(api.entries).sort()).toEqual([ignoreKey(open), ignoreKey(bOpen)]);
    });

    it("drops A's `!41` on A's own write once `!41` is merged", () => {
      render(<Reader id="a" />);
      act(() => api.ignore(open, 'pipeline', null));
      const second = mr(42);
      act(() => api.ignore(second, 'pipeline', [mergedOwn, second]));
      expect(Object.keys(api.entries)).toEqual([ignoreKey(second)]);
      expect(Object.keys(stored() as object)).toEqual([ignoreKey(second)]);
    });

    it('drops nothing when ticketMrs is null', () => {
      render(<Reader id="a" />);
      act(() => api.ignore(open, 'pipeline', null));
      act(() => api.ignore(mr(42), 'pipeline', null));
      act(() => api.unignore(mr(42), 'pipeline', null));
      expect(Object.keys(api.entries)).toEqual([ignoreKey(open)]);
    });
  });

  it('still reaches the mounted readers when localStorage.setItem throws, and throws nothing', () => {
    render(
      <>
        <Reader id="a" />
        <Reader id="b" />
      </>
    );
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => act(() => api.ignore(mr(41), 'pipeline', null))).not.toThrow();
      expect(screen.getByTestId('a')).toHaveTextContent('acme/pay-api!41');
      expect(screen.getByTestId('b')).toHaveTextContent('acme/pay-api!41');
      expect(localStorage.getItem(JIRA_IGNORED_STEPS_KEY)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });
});
