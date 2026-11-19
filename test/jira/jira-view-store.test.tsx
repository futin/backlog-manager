/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { setJiraView, useJiraView } from '../../client/src/hooks/useJiraView';
import { DETAIL_TABS, JIRA_DETAIL_TAB_KEY, setJiraDetailTab, useJiraDetailTab } from '../../client/src/hooks/useJiraDetailTab';
import { JIRA_TICKET_KEY_KEY, setJiraTicketKey, useJiraTicketKey } from '../../client/src/hooks/useJiraTicketKey';
import { JIRA_VIEWS, JIRA_VIEW_KEY, isJiraView } from '../../client/src/lib/jira-view';

/*
  The Jira page's stored view (Jira sessions spec C1, Review Focus 4) — `useJiraPage`'s module store: the Board's switch and the page's reader are two
  mounted callers of one value, so a write from either must reach the other, a remount must find it in localStorage, and a stored value no build knows
  must read as the default and never throw.
*/

function Reader({ id }: { id: string }) {
  const [view] = useJiraView();
  return <span data-testid={id}>{view}</span>;
}

beforeEach(() => {
  localStorage.clear();
  act(() => setJiraView('board'));
});

describe('the stored Jira view', () => {
  it('knows exactly board and list', () => {
    expect([...JIRA_VIEWS]).toEqual(['board', 'list']);
    expect(isJiraView('board')).toBe(true);
    expect(isJiraView('list')).toBe(true);
    expect(isJiraView('grid')).toBe(false);
    expect(isJiraView(null)).toBe(false);
  });

  it('reads `board` with nothing stored', () => {
    render(<Reader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('board');
  });

  it('two mounted readers agree after one writes', () => {
    render(
      <>
        <Reader id="a" />
        <Reader id="b" />
      </>
    );
    act(() => setJiraView('list'));
    expect(screen.getByTestId('a')).toHaveTextContent('list');
    expect(screen.getByTestId('b')).toHaveTextContent('list');
  });

  it('survives a remount, through localStorage', () => {
    const first = render(<Reader id="a" />);
    act(() => setJiraView('list'));
    first.unmount();
    expect(JSON.parse(localStorage.getItem(JIRA_VIEW_KEY) ?? 'null')).toBe('list');
    render(<Reader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('list');
  });

  it('a junk stored value reads `board`', () => {
    localStorage.setItem(JIRA_VIEW_KEY, '"carousel"');
    render(<Reader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('board');
  });

  it('an unparseable stored value reads `board` too', () => {
    localStorage.setItem(JIRA_VIEW_KEY, '{not json');
    render(<Reader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('board');
  });
});

/*
  The detail tab and the ticket key (Jira detail tabs spec §1.3, §2.1, T28): two more of the same module stores, over `persistedJsonStore`. The tab is shared by
  the modal and the page, the key by the page, the modal's `Open full page ↗` and the rail's row, so each is two mounted readers of one value.
*/
function TabReader({ id }: { id: string }) {
  return <span data-testid={id}>{useJiraDetailTab()}</span>;
}

function KeyReader({ id }: { id: string }) {
  return <span data-testid={id}>[{useJiraTicketKey()}]</span>;
}

describe('the stored detail tab', () => {
  beforeEach(() => act(() => setJiraDetailTab('ticket')));

  it('knows the four tabs, in the tablist order, under its key', () => {
    expect([...DETAIL_TABS]).toEqual(['ticket', 'delivery', 'agent', 'children']);
    expect(JIRA_DETAIL_TAB_KEY).toBe('backlog-manager.jira-detail-tab');
  });

  it('reads `ticket` with nothing stored, and for a word that is no tab', () => {
    localStorage.clear();
    render(<TabReader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('ticket');
    localStorage.setItem(JIRA_DETAIL_TAB_KEY, '"bogus"');
    render(<TabReader id="b" />);
    expect(screen.getByTestId('b')).toHaveTextContent('ticket');
  });

  it('reads a stored tab', () => {
    localStorage.setItem(JIRA_DETAIL_TAB_KEY, '"delivery"');
    render(<TabReader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('delivery');
  });

  it('re-renders both of two mounted readers on one write, and stores it as JSON', () => {
    render(
      <>
        <TabReader id="a" />
        <TabReader id="b" />
      </>
    );
    act(() => setJiraDetailTab('agent'));
    expect(screen.getByTestId('a')).toHaveTextContent('agent');
    expect(screen.getByTestId('b')).toHaveTextContent('agent');
    expect(localStorage.getItem(JIRA_DETAIL_TAB_KEY)).toBe('"agent"');
  });

  it('still reaches the mounted readers when localStorage.setItem throws', () => {
    render(<TabReader id="a" />);
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => act(() => setJiraDetailTab('children'))).not.toThrow();
      expect(screen.getByTestId('a')).toHaveTextContent('children');
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('the stored ticket key', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => setJiraTicketKey(''));
  });

  it('reads the empty string with nothing stored', () => {
    localStorage.clear();
    render(<KeyReader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('[]');
  });

  it('reads a stored key, and the empty string for a stored value that is not one (T28)', () => {
    localStorage.setItem(JIRA_TICKET_KEY_KEY, '"PAY-12"');
    render(<KeyReader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('[PAY-12]');
    for (const [id, bad] of [['b', '"foo"'], ['c', '42'], ['d', '"PAY-12\\n"'], ['e', '{not json']] as const) {
      localStorage.setItem(JIRA_TICKET_KEY_KEY, bad);
      render(<KeyReader id={id} />);
      expect(screen.getByTestId(id)).toHaveTextContent('[]');
    }
  });

  it('reaches every mounted reader on a write and on a clear, and survives a remount', () => {
    const first = render(
      <>
        <KeyReader id="a" />
        <KeyReader id="b" />
      </>
    );
    act(() => setJiraTicketKey('PAY-31'));
    expect(screen.getByTestId('a')).toHaveTextContent('[PAY-31]');
    expect(screen.getByTestId('b')).toHaveTextContent('[PAY-31]');
    first.unmount();
    expect(localStorage.getItem(JIRA_TICKET_KEY_KEY)).toBe('"PAY-31"');
    render(<KeyReader id="a" />);
    expect(screen.getByTestId('a')).toHaveTextContent('[PAY-31]');
    act(() => setJiraTicketKey(''));
    expect(screen.getByTestId('a')).toHaveTextContent('[]');
  });
});
