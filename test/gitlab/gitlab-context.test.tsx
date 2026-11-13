/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import { GitlabProvider, useGitlabContext } from '../../client/src/hooks/GitlabContext';
import type { GitlabPayload } from '../../shared/types';

/**
 * The shell's GitLab reader: a 200 reaches a consumer, a failed read leaves `data: null` and sets `error` WITHOUT taking down a sibling that reads something
 * else (spec Review Focus 4), and the context throws outside its provider so a bare render cannot pass for "GitLab is not configured".
 */
const PAYLOAD = {
  status: { configured: false, mappedRepos: 0, foundHosts: [], problems: [] },
  jiraProjects: {},
  mrs: []
} as unknown as GitlabPayload;

function Probe() {
  const { data, error } = useGitlabContext();
  return <p data-testid="probe">{`${data === null ? 'null' : 'data'}|${error ?? 'none'}`}</p>;
}

const tree = () => (
  <GitlabProvider>
    <Probe />
    <p>sibling content</p>
  </GitlabProvider>
);

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

it('hands a 200 payload to a consumer', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(PAYLOAD) } as Response)) as unknown as typeof fetch;
  render(tree());
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('data|none'));
});

it('a 500 leaves data null, sets error, and the sibling still renders', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) } as Response)) as unknown as typeof fetch;
  render(tree());
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('null|boom'));
  expect(screen.getByText('sibling content')).toBeInTheDocument();
});

it('a network error leaves data null, sets error, and the sibling still renders', async () => {
  global.fetch = jest.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
  render(tree());
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('null|network down'));
  expect(screen.getByText('sibling content')).toBeInTheDocument();
});

it('throws outside the provider', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => render(<Probe />)).toThrow('useGitlabContext must be used inside <GitlabProvider>');
  spy.mockRestore();
});

/**
 * An API one release older than the client (a rebuilt client against a stack not yet rebuilt, or the reverse mid-`docker:sync`) sends no `review` on an
 * MR and no `repos` on a project view. Every review reader types `review` as `GitlabReview | null`, and `reviewState` dereferences it, so a missing one must
 * land as `null`, or one MR chip throws and takes the whole Jira section with it (/ui-verify, 2026-11-13). `repos` lands as `[]`: no candidates, no button.
 */
it('normalises an MR without `review` to null and a project view without `repos` to []', async () => {
  const old = {
    status: { configured: true, mappedRepos: 1, foundHosts: [], problems: [] },
    jiraProjects: { PAY: [{ path: 'g/p', repo: 'p', polledAt: null, capped: false, failed: false }] },
    mrs: [{ iid: 1, state: 'opened', keys: ['PAY-1'] }]
  };
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(old) } as Response)) as unknown as typeof fetch;
  let seen: GitlabPayload | null = null;
  function Grab() {
    seen = useGitlabContext().data;
    return null;
  }
  render(
    <GitlabProvider>
      <Grab />
    </GitlabProvider>
  );
  await waitFor(() => expect(seen).not.toBeNull());
  const got = seen as unknown as GitlabPayload;
  expect(got.mrs[0].review).toBeNull();
  expect(got.jiraProjects.PAY[0].repos).toEqual([]);
});
