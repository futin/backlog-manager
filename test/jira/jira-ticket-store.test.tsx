/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  JIRA_TICKET_KEY_KEY,
  forgetLegacyTicketKey,
  getJiraTicket,
  setJiraTicketKey,
  syncJiraTicket,
  useJiraTicketKey,
  useJiraTicketOrigin,
} from '../../client/src/hooks/useJiraTicketKey';

/*
  The ticket key store writes the address bar, never localStorage (Jira ticket URL spec): none -> key pushes, key -> key replaces, key -> none replaces with
  null state, and `syncJiraTicket` (load seed, popstate) writes nothing.
*/

function Reader() {
  return (
    <span data-testid="r">
      {useJiraTicketKey()}|{useJiraTicketOrigin()}
    </span>
  );
}

let push: jest.SpyInstance;
let replace: jest.SpyInstance;

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  act(() => syncJiraTicket('', 'board'));
  push = jest.spyOn(history, 'pushState');
  replace = jest.spyOn(history, 'replaceState');
});

afterEach(() => {
  push.mockRestore();
  replace.mockRestore();
});

describe('the ticket key store', () => {
  it('pushes on none -> key, replaces on key -> key and key -> none', () => {
    act(() => setJiraTicketKey('PAY-12', 'sessions'));
    expect(push).toHaveBeenCalledTimes(1);
    expect(location.search).toBe('?section=jira&ticket=PAY-12');
    expect(history.state).toEqual({ jiraTicketOrigin: 'sessions' });
    expect(getJiraTicket()).toEqual({ key: 'PAY-12', origin: 'sessions' });

    act(() => setJiraTicketKey('PAY-13'));
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(location.search).toBe('?section=jira&ticket=PAY-13');
    expect(history.state).toEqual({ jiraTicketOrigin: 'sessions' });
    expect(getJiraTicket().origin).toBe('sessions');

    act(() => setJiraTicketKey('PAY-14', 'mentions'));
    expect(replace).toHaveBeenCalledTimes(2);
    expect(getJiraTicket()).toEqual({ key: 'PAY-14', origin: 'sessions' });

    act(() => setJiraTicketKey(''));
    expect(replace).toHaveBeenCalledTimes(3);
    expect(push).toHaveBeenCalledTimes(1);
    expect(location.search).toBe('');
    expect(history.state).toBeNull();
    expect(getJiraTicket()).toEqual({ key: '', origin: 'board' });
  });

  it('defaults the origin to board, and writes nothing for the same key twice', () => {
    act(() => setJiraTicketKey('PAY-12'));
    act(() => setJiraTicketKey('PAY-12'));
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(getJiraTicket().origin).toBe('board');
  });

  it('ignores a value that is not a Jira key', () => {
    act(() => setJiraTicketKey('pay-12'));
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(getJiraTicket().key).toBe('');
  });

  it('syncJiraTicket sets the store, rerenders readers, and writes no history', () => {
    render(<Reader />);
    act(() => syncJiraTicket('PAY-9', 'mentions'));
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('r')).toHaveTextContent('PAY-9|mentions');
  });

  it('writes nothing under the legacy localStorage key', () => {
    act(() => setJiraTicketKey('PAY-12', 'sessions'));
    act(() => setJiraTicketKey('PAY-13'));
    act(() => setJiraTicketKey(''));
    expect(localStorage.getItem(JIRA_TICKET_KEY_KEY)).toBeNull();
  });

  it('forgetLegacyTicketKey removes the old entry and never throws', () => {
    localStorage.setItem('backlog-manager.jira-ticket-key', '"PAY-1"');
    forgetLegacyTicketKey();
    expect(localStorage.getItem('backlog-manager.jira-ticket-key')).toBeNull();
    const spy = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(() => forgetLegacyTicketKey()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
