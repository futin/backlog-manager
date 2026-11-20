import { originFromState, ticketAddress, ticketState } from '../../client/src/lib/ticket-url';

describe('ticketAddress', () => {
  it('builds the pair on a bare address', () => {
    expect(ticketAddress('/', '', '', 'PAY-12')).toBe('/?section=jira&ticket=PAY-12');
  });

  it('keeps other params and the hash, and replaces a stale deep link', () => {
    expect(ticketAddress('/', '?x=1&section=runs', '#h', 'PAY-7')).toBe('/?x=1&section=jira&ticket=PAY-7#h');
    expect(ticketAddress('/', '?section=jira&ticket=PAY-1', '', 'PAY-2')).toBe('/?section=jira&ticket=PAY-2');
  });
});

describe('originFromState', () => {
  it('reads a recognised origin', () => {
    expect(originFromState({ jiraTicketOrigin: 'sessions' })).toBe('sessions');
    expect(originFromState(ticketState('mentions'))).toBe('mentions');
  });

  it('reads board for anything else', () => {
    expect(originFromState(null)).toBe('board');
    expect(originFromState({ jiraTicketOrigin: 'setup' })).toBe('board');
    expect(originFromState('x')).toBe('board');
    expect(originFromState({})).toBe('board');
  });
});
