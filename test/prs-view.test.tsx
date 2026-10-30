/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import PullRequestsView from '../client/src/components/github/PullRequestsView';
import { PR_LAYOUT_KEY } from '../client/src/lib/pr-layouts';
import { UPDATING_MS } from '../client/src/lib/prs';
import type { OrchestratorRun, PrRepoView, PullRequestRow, PullRequestsPayload, RunQueueItem } from '../shared/types';

/**
 * GitHub › PRs (source-sections spec, Goal 2 and "Left to the builder"; `.claude/DESIGN.md` §8.11). The page draws the server's PR cache grouped by repo and
 * offers the three writes. What it must never do: show a payload's order instead of `groupRepos`', send a method the repo does not allow, let a blocked
 * write be clicked, paraphrase the server's refusal, or forget an `updating…` mark it set.
 *
 * Every PR differs in every field a row draws (number, title, author, head, SHA, timestamp), so a row that drew a neighbour's value fails here. The board and
 * run hooks are stubbed — their own suites cover them; this page only reads them for the run-in-progress warning — and `fetch` answers `/api/prs` and the
 * three POSTs. The clock is fake and every date is relative to it.
 */

const mockBoard: { items: unknown[]; projects: unknown[] } = { items: [], projects: [] };
const mockRuns: { runs: OrchestratorRun[] } = { runs: [] };

jest.mock('../client/src/hooks/useBoard', () => ({
  useBoard: () => ({ items: { items: mockBoard.items, errors: [] }, projects: mockBoard.projects, loading: false, error: false, refetch: () => {} })
}));
jest.mock('../client/src/hooks/useOrchestratorRuns', () => ({
  useOrchestratorRuns: () => ({
    runs: mockRuns.runs,
    starting: [],
    remote: [],
    remoteStarting: [],
    refresh: () => Promise.resolve(),
    noteResume: () => {},
    resuming: null
  })
}));

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const SHA7 = '7'.repeat(40);
const SHA9 = '9'.repeat(40);
const SHA12 = 'c'.repeat(40);
const SYNC_OFF_Y = 'sync is off for futin/y — turn it on in GitHub › Settings';

function pr(over: Partial<PullRequestRow> & Pick<PullRequestRow, 'number'>): PullRequestRow {
  return {
    title: `title ${over.number}`,
    url: `https://github.com/futin/x/pull/${over.number}`,
    author: `author${over.number}`,
    draft: false,
    head: `feature/${over.number}`,
    headSha: 'f'.repeat(40),
    base: 'main',
    crossRepository: false,
    maintainerCanModify: true,
    updatedAt: ago(60_000),
    mergeable: 'mergeable',
    mergeState: 'clean',
    review: null,
    checks: 'success',
    autoMerge: null,
    canUpdateBranch: true,
    ...over
  };
}

const PR7 = pr({
  number: 7,
  title: 'Draft the importer',
  author: 'ana',
  head: 'feature/importer',
  headSha: SHA7,
  base: 'main',
  draft: true,
  updatedAt: ago(20 * 60_000)
});
const PR9 = pr({
  number: 9,
  title: 'Fix the fork',
  author: 'bo',
  head: 'patch-1',
  headSha: SHA9,
  base: 'develop',
  crossRepository: true,
  maintainerCanModify: false,
  updatedAt: ago(5 * 60_000)
});
const PR12 = pr({
  number: 12,
  title: 'Ship the queue',
  author: 'cy',
  head: 'backlog/12',
  headSha: SHA12,
  base: 'main',
  url: 'https://github.com/futin/y/pull/12',
  updatedAt: ago(60_000)
});

function repo(over: Partial<PrRepoView> & Pick<PrRepoView, 'repo'>): PrRepoView {
  return {
    polledAt: ago(12_000),
    access: 'ok',
    detail: null,
    syncOff: null,
    methods: ['squash', 'merge', 'rebase'],
    autoMergeAllowed: true,
    prs: [],
    total: 0,
    truncated: false,
    ...over
  };
}

/** `futin/x` arrives FIRST and oldest-PR-first: the page must reorder both. */
function basePayload(): PullRequestsPayload {
  return {
    token: true,
    repos: [
      repo({ repo: 'futin/x', polledAt: ago(12_000), methods: ['merge', 'rebase'], autoMergeAllowed: false, prs: [PR7, PR9], total: 2 }),
      repo({ repo: 'futin/y', polledAt: ago(40_000), prs: [PR12], total: 1 })
    ]
  };
}

let payload: PullRequestsPayload;
let reads: number;
let posts: { url: string; body: unknown }[];
let answerPost: (url: string, body: unknown) => { status: number; body: unknown };

/** A fresh copy per answer, as a real `json()` gives: a case that edits `payload` between reads must not edit the answer the page already holds. */
const respond = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(JSON.parse(JSON.stringify(body)) as unknown) } as Response);

/** The layout is a stored per-device choice (`PR_LAYOUT_KEY`); a case that asserts one layout's anatomy pins it before it renders. */
const storeLayout = (layout: 'inbox' | 'matrix' | 'cards'): void => localStorage.setItem(PR_LAYOUT_KEY, JSON.stringify(layout));

beforeEach(() => {
  localStorage.clear();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  payload = basePayload();
  reads = 0;
  posts = [];
  mockBoard.items = [];
  mockBoard.projects = [
    { name: 'x', path: '/p/x', repo: 'futin/x', source: 'github' },
    { name: 'y', path: '/p/y', repo: 'futin/y', source: 'github' }
  ];
  mockRuns.runs = [];
  answerPost = () => ({ status: 200, body: { ok: true, outcome: 'merged', pr: null, reread: true } });
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/prs' && init?.method !== 'POST') {
      reads += 1;
      return respond(200, payload);
    }
    const body: unknown = JSON.parse(String(init?.body));
    posts.push({ url, body });
    const res = answerPost(url, body);
    return respond(res.status, res.body);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

/** Microtask turns enough for a write's whole chain (POST, `.json()`, the re-read, its `.json()`, the page's in-flight release) to run to its end. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

/** Lets the fetches and their `.json()` settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await drain();
  });
}

/**
 * Clicks a control that starts a write and lets the write finish, all inside ONE act scope. `user.click` cannot do this: it leaves React's act environment as
 * it returns, with the write's last link (the page's in-flight release, after the re-read) still to run, so that state update lands bare and warns — and
 * wrapping `user.click` in `act` only trades that for "not configured to support act", because user-event switches the environment off while it runs. A plain
 * `fireEvent.click` is all a button needs here, and it keeps the click and the whole chain under one scope.
 */
async function clickAndSettle(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
    await drain();
  });
}

async function mount(props: { onOpenSettings?: () => void } = {}) {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  const view = render(<PullRequestsView {...props} />);
  await flush();
  return { user, ...view };
}

const row = (key: string): HTMLElement => screen.getByTestId(`pr-row-${key}`);
const action = (key: string, name: string | RegExp): HTMLElement => within(row(key)).getByRole('button', { name });
const keysIn = (root: ParentNode = document): string[] =>
  [...root.querySelectorAll('[data-testid^="pr-row-"]')].map((el) => el.getAttribute('data-testid') ?? '');

describe('PullRequestsView — grouping and the rows', () => {
  beforeEach(() => storeLayout('cards'));

  it('orders repos and PRs by groupRepos, not by the payload', async () => {
    await mount();
    const repos = [...document.querySelectorAll('[data-testid^="pr-repo-"]')].map((el) => el.getAttribute('data-testid'));
    expect(repos).toEqual(['pr-repo-futin/y', 'pr-repo-futin/x']);
    expect(keysIn()).toEqual(['pr-row-futin/y#12', 'pr-row-futin/x#9', 'pr-row-futin/x#7']);
  });

  it("draws each PR's own title, author, link and head → base on its own row", async () => {
    await mount();
    const r12 = row('futin/y#12');
    expect(r12).toHaveTextContent('Ship the queue');
    expect(r12).toHaveTextContent('cy');
    expect(r12).toHaveTextContent('backlog/12 → main');
    expect(within(r12).getByRole('link', { name: '#12' })).toHaveAttribute('href', 'https://github.com/futin/y/pull/12');
    expect(within(r12).getByRole('link', { name: '#12' })).toHaveAttribute('target', '_blank');
    const r9 = row('futin/x#9');
    expect(r9).toHaveTextContent('Fix the fork');
    expect(r9).toHaveTextContent('bo');
    expect(r9).toHaveTextContent('patch-1 → develop');
    expect(r9).not.toHaveTextContent('Ship the queue');
    const r7 = row('futin/x#7');
    expect(r7).toHaveTextContent('Draft the importer');
    expect(r7).toHaveTextContent('feature/importer → main');
    expect(within(r7).getByText('draft', { selector: '.ui-pill' })).toBeInTheDocument();
  });

  it("states each repo's own poll age", async () => {
    await mount();
    expect(screen.getByTestId('pr-repo-futin/x')).toHaveTextContent('polled 12 s ago');
    expect(screen.getByTestId('pr-repo-futin/y')).toHaveTextContent('polled 40 s ago');
  });

  it('says how many it left out when a repo is truncated', async () => {
    const many = Array.from({ length: 100 }, (_, i) => pr({ number: 1000 + i, headSha: String(i).padStart(40, '0'), updatedAt: ago(i * 1_000) }));
    payload.repos[0] = repo({ repo: 'futin/x', prs: many, total: 140, truncated: true });
    await mount();
    expect(screen.getByTestId('pr-repo-futin/x')).toHaveTextContent('showing 100 of 140');
    expect(screen.getByTestId('pr-repo-futin/y')).not.toHaveTextContent('showing');
  });

  it('draws no card for an ok repo that lists nothing', async () => {
    payload.repos.push(repo({ repo: 'futin/z', prs: [], total: 0 }));
    await mount();
    expect(screen.queryByTestId('pr-repo-futin/z')).toBeNull();
    expect(screen.getByTestId('pr-repo-futin/x')).toBeInTheDocument();
    expect(screen.getByTestId('pr-repo-futin/y')).toBeInTheDocument();
  });

  it('says no open pull requests once, and draws no card, when every repo lists nothing', async () => {
    payload = { ...basePayload(), repos: [repo({ repo: 'futin/x', prs: [], total: 0 }), repo({ repo: 'futin/y', prs: [], total: 0 })] };
    await mount();
    expect(screen.getAllByText('no open pull requests')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid^="pr-repo-"]')).toHaveLength(0);
  });

  it('shows the instruction and no repo when there is no token', async () => {
    payload = { token: false, repos: [] };
    await mount();
    expect(screen.getByText('no token — set BM_GITHUB_TOKEN in .env and restart')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid^="pr-repo-"]')).toHaveLength(0);
  });

  it("keeps a failed repo's card for its rows and says it could not read it once, under the cards", async () => {
    payload.repos[1] = { ...payload.repos[1], access: 'rate-limited', detail: 'rate limited — retrying at 12:30' };
    await mount();
    expect(screen.getByTestId('pr-repo-futin/y')).not.toHaveTextContent('rate limited');
    expect(screen.getByTestId('pr-cantread-futin/y')).toHaveTextContent("Can't read · futin/y — rate limited — retrying at 12:30");
    expect(screen.getByTestId('pr-repo-futin/x')).toBeInTheDocument();
  });

  it('draws only the line, and no card, for a failed repo that lists nothing', async () => {
    payload.repos[1] = { ...payload.repos[1], access: 'rate-limited', detail: 'rate limited — retrying at 12:30', prs: [], total: 0 };
    await mount();
    expect(screen.queryByTestId('pr-repo-futin/y')).toBeNull();
    expect(screen.getByTestId('pr-cantread-futin/y')).toBeInTheDocument();
    expect(screen.getByTestId('pr-repo-futin/x')).toBeInTheDocument();
  });

  it('keeps the card of a repo whose only PR departed, with the outcome and no empty reading', async () => {
    const { user } = await mount();
    payload = { ...basePayload(), repos: [basePayload().repos[0], repo({ repo: 'futin/y', prs: [], total: 0 })] };
    await user.click(action('futin/y#12', 'Merge'));
    await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
    const card = screen.getByTestId('pr-repo-futin/y');
    expect(card).toHaveTextContent('#12 merged');
    expect(card).not.toHaveTextContent('showing');
    expect(card).not.toHaveTextContent('no open pull requests');
  });

  it("draws no page-level truncated or departed line beside the cards' own (spec 249)", async () => {
    const { user } = await mount();
    payload = {
      ...basePayload(),
      repos: [repo({ repo: 'futin/x', prs: basePayload().repos[0].prs, total: 5, truncated: true }), repo({ repo: 'futin/y', prs: [], total: 0 })]
    };
    await user.click(action('futin/y#12', 'Merge'));
    await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
    expect(screen.getByTestId('pr-repo-futin/x')).toHaveTextContent('showing 2 of 5');
    expect(document.querySelectorAll('[data-testid^="pr-truncated-"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid^="pr-departed-"]')).toHaveLength(0);
  });
});

describe('PullRequestsView — merge', () => {
  beforeEach(() => storeLayout('cards'));

  it('asks before merging, with the method inside the Confirm, sends nothing on dismiss, and one POST on accept', async () => {
    const { user } = await mount();
    await user.click(action('futin/y#12', 'Merge'));
    const confirm = within(row('futin/y#12')).getByTestId('pr-merge-confirm');
    expect(confirm).toHaveTextContent('Merge #12 into main?');
    expect(within(confirm).getByRole('combobox', { name: 'Merge method' })).toHaveValue('squash');
    await user.click(within(confirm).getByTestId('pr-merge-confirm-dismiss'));
    expect(posts).toEqual([]);
    expect(screen.queryByTestId('pr-merge-confirm')).toBeNull();

    const before = reads;
    await user.click(action('futin/y#12', 'Merge'));
    await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
    expect(posts).toEqual([{ url: '/api/prs/merge', body: { repo: 'futin/y', number: 12, method: 'squash', headSha: SHA12 } }]);
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent('merged');
    expect(reads).toBe(before + 1);
  });

  it('closes the Confirm before the merge POST is answered', async () => {
    let release: (v: Response) => void = () => {};
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/prs' && init?.method !== 'POST') return respond(200, payload);
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
      return new Promise<Response>((r) => {
        release = r;
      });
    }) as unknown as typeof fetch;
    const { user } = await mount();
    await user.click(action('futin/y#12', 'Merge'));
    await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
    expect(posts).toHaveLength(1);
    expect(screen.queryByTestId('pr-merge-confirm')).toBeNull();
    await act(async () => {
      release({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, outcome: 'merged', pr: null, reread: true }) } as Response);
    });
    await flush();
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent('merged');
  });

  it('keeps the outcome on the page when the re-read no longer lists the PR', async () => {
    const { user } = await mount();
    payload = { ...basePayload(), repos: [basePayload().repos[0], repo({ repo: 'futin/y', prs: [], total: 0 })] };
    await user.click(action('futin/y#12', 'Merge'));
    await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
    expect(screen.queryByTestId('pr-row-futin/y#12')).toBeNull();
    expect(screen.getByTestId('pr-repo-futin/y')).toHaveTextContent('#12 merged');
  });

  it("clears a PR's outcome the moment its next write leaves", async () => {
    answerPost = () => ({ status: 409, body: { error: 'Head branch was modified. Review and try the merge again.' } });
    const { user } = await mount();
    await user.click(action('futin/y#12', 'Merge'));
    await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent('Head branch was modified');

    let release: (v: Response) => void = () => {};
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/prs' && init?.method !== 'POST') return respond(200, payload);
      return new Promise<Response>((r) => {
        release = r;
      });
    }) as unknown as typeof fetch;
    await user.click(action('futin/y#12', 'Auto-merge'));
    expect(within(row('futin/y#12')).queryByTestId('pr-outcome')).toBeNull();
    await act(async () => {
      release({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, outcome: 'auto-merge-enabled', pr: null, reread: true }) } as Response);
    });
    await flush();
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent('auto-merge armed');
  });

  it('keeps only the newest three departed lines on a repo', async () => {
    const prs = [12, 13, 14, 15].map((number) => ({ ...PR12, number }));
    payload.repos[1] = repo({ repo: 'futin/y', prs, total: prs.length });
    const { user } = await mount();
    for (const number of [12, 13, 14, 15]) {
      payload = { ...payload, repos: [payload.repos[0], repo({ repo: 'futin/y', prs: payload.repos[1].prs.filter((p) => p.number !== number) })] };
      await user.click(action(`futin/y#${number}`, 'Merge'));
      await clickAndSettle(within(row(`futin/y#${number}`)).getByTestId('pr-merge-confirm-accept'));
    }
    const card = screen.getByTestId('pr-repo-futin/y');
    expect(card).not.toHaveTextContent('#12 merged');
    for (const number of [13, 14, 15]) expect(card).toHaveTextContent(`#${number} merged`);
  });

  it("offers only the repo's methods, defaults to the first allowed, and sends the one picked", async () => {
    payload.repos[0].prs = [PR7, { ...PR9, crossRepository: false }];
    const { user } = await mount();
    await user.click(action('futin/x#9', 'Merge'));
    const confirm = within(row('futin/x#9')).getByTestId('pr-merge-confirm');
    const select = within(confirm).getByRole('combobox', { name: 'Merge method' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['merge', 'rebase']);
    expect(select.value).toBe('merge');
    await user.selectOptions(select, 'rebase');
    expect(confirm).toHaveTextContent('Merge #9 into develop?');
    await clickAndSettle(within(row('futin/x#9')).getByTestId('pr-merge-confirm-accept'));
    expect(posts.map((p) => p.body)).toEqual([{ repo: 'futin/x', number: 9, method: 'rebase', headSha: SHA9 }]);
  });

  it("shows a 409 refusal's text verbatim, and re-reads", async () => {
    answerPost = () => ({ status: 409, body: { error: 'Head branch was modified. Review and try the merge again.' } });
    const { user } = await mount();
    const before = reads;
    await user.click(action('futin/y#12', 'Merge'));
    await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent(/^Head branch was modified\. Review and try the merge again\.$/);
    expect(screen.queryByTestId('pr-merge-confirm')).toBeNull();
    expect(reads).toBe(before + 1);
  });

  it("shows a 502 permission answer's text", async () => {
    answerPost = () => ({ status: 502, body: { error: 'the token lacks permission for this — Resource not accessible by integration' } });
    const { user } = await mount();
    await user.click(action('futin/y#12', 'Merge'));
    await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent(
      'the token lacks permission for this — Resource not accessible by integration'
    );
  });
});

describe('PullRequestsView — blocked actions', () => {
  beforeEach(() => storeLayout('cards'));

  it('sync-off repo disables all three actions', async () => {
    payload.repos[1] = { ...payload.repos[1], syncOff: SYNC_OFF_Y };
    payload.repos[0] = { ...payload.repos[0], autoMergeAllowed: true };
    await mount();
    for (const name of ['Merge', 'Auto-merge', 'Update']) {
      const key = action('futin/y#12', name);
      expect(key).toHaveAttribute('aria-disabled', 'true');
      expect(key).toHaveAccessibleDescription('sync off');
    }
    const heading = screen.getByTestId('pr-head-futin/y');
    expect(within(heading).getByText('sync off')).toBeInTheDocument();
    expect(heading.textContent?.split(SYNC_OFF_Y).length).toBe(2);
    expect(action('futin/x#9', 'Merge')).not.toHaveAttribute('aria-disabled');
    expect(action('futin/x#9', 'Auto-merge')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('pr-repo-futin/x')).not.toHaveTextContent('sync off');
  });

  it("puts a PR's own reason on the key and a repo's reason on the why-line", async () => {
    payload.repos[1].prs = [{ ...PR12, checks: 'failure' }];
    await mount();
    const merge = action('futin/y#12', 'Merge');
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    expect(merge).toHaveAttribute('title', 'checks failing');
    expect(merge).toHaveAccessibleDescription('checks failing');
    expect(within(row('futin/y#12')).queryByText('checks failing', { selector: '.prs-why' })).toBeNull();
    expect(action('futin/x#7', 'Merge')).toHaveAccessibleDescription('draft');
    expect(action('futin/x#9', 'Update')).toHaveAccessibleDescription('fork does not allow edits');
    const auto = action('futin/x#9', 'Auto-merge');
    expect(auto).toHaveAttribute('aria-disabled', 'true');
    expect(auto).toHaveAccessibleDescription('auto-merge not enabled on the repo');
    expect(within(row('futin/x#9')).getByText(/auto-merge not enabled on the repo/, { selector: '.prs-why' })).toBeVisible();
    expect(action('futin/y#12', 'Update')).not.toHaveAttribute('aria-disabled');
  });

  it('disables every action of a row while its write is in flight', async () => {
    let release: (v: Response) => void = () => {};
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/prs' && init?.method !== 'POST') return respond(200, payload);
      return new Promise<Response>((r) => {
        release = r;
      });
    }) as unknown as typeof fetch;
    const { user } = await mount();
    await user.click(action('futin/y#12', 'Update'));
    expect(action('futin/y#12', 'Merge')).toBeDisabled();
    expect(action('futin/y#12', 'Auto-merge')).toBeDisabled();
    expect(action('futin/y#12', 'Update')).toBeDisabled();
    expect(action('futin/x#9', 'Merge')).toBeEnabled();
    await act(async () => {
      release({ ok: true, status: 202, json: () => Promise.resolve({ ok: true, outcome: 'update-requested', pr: null, reread: false }) } as Response);
    });
    await flush();
    expect(action('futin/y#12', 'Merge')).toBeEnabled();
  });
});

describe('PullRequestsView — auto-merge and update branch', () => {
  beforeEach(() => storeLayout('cards'));

  it('arms auto-merge with the picked method', async () => {
    answerPost = () => ({ status: 200, body: { ok: true, outcome: 'auto-merge-enabled', pr: null, reread: true } });
    const { user } = await mount();
    await clickAndSettle(action('futin/y#12', 'Auto-merge'));
    expect(posts).toEqual([{ url: '/api/prs/auto-merge', body: { repo: 'futin/y', number: 12, enable: true, method: 'squash' } }]);
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent('auto-merge armed');
  });

  it('reads Auto-merge ✓ on an armed PR, and a click sends enable: false', async () => {
    payload.repos[1].prs = [{ ...PR12, autoMerge: { method: 'merge', enabledAt: ago(3_600_000) } }];
    answerPost = () => ({ status: 200, body: { ok: true, outcome: 'auto-merge-disabled', pr: null, reread: true } });
    await mount();
    expect(within(row('futin/y#12')).getByText('auto-merge · merge')).toBeInTheDocument();
    const auto = action('futin/y#12', 'Auto-merge');
    expect(auto).toHaveTextContent('Auto-merge ✓');
    expect(auto).toHaveAttribute('aria-pressed', 'true');
    await clickAndSettle(auto);
    expect(posts.map((p) => p.body)).toEqual([{ repo: 'futin/y', number: 12, enable: false }]);
  });

  it('says branch updated once a re-read brings a new head SHA, and still says it 30 s and a read later', async () => {
    answerPost = () => ({ status: 202, body: { ok: true, outcome: 'update-requested', pr: null, reread: false } });
    await mount();
    await clickAndSettle(action('futin/y#12', 'Update'));
    expect(posts).toEqual([{ url: '/api/prs/update-branch', body: { repo: 'futin/y', number: 12, headSha: SHA12 } }]);
    expect(row('futin/y#12')).toHaveTextContent('updating…');

    payload.repos[1].prs = [{ ...PR12, headSha: 'd'.repeat(40) }];
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(row('futin/y#12')).not.toHaveTextContent('updating…');
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent('branch updated');

    const before = reads;
    await act(async () => {
      jest.advanceTimersByTime(UPDATING_MS);
    });
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(reads).toBeGreaterThan(before);
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent('branch updated');
  });

  it("says branch updated when the timer's own re-read brings the new head, and frees Update only once that re-read is in", async () => {
    answerPost = () => ({ status: 202, body: { ok: true, outcome: 'update-requested', pr: null, reread: false } });
    await mount();
    await clickAndSettle(action('futin/y#12', 'Update'));
    expect(action('futin/y#12', 'Update')).toHaveAttribute('aria-disabled', 'true');

    let release: (v: Response) => void = () => {};
    const ok = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/prs' && init?.method !== 'POST') {
        reads += 1;
        return new Promise<Response>((r) => {
          release = r;
        });
      }
      return (ok as jest.Mock)(input, init) as Promise<Response>;
    }) as unknown as typeof fetch;
    const before = reads;
    await act(async () => {
      jest.advanceTimersByTime(UPDATING_MS);
    });
    await flush();
    expect(reads).toBe(before + 1);
    expect(action('futin/y#12', 'Update')).toHaveAttribute('aria-disabled', 'true');

    payload.repos[1].prs = [{ ...PR12, headSha: 'd'.repeat(40) }];
    const answer = JSON.parse(JSON.stringify(payload)) as unknown;
    await act(async () => {
      release({ ok: true, status: 200, json: () => Promise.resolve(answer) } as Response);
      await drain();
    });
    await flush();
    expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent('branch updated');
    expect(row('futin/y#12')).not.toHaveTextContent('updating…');
    expect(action('futin/y#12', 'Update')).not.toHaveAttribute('aria-disabled');
  });

  it("drops the mark and clears updating… when the timer's re-read rejects", async () => {
    answerPost = () => ({ status: 202, body: { ok: true, outcome: 'update-requested', pr: null, reread: false } });
    await mount();
    await clickAndSettle(action('futin/y#12', 'Update'));
    expect(row('futin/y#12')).toHaveTextContent('updating…');
    const ok = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/prs' && init?.method !== 'POST') return Promise.reject(new Error('network down'));
      return (ok as jest.Mock)(input, init) as Promise<Response>;
    }) as unknown as typeof fetch;
    await act(async () => {
      jest.advanceTimersByTime(UPDATING_MS);
    });
    await flush();
    expect(row('futin/y#12')).not.toHaveTextContent('updating…');
    expect(action('futin/y#12', 'Update')).not.toHaveAttribute('aria-disabled');
  });

  it("sends nothing and logs nothing when the page unmounts while the timer's re-read is pending (Review Focus 1)", async () => {
    answerPost = () => ({ status: 202, body: { ok: true, outcome: 'update-requested', pr: null, reread: false } });
    const { unmount } = await mount();
    await clickAndSettle(action('futin/y#12', 'Update'));
    let release: (v: Response) => void = () => {};
    let gone = false;
    let sentAfter = 0;
    const ok = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (gone) sentAfter += 1;
      if (String(input) === '/api/prs' && init?.method !== 'POST') {
        reads += 1;
        return new Promise<Response>((r) => {
          release = r;
        });
      }
      return (ok as jest.Mock)(input, init) as Promise<Response>;
    }) as unknown as typeof fetch;
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const before = reads;
      await act(async () => {
        jest.advanceTimersByTime(UPDATING_MS);
      });
      await flush();
      expect(reads).toBe(before + 1);

      unmount();
      gone = true;
      payload.repos[1].prs = [{ ...PR12, headSha: 'd'.repeat(40) }];
      const answer = JSON.parse(JSON.stringify(payload)) as unknown;
      await act(async () => {
        release({ ok: true, status: 200, json: () => Promise.resolve(answer) } as Response);
        await drain();
      });
      await act(async () => {
        jest.advanceTimersByTime(UPDATING_MS * 2);
        await drain();
      });
      expect(sentAfter).toBe(0);
      expect(reads).toBe(before + 1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('clears updating… after 30 s on the same SHA, with one extra read at that moment', async () => {
    answerPost = () => ({ status: 202, body: { ok: true, outcome: 'update-requested', pr: null, reread: false } });
    const { user } = await mount();
    await clickAndSettle(action('futin/y#12', 'Update'));
    expect(row('futin/y#12')).toHaveTextContent('updating…');
    const before = reads;

    await act(async () => {
      jest.advanceTimersByTime(UPDATING_MS - 1_000);
    });
    await flush();
    expect(row('futin/y#12')).toHaveTextContent('updating…');
    expect(reads).toBe(before);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    await flush();
    expect(row('futin/y#12')).not.toHaveTextContent('updating…');
    expect(reads).toBe(before + 1);
  });
});

describe('PullRequestsView — run-in-progress warning', () => {
  beforeEach(() => storeLayout('cards'));

  it('warns on the PR whose branch a live run holds, and leaves its actions enabled', async () => {
    mockRuns.runs = [
      {
        runId: 'r1',
        project: '/p/y',
        status: 'running',
        base: 'main',
        queue: [{ id: '12', title: 'item 12', stage: 'pending' } as RunQueueItem],
        updatedAt: ago(5_000)
      } as OrchestratorRun
    ];
    await mount();
    expect(within(row('futin/y#12')).getByText('run in progress on this machine')).toBeInTheDocument();
    expect(row('futin/x#9')).not.toHaveTextContent('run in progress');
    expect(row('futin/x#7')).not.toHaveTextContent('run in progress');
    expect(action('futin/y#12', 'Merge')).toBeEnabled();
    expect(action('futin/y#12', 'Update')).toBeEnabled();
  });
});

/* ---------------------------------------------------------------------------------------------------------------------------------------------------------
   The layout switcher and the no-access repos (spec `2026-10-29-prs-layouts-design.md`, "The page"). The cases above pin Cards; these say which layout is
   drawn, what the toolbar reads, which repos never reach a layout, and that a write belongs to the page and not to the layout that started it.
   ------------------------------------------------------------------------------------------------------------------------------------------------------- */

const switcher = (): HTMLElement => screen.getByRole('group', { name: 'Layout' });
const stored = (): unknown => JSON.parse(localStorage.getItem(PR_LAYOUT_KEY) ?? 'null');
const FORBIDDEN_Z = repo({
  repo: 'futin/z',
  access: 'forbidden',
  detail: 'the token cannot read futin/z',
  polledAt: ago(5_000),
  prs: [pr({ number: 31, title: 'Hidden by reach' })],
  total: 4
});

/** Answers `window.matchMedia` as a phone, for the one case that pins Matrix at every width. */
function stubNarrow(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })
  });
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

describe('PullRequestsView — the layout switcher', () => {
  it('draws Inbox by default, with the three layouts on offer', async () => {
    await mount();
    expect(screen.getByTestId('pr-inbox')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-matrix')).toBeNull();
    expect(document.querySelectorAll('[data-testid^="pr-repo-"]')).toHaveLength(0);
    expect(
      within(switcher())
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Inbox', 'Matrix', 'Cards']);
    expect(within(switcher()).getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('stores the choice, and a fresh render draws it', async () => {
    const { user, unmount } = await mount();
    await user.click(within(switcher()).getByRole('button', { name: 'Matrix' }));
    expect(stored()).toBe('matrix');
    expect(screen.getByTestId('pr-matrix')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-inbox')).toBeNull();
    unmount();

    await mount();
    expect(screen.getByTestId('pr-matrix')).toBeInTheDocument();
    expect(within(switcher()).getByRole('button', { name: 'Matrix' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('draws a stored Matrix on a narrow window too, with the three layouts on offer', async () => {
    storeLayout('matrix');
    stubNarrow();
    await mount();
    expect(screen.getByTestId('pr-matrix')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-inbox')).toBeNull();
    expect(
      within(switcher())
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Inbox', 'Matrix', 'Cards']);
    expect(within(switcher()).getByRole('button', { name: 'Matrix' })).toHaveAttribute('aria-pressed', 'true');
    expect(stored()).toBe('matrix');
  });

  it('reads an unknown stored word as Inbox', async () => {
    localStorage.setItem(PR_LAYOUT_KEY, JSON.stringify('wall'));
    await mount();
    expect(screen.getByTestId('pr-inbox')).toBeInTheDocument();
  });

  it("states the toolbar's polled age from the newest shown repo", async () => {
    await mount();
    expect(screen.getByTestId('pr-toolbar')).toHaveTextContent('polled 12 s ago');
  });
});

describe('PullRequestsView — repos the token cannot read', () => {
  it.each(['inbox', 'matrix', 'cards'] as const)('keeps a no-access repo out of %s, out of N open, and says so in the toolbar', async (layout) => {
    storeLayout(layout);
    payload.repos.push(FORBIDDEN_Z);
    const onOpenSettings = jest.fn();
    const { user } = await mount({ onOpenSettings });
    expect(document.body).not.toHaveTextContent('futin/z');
    expect(document.body).not.toHaveTextContent('Hidden by reach');
    expect(screen.getByText('3 open')).toBeInTheDocument();
    const toolbar = screen.getByTestId('pr-toolbar');
    expect(toolbar).toHaveTextContent('1 repo hidden — no access');
    expect(toolbar).not.toHaveTextContent('polled 5 s ago');
    await user.click(within(toolbar).getByRole('button', { name: /GitHub › Settings/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('counts hidden repos in the plural, and treats not-found like forbidden', async () => {
    payload.repos.push(FORBIDDEN_Z, repo({ repo: 'futin/gone', access: 'not-found', detail: 'no such repo' }));
    await mount();
    expect(screen.getByTestId('pr-toolbar')).toHaveTextContent('2 repos hidden — no access');
  });

  it("keeps a rate-limited repo shown, and says it can't read it", async () => {
    storeLayout('cards');
    payload.repos[1] = { ...payload.repos[1], access: 'rate-limited', detail: 'rate limited — retrying at 12:30' };
    await mount();
    expect(screen.getByTestId('pr-repo-futin/y')).toBeInTheDocument();
    expect(screen.getByTestId('pr-cantread-futin/y')).toHaveTextContent('rate limited — retrying at 12:30');
    expect(screen.getByTestId('pr-toolbar')).not.toHaveTextContent('hidden');
  });

  it('brings a hidden repo back on the next read that says ok, and drops the note', async () => {
    payload.repos.push(FORBIDDEN_Z);
    await mount();
    expect(screen.getByTestId('pr-toolbar')).toHaveTextContent('1 repo hidden');
    expect(document.body).not.toHaveTextContent('Hidden by reach');

    payload.repos[2] = { ...FORBIDDEN_Z, access: 'ok', detail: null };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(screen.getByTestId('pr-toolbar')).not.toHaveTextContent('hidden');
    expect(document.body).toHaveTextContent('Hidden by reach');
    expect(screen.getByText('7 open')).toBeInTheDocument();
  });

  it('says no repo this token can read when every repo is hidden, and still offers the way to Settings', async () => {
    payload.repos = [FORBIDDEN_Z, repo({ repo: 'futin/gone', access: 'not-found' })];
    await mount({ onOpenSettings: () => {} });
    expect(screen.getByText('no repo this token can read')).toBeInTheDocument();
    expect(screen.queryByText('no GitHub repo registered')).toBeNull();
    expect(screen.getByTestId('pr-toolbar')).toHaveTextContent('2 repos hidden — no access');
    expect(screen.getByText('0 open')).toBeInTheDocument();
  });

  it('says no GitHub repo registered when the payload has none', async () => {
    payload.repos = [];
    await mount();
    expect(screen.getByText('no GitHub repo registered')).toBeInTheDocument();
    expect(screen.queryByText('no repo this token can read')).toBeNull();
  });

  it('draws no toolbar for a server with no token', async () => {
    payload = { token: false, repos: [] };
    await mount();
    expect(screen.getByText('no token — set BM_GITHUB_TOKEN in .env and restart')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-toolbar')).toBeNull();
  });
});

describe('PullRequestsView — the Cards toolbar count', () => {
  const EMPTY_W = repo({ repo: 'futin/w', prs: [], total: 0 });
  /** The toolbar's own parts after the switcher, by class, in document order. */
  const parts = (): string[] => [...screen.getByTestId('pr-toolbar').children].map((el) => el.className).filter((c) => c.startsWith('prs-toolbar-'));

  it('counts one ok empty repo, after the hidden-repos note and before the age', async () => {
    storeLayout('cards');
    payload.repos.push(EMPTY_W, FORBIDDEN_Z);
    await mount({ onOpenSettings: () => {} });
    expect(parts()).toEqual(['prs-toolbar-note', 'prs-toolbar-note', 'prs-toolbar-age']);
    const notes = screen.getByTestId('pr-toolbar').querySelectorAll('.prs-toolbar-note');
    expect(notes[0]).toHaveTextContent('1 repo hidden — no access');
    expect(notes[1]).toHaveTextContent(/^1 repo with no open PRs$/);
  });

  it('counts two in the plural, in place of the hidden-repos note when there is none', async () => {
    storeLayout('cards');
    payload.repos.push(EMPTY_W, repo({ repo: 'futin/v', prs: [], total: 0 }));
    await mount();
    expect(parts()).toEqual(['prs-toolbar-note', 'prs-toolbar-age']);
    expect(screen.getByTestId('pr-toolbar')).toHaveTextContent('2 repos with no open PRs');
  });

  it.each(['inbox', 'matrix'] as const)('draws no count in %s', async (layout) => {
    storeLayout(layout);
    payload.repos.push(EMPTY_W);
    await mount();
    expect(screen.getByTestId('pr-toolbar')).not.toHaveTextContent('with no open PRs');
  });

  it('draws no count when every shown repo lists nothing', async () => {
    storeLayout('cards');
    payload = { ...basePayload(), repos: [repo({ repo: 'futin/x', prs: [], total: 0 }), EMPTY_W] };
    await mount();
    expect(screen.getByTestId('pr-toolbar')).not.toHaveTextContent('with no open PRs');
    expect(screen.getAllByText('no open pull requests')).toHaveLength(1);
  });

  it('does not count a repo not read yet', async () => {
    storeLayout('cards');
    payload.repos.push(repo({ repo: 'futin/w', polledAt: null, prs: [], total: 0 }));
    await mount();
    expect(screen.getByTestId('pr-toolbar')).not.toHaveTextContent('with no open PRs');
  });
});

describe('PullRequestsView — the page owns marks, outcomes and writes', () => {
  const switchTo = async (user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> => {
    await user.click(within(switcher()).getByRole('button', { name }));
  };

  it('keeps an updating… mark set in Cards when the layout changes', async () => {
    storeLayout('cards');
    answerPost = () => ({ status: 202, body: { ok: true, outcome: 'update-requested', pr: null, reread: false } });
    const { user } = await mount();
    await clickAndSettle(action('futin/y#12', 'Update'));
    expect(row('futin/y#12')).toHaveTextContent('updating…');

    await switchTo(user, 'Inbox');
    expect(row('futin/y#12')).toHaveTextContent('updating…');
    await switchTo(user, 'Matrix');
    expect(screen.getByTestId('pr-mrow-futin/y#12')).toHaveTextContent('updating…');
  });

  it('closes an open Confirm when the layout changes', async () => {
    storeLayout('cards');
    const { user } = await mount();
    await user.click(action('futin/y#12', 'Merge'));
    expect(screen.getByTestId('pr-merge-confirm')).toBeInTheDocument();
    await switchTo(user, 'Inbox');
    expect(screen.queryByTestId('pr-merge-confirm')).toBeNull();
    await switchTo(user, 'Cards');
    expect(screen.queryByTestId('pr-merge-confirm')).toBeNull();
    expect(posts).toEqual([]);
  });

  it('closes the Confirm when a re-read makes its PR unmergeable, and it stays closed once the PR recovers', async () => {
    storeLayout('cards');
    const { user } = await mount();
    await user.click(action('futin/y#12', 'Merge'));
    expect(screen.getByTestId('pr-merge-confirm')).toBeInTheDocument();
    payload.repos[1].prs = [{ ...PR12, checks: 'failure' }];
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(screen.queryByTestId('pr-merge-confirm')).toBeNull();
    payload.repos[1].prs = [PR12];
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(screen.queryByTestId('pr-merge-confirm')).toBeNull();
    expect(posts).toEqual([]);
  });

  it("closes the first PR's Confirm when Merge is pressed on a second", async () => {
    storeLayout('cards');
    const { user } = await mount();
    await user.click(action('futin/y#12', 'Merge'));
    await user.click(action('futin/x#9', 'Merge'));
    expect(screen.getAllByTestId('pr-merge-confirm')).toHaveLength(1);
    expect(within(row('futin/x#9')).getByTestId('pr-merge-confirm')).toBeInTheDocument();
  });

  type Layout = 'cards' | 'inbox' | 'matrix';
  type Kind = 'merge' | 'auto-merge' | 'update';

  /** Opens whatever holds the strip for futin/y#12 in this layout and runs one write through it, by clicks alone. */
  async function runWrite(user: ReturnType<typeof userEvent.setup>, layout: Layout, kind: Kind): Promise<void> {
    let strip: HTMLElement;
    if (layout === 'matrix') {
      await user.click(screen.getByTestId('pr-mrow-futin/y#12'));
      strip = screen.getByTestId('pr-expand-futin/y#12');
    } else strip = row('futin/y#12');
    if (kind === 'update') await clickAndSettle(within(strip).getByRole('button', { name: 'Update' }));
    else if (kind === 'auto-merge') await clickAndSettle(within(strip).getByRole('button', { name: 'Auto-merge' }));
    else {
      await user.click(within(strip).getByRole('button', { name: 'Merge' }));
      await clickAndSettle(within(strip).getByTestId('pr-merge-confirm-accept'));
    }
  }

  const WRITES: Record<Kind, { url: string; body: unknown; answer: unknown; says: string }> = {
    merge: {
      url: '/api/prs/merge',
      body: { repo: 'futin/y', number: 12, method: 'squash', headSha: SHA12 },
      answer: { ok: true, outcome: 'merged', pr: null, reread: true },
      says: 'merged'
    },
    'auto-merge': {
      url: '/api/prs/auto-merge',
      body: { repo: 'futin/y', number: 12, enable: true, method: 'squash' },
      answer: { ok: true, outcome: 'auto-merge-enabled', pr: null, reread: true },
      says: 'auto-merge armed'
    },
    update: {
      url: '/api/prs/update-branch',
      body: { repo: 'futin/y', number: 12, headSha: SHA12 },
      answer: { ok: true, outcome: 'update-requested', pr: null, reread: false },
      says: 'updating…'
    }
  };

  const CASES = (['cards', 'inbox', 'matrix'] as const).flatMap((layout) =>
    (['merge', 'auto-merge', 'update'] as const).map((kind) => [layout, kind] as const)
  );

  it.each(CASES)('%s: %s sends the same POST and leaves the same outcome line', async (layout, kind) => {
    storeLayout(layout);
    const w = WRITES[kind];
    answerPost = () => ({ status: w.answer && kind === 'update' ? 202 : 200, body: w.answer });
    if (kind === 'update') payload.repos[1].prs = [{ ...PR12, mergeState: 'behind' }];
    const { user } = await mount();
    await runWrite(user, layout, kind);
    expect(posts).toEqual([{ url: w.url, body: w.body }]);
    if (layout === 'matrix' && kind === 'update') {
      // Matrix says `updating…` in the Base cell alone (spec `2026-10-30-prs-page-fixes-design.md`), never as an outcome line too.
      expect(screen.queryAllByTestId('pr-outcome')).toHaveLength(0);
      expect(screen.getByTestId('pr-mrow-futin/y#12')).toHaveTextContent('updating…');
      return;
    }
    const lines = screen.getAllByTestId('pr-outcome');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent(w.says);
  });

  it("keeps a PR's keys disabled in whatever layout is drawn while its write is still running", async () => {
    storeLayout('matrix');
    let release: (v: Response) => void = () => {};
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/prs' && init?.method !== 'POST') return respond(200, payload);
      return new Promise<Response>((r) => {
        release = r;
      });
    }) as unknown as typeof fetch;
    const { user } = await mount();

    await user.click(screen.getByTestId('pr-mrow-futin/y#12'));
    await user.click(within(screen.getByTestId('pr-expand-futin/y#12')).getByRole('button', { name: 'Update' }));

    // Cards: a full strip drawn after the write started — every key of that PR is still off, the neighbour's are not.
    await switchTo(user, 'Cards');
    for (const name of ['Merge', 'Auto-merge', 'Update']) expect(action('futin/y#12', name)).toBeDisabled();
    expect(action('futin/x#9', 'Merge')).toBeEnabled();

    // Inbox: a strip mounted fresh by the switch must not forget the write either.
    await switchTo(user, 'Inbox');
    for (const name of ['Merge', 'Auto-merge', 'Update']) expect(action('futin/y#12', name)).toBeDisabled();

    await act(async () => {
      release({ ok: true, status: 202, json: () => Promise.resolve({ ok: true, outcome: 'update-requested', pr: null, reread: false }) } as Response);
    });
    await flush();
    expect(action('futin/y#12', 'Merge')).toBeEnabled();
    expect(action('futin/y#12', 'Auto-merge')).toBeEnabled();
  });

  /** A write that ENDS badly must release its PR as surely as one that ends well, or its keys stay dead until a reload. */
  describe.each([
    {
      name: 'the POST answers 409',
      arrange: (): void => {
        answerPost = () => ({ status: 409, body: { error: 'Head branch was modified. Review and try the merge again.' } });
      },
      says: 'Head branch was modified. Review and try the merge again.'
    },
    {
      name: 'the /api/prs re-read rejects',
      arrange: (): void => {
        const ok = global.fetch;
        global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
          // The first read is the mount's; every later one is the write's re-read (or the poll), and it fails.
          if (String(input) === '/api/prs' && init?.method !== 'POST' && reads > 0) return Promise.reject(new Error('network down'));
          return (ok as jest.Mock)(input, init) as Promise<Response>;
        }) as unknown as typeof fetch;
      },
      says: 'merged'
    }
  ])('when $name', ({ arrange, says }) => {
    it.each(['inbox', 'matrix', 'cards'] as const)('enables the keys again in %s once the write has settled', async (layout) => {
      storeLayout('cards');
      const { user } = await mount();
      arrange();
      await clickAndSettle(action('futin/y#12', 'Merge'));
      await clickAndSettle(within(row('futin/y#12')).getByTestId('pr-merge-confirm-accept'));
      expect(posts).toHaveLength(1);
      expect(within(row('futin/y#12')).getByTestId('pr-outcome')).toHaveTextContent(says);

      // Cards is the layout the write started in, so it is reached by leaving and returning — the strip is a fresh mount either way.
      await switchTo(user, layout === 'matrix' ? 'Matrix' : 'Inbox');
      if (layout === 'cards') await switchTo(user, 'Cards');
      if (layout === 'matrix') await user.click(screen.getByTestId('pr-mrow-futin/y#12'));
      const strip = layout === 'matrix' ? screen.getByTestId('pr-expand-futin/y#12') : row('futin/y#12');
      for (const name of ['Merge', 'Auto-merge', 'Update']) expect(within(strip).getByRole('button', { name })).toBeEnabled();
    });
  });
});
