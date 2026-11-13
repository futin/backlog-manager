import { gitlabProjectId, parseGitRemote, remoteOnSite } from '../server/src/gitlab/remote.util';

const SITE = 'www.gitlab.timify.io';
const SCP = 'git@www.gitlab.timify.io:development/backend/microservice.git';
const SSH = 'ssh://git@www.gitlab.timify.io:2222/development/backend/microservice.git';
const HTTPS = 'https://www.gitlab.timify.io/development/dev-api-graphql-proxy.git';

describe('parseGitRemote', () => {
  it.each([
    [SCP, { host: SITE, port: null, scheme: 'scp', path: 'development/backend/microservice' }],
    [SSH, { host: SITE, port: 2222, scheme: 'ssh', path: 'development/backend/microservice' }],
    [HTTPS, { host: SITE, port: null, scheme: 'https', path: 'development/dev-api-graphql-proxy' }],
    ['https://oauth2:glpat-abc@www.gitlab.timify.io/ns/repo.git', { host: SITE, port: null, scheme: 'https', path: 'ns/repo' }],
    ['https://WWW.GitLab.Timify.io:443/NS/Repo/', { host: SITE, port: 443, scheme: 'https', path: 'NS/Repo' }]
  ])('parses %s', (input, expected) => {
    expect(parseGitRemote(input)).toEqual(expected);
  });

  it('never carries userinfo into the result', () => {
    const json = JSON.stringify(parseGitRemote('https://oauth2:glpat-abc@www.gitlab.timify.io/ns/repo.git'));
    expect(json).not.toContain('oauth2');
    expect(json).not.toContain('glpat-abc');
  });

  it.each(['', 'not a url', 'https://host-only.example', '/local/path/repo.git'])('reads %j as null', (input) => {
    expect(parseGitRemote(input)).toBeNull();
  });
});

describe('remoteOnSite', () => {
  it.each([SCP, SSH, HTTPS, 'https://www.gitlab.timify.io:443/ns/r'])('is true for %s', (input) => {
    expect(remoteOnSite(parseGitRemote(input)!, SITE)).toBe(true);
  });

  it.each([
    'https://www.gitlab.timify.io:8443/ns/r',
    'git@gitlab.timify.io:ns/r.git',
    'git@github.com:o/r.git',
    'http://www.gitlab.timify.io/ns/r.git'
  ])('is false for %s', (input) => {
    expect(remoteOnSite(parseGitRemote(input)!, SITE)).toBe(false);
  });
});

describe('gitlabProjectId', () => {
  it('url-encodes the namespace path', () => {
    expect(gitlabProjectId('development/backend/microservice')).toBe('development%2Fbackend%2Fmicroservice');
  });
});
