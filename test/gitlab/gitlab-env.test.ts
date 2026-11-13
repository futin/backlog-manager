import { gitlabEnv } from '../../server/src/gitlab/env.util';

const NOT_SET = { configured: false, malformedSite: false, detail: 'set BM_GITLAB_SITE and BM_GITLAB_TOKEN in .env and restart' };
const MALFORMED = { configured: false, malformedSite: true, detail: 'BM_GITLAB_SITE must be a hostname, like gitlab.example.com' };

describe('gitlabEnv', () => {
  it('reads an empty environment as not configured, site not malformed', () => {
    expect(gitlabEnv({})).toEqual(NOT_SET);
  });

  it.each([
    ['site only', { BM_GITLAB_SITE: 'www.gitlab.timify.io' }],
    ['token only', { BM_GITLAB_TOKEN: 'secret-tok' }],
    ['whitespace-only token', { BM_GITLAB_SITE: 'www.gitlab.timify.io', BM_GITLAB_TOKEN: '   ' }]
  ])('reads %s as not configured', (_name, env) => {
    expect(gitlabEnv(env)).toEqual(NOT_SET);
  });

  it('trims both values and lower-cases the site', () => {
    expect(gitlabEnv({ BM_GITLAB_SITE: ' WWW.GitLab.Timify.io ', BM_GITLAB_TOKEN: ' t0k ' })).toEqual({
      configured: true,
      site: 'www.gitlab.timify.io',
      token: 't0k'
    });
  });

  it.each(['https://www.gitlab.timify.io', 'www.gitlab.timify.io/x', 'www.gitlab.timify.io:443', 'gitlab'])('flags %s as a malformed site', (site) => {
    expect(gitlabEnv({ BM_GITLAB_SITE: site, BM_GITLAB_TOKEN: 'secret-tok' })).toEqual(MALFORMED);
  });

  it('never puts the token in a detail string', () => {
    const token = 'glpat-SECRETVALUE';
    const cases = [
      {},
      { BM_GITLAB_SITE: 'www.gitlab.timify.io' },
      { BM_GITLAB_TOKEN: token },
      { BM_GITLAB_SITE: 'https://x.io', BM_GITLAB_TOKEN: token },
      { BM_GITLAB_SITE: 'gitlab', BM_GITLAB_TOKEN: token }
    ];
    for (const env of cases) {
      const out = gitlabEnv(env);
      if (!out.configured) expect(out.detail).not.toContain(token);
    }
  });
});
