/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { setJiraView, useJiraView } from '../client/src/hooks/useJiraView';
import { JIRA_VIEWS, JIRA_VIEW_KEY, isJiraView } from '../client/src/lib/jira-view';

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
