import { foldMrState, foldPipeline, mrKeys, resolveGitlabProjects } from '../server/src/gitlab/mapping.util';

const SITE = 'www.gitlab.timify.io';

describe('resolveGitlabProjects', () => {
  it('maps origins to projects, merges keys, reports other hosts and unreadable origins, and never leaks a PAT', async () => {
    const origins: Record<string, string | null> = {
      '/r/microservice': 'git@www.gitlab.timify.io:development/backend/microservice.git',
      '/r/proxy': 'https://oauth2:glpat-x@www.gitlab.timify.io/development/dev-api-graphql-proxy.git',
      '/r/gh': 'git@github.com:o/r.git',
      '/r/none': null
    };
    const read = jest.fn(async (p: string) => origins[p]);
    const result = await resolveGitlabProjects({ TIMIFY: ['/r/microservice', '/r/proxy', '/r/gh'], PAY: ['/r/microservice', '/r/none'] }, SITE, read);
    expect(result).toEqual({
      projects: [
        { path: 'development/backend/microservice', repo: 'microservice', jiraKeys: ['PAY', 'TIMIFY'] },
        { path: 'development/dev-api-graphql-proxy', repo: 'proxy', jiraKeys: ['TIMIFY'] }
      ],
      foundHosts: ['github.com'],
      originFailures: ['none']
    });
    expect(JSON.stringify(result)).not.toContain('glpat-x');
  });

  it('answers empty for no repos without reading any origin', async () => {
    const read = jest.fn(async () => null);
    expect(await resolveGitlabProjects({}, SITE, read)).toEqual({ projects: [], foundHosts: [], originFailures: [] });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('mrKeys', () => {
  it.each([
    ['hotfix/timify-123', 'x', ['TIMIFY-123']],
    ['feature/x', 'timify-123 | Export', ['TIMIFY-123']],
    ['timify-1234-x', 'TIMIFY-1234 | y', ['TIMIFY-1234']],
    ['xtimify-123', 'z', []],
    ['timify-123-a', 'TIMIFY-140 | b', ['TIMIFY-123', 'TIMIFY-140']],
    ['pay-7', 'q', []]
  ])('mrKeys(%s, %s)', (branch, title, want) => {
    expect(mrKeys(branch, title, ['TIMIFY'])).toEqual(want);
  });
});

describe('foldPipeline', () => {
  it.each([
    ['success', 'success'],
    ['failed', 'failed'],
    ...['running', 'pending', 'created', 'waiting_for_resource', 'preparing', 'canceling'].map((s) => [s, 'running']),
    ['canceled', 'canceled'],
    ...['skipped', 'manual', 'scheduled', null, undefined, 'brand_new_status'].map((s) => [s, 'none'])
  ])('%s -> %s', (status, want) => {
    expect(foldPipeline(status as string | null | undefined)).toBe(want);
  });
});

describe('foldMrState', () => {
  it.each([
    ['opened', 'opened'],
    ['locked', 'opened'],
    ['merged', 'merged'],
    ['closed', 'closed'],
    ['weird', null]
  ])('%s -> %s', (s, want) => {
    expect(foldMrState(s)).toBe(want);
  });
});
