import { isJiraKey } from '../shared/types';
import { isJiraHostname, jiraEnv } from '../server/src/jira/env.util';

/**
 * Jira integration, spec §4 (shapes) and §6 (connection): `isJiraKey`, the hostname check and the per-call credential reader. `jiraEnv` is handed an
 * object in every case but one, so no case depends on, or can disturb, the real `process.env`.
 */
describe('isJiraKey', () => {
  it.each(['PAY-1', 'PAY_2-10', 'PAY-01', 'A1-7'])('accepts %j', (value) => {
    expect(isJiraKey(value)).toBe(true);
  });

  it.each(['pay-1', 'P-1', '1PAY-1', 'PAY-', 'PAY-1 ', ' PAY-1', 'PAY-1\n', 123, null, undefined])('rejects %j', (value) => {
    expect(isJiraKey(value)).toBe(false);
  });
});

describe('isJiraHostname', () => {
  it.each(['acme.atlassian.net', 'jira.corp.example'])('accepts %j', (value) => {
    expect(isJiraHostname(value)).toBe(true);
  });

  it.each(['https://acme.atlassian.net', 'acme.atlassian.net/', 'acme.atlassian.net:443', 'acme', 'acme .atlassian.net', ''])('rejects %j', (value) => {
    expect(isJiraHostname(value)).toBe(false);
  });
});

describe('jiraEnv', () => {
  const full = { BM_JIRA_SITE: 'acme.atlassian.net', BM_JIRA_EMAIL: 'ada@example.com', BM_JIRA_TOKEN: 'tok' };

  it('trims all three values', () => {
    expect(jiraEnv({ BM_JIRA_SITE: 'acme.atlassian.net', BM_JIRA_EMAIL: ' ada@example.com ', BM_JIRA_TOKEN: ' tok ' })).toEqual({
      configured: true,
      site: 'acme.atlassian.net',
      email: 'ada@example.com',
      token: 'tok'
    });
  });

  it('lower-cases the site', () => {
    expect(jiraEnv({ ...full, BM_JIRA_SITE: 'ACME.Atlassian.NET' })).toMatchObject({ configured: true, site: 'acme.atlassian.net' });
  });

  it('names the site when it is absent', () => {
    const { BM_JIRA_SITE: _site, ...rest } = full;
    expect(jiraEnv(rest)).toEqual({ configured: false, detail: 'BM_JIRA_SITE is not set' });
  });

  it('names the email when it is whitespace-only', () => {
    expect(jiraEnv({ ...full, BM_JIRA_EMAIL: '   ' })).toEqual({ configured: false, detail: 'BM_JIRA_EMAIL is not set' });
  });

  it('names the token when it is absent', () => {
    const { BM_JIRA_TOKEN: _token, ...rest } = full;
    expect(jiraEnv(rest)).toEqual({ configured: false, detail: 'BM_JIRA_TOKEN is not set' });
  });

  it('names the site first when all three are absent', () => {
    expect(jiraEnv({})).toEqual({ configured: false, detail: 'BM_JIRA_SITE is not set' });
  });

  it('refuses a site that is not a bare hostname, quoting what it was given', () => {
    expect(jiraEnv({ ...full, BM_JIRA_SITE: 'https://acme.atlassian.net/' })).toEqual({
      configured: false,
      detail: 'BM_JIRA_SITE must be a hostname such as acme.atlassian.net (no scheme, path or port): https://acme.atlassian.net/'
    });
  });

  it('is unconfigured under the jest environment when called with no argument — pins the test/helpers/env.ts guard', () => {
    // Exactly '' (not merely unset): an unset key would also pass on a machine with nothing exported, and would prove nothing about the guard.
    expect(process.env.BM_JIRA_SITE).toBe('');
    expect(process.env.BM_JIRA_EMAIL).toBe('');
    expect(process.env.BM_JIRA_TOKEN).toBe('');
    expect(jiraEnv().configured).toBe(false);
  });

  it('reads the object it is given on every call, memoising nothing', () => {
    const a = jiraEnv(full);
    const b = jiraEnv({ ...full, BM_JIRA_TOKEN: 'other' });
    expect(a).toMatchObject({ configured: true, token: 'tok' });
    expect(b).toMatchObject({ configured: true, token: 'other' });
  });
});
