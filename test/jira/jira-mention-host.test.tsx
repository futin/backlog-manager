/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { JiraMentionMarkFor } from '../../client/src/components/jira/JiraMentionMarkFor';
import { MentionModalHost } from '../../client/src/components/jira/MentionModalHost';
import { MentionOpenContext } from '../../client/src/components/jira/MentionOpenContext';
import { JiraMentionsContext } from '../../client/src/hooks/JiraMentionsContext';
import type { JiraMentionsState } from '../../client/src/hooks/useJiraMentions';
import { TimeZoneContext } from '../../client/src/hooks/TimeZoneContext';
import type { JiraMention, JiraMentionIssue, JiraMentionsConfigured } from '../../shared/types';
import { daysAgoStamp } from '../helpers/dates';

/*
  The mention modal host and the board's mark connector (Jira mentions <-> board link, Task 4). The host over a stub `JiraMentionsContext` value: the same
  modal the Mentions page draws, its state derived from the live payload on every render.
*/

function m(id: string, name: string, excerpt: string, key: string, days: number): JiraMention {
  return {
    commentId: id,
    author: { accountId: `acc-${name}`, name },
    created: daysAgoStamp(days),
    excerpt,
    url: `https://acme.atlassian.net/browse/${key}?focusedCommentId=${id}`
  };
}
const issue = (key: string, mentions: JiraMention[]): JiraMentionIssue => ({
  key,
  summary: `Summary of ${key}`,
  type: 'Bug',
  status: { name: 'In Progress', category: 'indeterminate' },
  boards: [],
  draft: null,
  session: null,
  mentions
});
const M2 = m('m2', 'Ivo', 'newer question for you', 'PAY-1', 0.1);
const M1 = m('m1', 'Mara', 'older question', 'PAY-1', 0.2);
const PAY1 = issue('PAY-1', [M2, M1]);
const PAY4 = issue('PAY-4', [m('m9', 'Lukas', 'one more', 'PAY-4', 0.3)]);
const PAY3 = issue('PAY-3', [m('m5', 'Tomas', 'set aside', 'PAY-3', 0.4)]);

function payload(over: Partial<JiraMentionsConfigured> = {}): JiraMentionsConfigured {
  return {
    configured: true,
    polledAt: daysAgoStamp(0.001),
    detail: null,
    truncated: false,
    retryAt: null,
    window: 30,
    me: 'Andreja',
    issues: [PAY1, PAY4],
    dismissed: [PAY3],
    ...over
  } as JiraMentionsConfigured;
}
const ok = () => Promise.resolve({ ok: true } as const);
function ctx(data: JiraMentionsConfigured): JiraMentionsState {
  return {
    data,
    loading: false,
    error: null,
    reload: () => {},
    sweep: () => Promise.resolve(),
    checking: false,
    dismiss: ok,
    restore: ok,
    discardDraft: ok,
    postReply: ok
  } as JiraMentionsState;
}

beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () =>
        Promise.resolve({
          key: 'PAY-1',
          total: 1,
          truncated: false,
          comments: [{ id: 'm2', author: { accountId: 'acc-Ivo', name: 'Ivo' }, created: daysAgoStamp(0.1), markdown: 'newer question for you', mine: false, mentionsMe: true, open: true }]
        })
    })) as never;
});

function host(data: JiraMentionsConfigured, i: JiraMentionIssue, men: JiraMention, position: { at: number; of: number } | null) {
  const el = (d: JiraMentionsConfigured) => (
    <TimeZoneContext.Provider value={{ zone: 'UTC', setZone: () => {} } as never}>
      <JiraMentionsContext.Provider value={ctx(d)}>
        <MentionModalHost issue={i} mention={men} position={position} onPrev={null} onNext={null} onClose={() => {}} onOpenPage={null} />
      </JiraMentionsContext.Provider>
    </TimeZoneContext.Provider>
  );
  const r = render(el(data));
  return { rerender: (d: JiraMentionsConfigured) => r.rerender(el(d)) };
}

describe('MentionModalHost', () => {
  it('draws the open footer for a ticket in issues, with its position and mention', async () => {
    host(payload(), PAY1, M2, { at: 1, of: 2 });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('Mention 1 of 2')).toBeInTheDocument();
    expect(await screen.findByText(/newer question for you/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Dismiss$/ })).toBeInTheDocument();
  });

  it('draws the Dismissed footer for a ticket in dismissed', () => {
    host(payload(), PAY3, PAY3.mentions[0], null);
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Dismiss$/ })).toBeNull();
  });

  it('draws the gone state for a ticket in neither list', () => {
    host(payload(), issue('PAY-9', [m('m7', 'Zed', 'gone one', 'PAY-9', 0.5)]), PAY1.mentions[0], null);
    expect(screen.queryByRole('button', { name: /^Dismiss$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
  });

  it('re-reads the live payload on every render: a ticket that moved to dismissed shows the Dismissed footer', () => {
    const h = host(payload(), PAY1, M2, { at: 1, of: 2 });
    expect(screen.getByRole('button', { name: /^Dismiss$/ })).toBeInTheDocument();
    h.rerender(payload({ issues: [PAY4], dismissed: [PAY3, PAY1] }));
    expect(screen.getByRole('button', { name: /Restore/ })).toBeInTheDocument();
  });
});

describe('JiraMentionMarkFor', () => {
  const mark = (key: string, open: ((k: string) => void) | null, withProvider = true) =>
    render(
      <JiraMentionsContext.Provider value={ctx(payload())}>
        {withProvider ? (
          <MentionOpenContext.Provider value={open}>
            <JiraMentionMarkFor issueKey={key} />
          </MentionOpenContext.Provider>
        ) : (
          <JiraMentionMarkFor issueKey={key} />
        )}
      </JiraMentionsContext.Provider>
    );

  it('draws the count and opens the ticket on click', async () => {
    const spy = jest.fn();
    mark('PAY-1', spy);
    await userEvent.click(screen.getByText('@ 2'));
    expect(spy).toHaveBeenCalledWith('PAY-1');
  });

  it('draws @ 1 for a one-mention ticket', () => {
    mark('PAY-4', jest.fn());
    expect(screen.getByText('@ 1')).toBeInTheDocument();
  });

  it('draws nothing for a dismissed ticket', () => {
    const { container } = mark('PAY-3', jest.fn());
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing without an open-context provider', () => {
    const { container } = mark('PAY-1', null, false);
    expect(container).toBeEmptyDOMElement();
  });
});
