/**
 * @jest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { OrchestrateSheet } from '../client/src/components/board/OrchestrateSheet';
import { ReviewerGroup } from '../client/src/components/settings/ReviewerGroup';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { DEFAULT_REVIEW_CONFIG } from '../shared/agent';
import type { AgentsStatus, ReviewConfig, ReviewSetting } from '../shared/types';
import { homeOnly } from './helpers/offers';

/**
 * Reviewer coverage task 11 — the board side of the reviewer config (spec §7). Three surfaces:
 *  - Settings › Shared's `Reviewer` card, rendered bare: it reads and writes `/api/settings/review` through `useReviewSetting`, the TimeZoneGroup pattern.
 *  - The Orchestrate sheet's Reviewer section on its Modes step, seeded once from the same read; a launch carries `review` only when the pick differs.
 *  - The LaunchSheet's section under an execute PR finish is pinned in `test/launch-sheet.test.tsx`, beside every other finish case.
 */

const AGENTS_STATUS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: []
};

const HINT = 'review.json could not be read — showing defaults. Saving replaces it.';

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response);
}

/** `GET /api/settings/review` answers `get`; its POST answers `post(body)`, by default echoing the body, as the server does for a valid config. */
function stubFetch(opts: { get: ReviewSetting; post?: (body: ReviewConfig) => { status: number; body: unknown } }): jest.Mock {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/settings/review')) {
      if (init?.method === 'POST') {
        const answer = (opts.post ?? ((b) => ({ status: 200, body: b })))(JSON.parse(String(init.body ?? '{}')));
        return respond(answer.status, answer.body);
      }
      return respond(200, opts.get);
    }
    return respond(200, AGENTS_STATUS);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const posts = (fn: jest.Mock) =>
  fn.mock.calls.filter(([url, init]) => String(url).endsWith('/api/settings/review') && (init as RequestInit)?.method === 'POST');
const postedBody = (fn: jest.Mock, i = 0): unknown => JSON.parse(String((posts(fn)[i][1] as RequestInit).body));

const realFetch = global.fetch;

describe('ReviewerGroup', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  it('draws the default config: Big and small groups, a Sonnet small model, a 300-line limit, scoped to this machine', async () => {
    stubFetch({ get: DEFAULT_REVIEW_CONFIG });
    render(<ReviewerGroup />);

    const models = await screen.findByRole('group', { name: 'Models' });
    expect(within(models).getByRole('button', { name: 'Big and small groups' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(models).getByRole('button', { name: 'Same for all groups' })).toHaveAttribute('aria-pressed', 'false');
    const small = screen.getByRole('combobox', { name: 'Small groups — model' }) as HTMLSelectElement;
    expect(small.value).toBe('sonnet');
    expect(small.selectedOptions[0]).toHaveTextContent('Sonnet');
    expect(screen.getByRole('spinbutton', { name: 'Small group limit' })).toHaveValue(300);
    expect(screen.getByText('Groups with at most this many changed lines use the small pair. The first group always uses the big pair.')).toBeInTheDocument();
    for (const name of ['Big groups — model', 'Big groups — effort', 'Small groups — effort']) {
      expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
    // Spec §7's option words, in order — `''` is the unset member on both.
    expect([...(screen.getByRole('combobox', { name: 'Big groups — model' }) as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Agent default (Opus)',
      'Opus',
      'Sonnet',
      'Haiku',
      'Fable'
    ]);
    expect([...(screen.getByRole('combobox', { name: 'Big groups — effort' }) as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Default',
      'Low',
      'Medium',
      'High',
      'XHigh',
      'Max'
    ]);
    expect(document.querySelector('.ui-sheet-title')).toHaveTextContent('Reviewer');
    expect(document.querySelector('.ui-pill-neutral')).toHaveTextContent('this machine');
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('switching to Same for all groups shows only Model and Effort, and saves mode same with the split pairs kept', async () => {
    const fn = stubFetch({ get: DEFAULT_REVIEW_CONFIG });
    render(<ReviewerGroup />);

    await userEvent.click(await screen.findByRole('button', { name: 'Same for all groups' }));

    await waitFor(() => expect(posts(fn)).toHaveLength(1));
    expect(postedBody(fn)).toEqual({ ...DEFAULT_REVIEW_CONFIG, mode: 'same' });
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Effort' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Small groups — model' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Small group limit' })).toBeNull();
  });

  it('shows the exact hint when review.json could not be read', async () => {
    stubFetch({ get: { ...DEFAULT_REVIEW_CONFIG, fileError: true } });
    render(<ReviewerGroup />);
    expect(await screen.findByText(HINT)).toBeInTheDocument();
  });

  it('marks a 0 limit invalid and sends nothing, and saves a valid one on blur', async () => {
    const fn = stubFetch({ get: DEFAULT_REVIEW_CONFIG });
    render(<ReviewerGroup />);

    const limit = await screen.findByRole('spinbutton', { name: 'Small group limit' });
    await userEvent.clear(limit);
    await userEvent.type(limit, '0');
    await userEvent.tab();
    expect(limit).toHaveAttribute('aria-invalid', 'true');
    expect(posts(fn)).toHaveLength(0);

    await userEvent.clear(limit);
    await userEvent.type(limit, '450');
    await userEvent.tab();
    await waitFor(() => expect(posts(fn)).toHaveLength(1));
    expect(postedBody(fn)).toEqual({ ...DEFAULT_REVIEW_CONFIG, smallMaxLines: 450 });
    expect(limit).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('says a refused save was not saved, in the shared wording', async () => {
    stubFetch({ get: DEFAULT_REVIEW_CONFIG, post: () => ({ status: 400, body: { error: 'invalid review config: small.model' } }) });
    render(<ReviewerGroup />);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Small groups — model' }), 'haiku');
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved — invalid review config: small.model');
  });

  /**
   * The POSTs held open until the test releases them, so two edits can be made while the first is in flight and the answers settled in any order. Each
   * `pending` entry is one POST: its body, and `answer(status, body?)` — the body defaults to an echo, as the server answers a valid config.
   */
  function stubHeldPosts(get: ReviewSetting): { pending: { body: ReviewConfig; answer: (status?: number, body?: unknown) => void }[] } {
    const pending: { body: ReviewConfig; answer: (status?: number, body?: unknown) => void }[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/settings/review') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as ReviewConfig;
        return new Promise<Response>((resolve) => {
          pending.push({ body, answer: (status = 200, answer: unknown = body) => void respond(status, answer).then(resolve) });
        });
      }
      return respond(200, get);
    }) as jest.Mock;
    return { pending };
  }

  const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;

  it('builds a second edit made while the first save is in flight on the first, so its POST carries both changes', async () => {
    const { pending } = stubHeldPosts(DEFAULT_REVIEW_CONFIG);
    render(<ReviewerGroup />);

    const limit = await screen.findByRole('spinbutton', { name: 'Small group limit' });
    await userEvent.clear(limit);
    await userEvent.type(limit, '450');
    await userEvent.tab();
    await waitFor(() => expect(pending).toHaveLength(1));
    await userEvent.selectOptions(select('Big groups — model'), 'fable');
    await waitFor(() => expect(pending).toHaveLength(2));

    expect(pending[1].body).toEqual({ ...DEFAULT_REVIEW_CONFIG, big: { model: 'fable', effort: null }, smallMaxLines: 450 });
  });

  it('shows the newest save’s answer when an older one settles after it', async () => {
    const { pending } = stubHeldPosts(DEFAULT_REVIEW_CONFIG);
    render(<ReviewerGroup />);

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Small groups — model' }), 'haiku');
    await waitFor(() => expect(pending).toHaveLength(1));
    await userEvent.selectOptions(select('Big groups — effort'), 'max');
    await waitFor(() => expect(pending).toHaveLength(2));

    // The server's answers, not the posted bodies: what the card ends on must be the newest answer, whichever order they land in.
    const second: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG, big: { model: null, effort: 'max' }, small: { model: 'haiku', effort: null } };
    pending[1].answer(200, second);
    await waitFor(() => expect(select('Big groups — effort').value).toBe('max'));
    // Settled inside `act`, so whatever the stale answer would render has rendered before the assertions read the card.
    await act(async () => {
      pending[0].answer(200, { ...DEFAULT_REVIEW_CONFIG, small: { model: 'haiku', effort: null } });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(select('Big groups — effort').value).toBe('max');
    expect(select('Small groups — model').value).toBe('haiku');
  });

  it('puts the server’s value back on a refused save — the limit field included — and says so in the error row', async () => {
    const { pending } = stubHeldPosts(DEFAULT_REVIEW_CONFIG);
    render(<ReviewerGroup />);

    const limit = await screen.findByRole('spinbutton', { name: 'Small group limit' });
    await userEvent.clear(limit);
    await userEvent.type(limit, '450');
    await userEvent.tab();
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0].answer(400, { error: 'invalid review config: smallMaxLines' });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not saved — invalid review config: smallMaxLines. The value shown is the one still on the server.'
    );
    expect(limit).toHaveValue(300);
    expect(limit).not.toHaveAttribute('aria-invalid', 'true');

    // A select edit that is refused is shown at once and taken back on the answer, the same way.
    await userEvent.selectOptions(select('Small groups — model'), 'haiku');
    expect(select('Small groups — model').value).toBe('haiku');
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1].answer(400, { error: 'invalid review config: small.model' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not saved — invalid review config: small.model'));
    expect(select('Small groups — model').value).toBe('sonnet');
  });
});

describe('the Orchestrate sheet Reviewer section', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  /** Every on-open read the sheet makes answered quietly; the start POST and nothing else lands in `calls`. */
  function stubSheet(review: ReviewSetting): { url: string; body: Record<string, unknown> }[] {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/dashboards/offers')) return respond(200, homeOnly());
      if (url.includes('/api/agents/merge-check')) return respond(200, { covered: true, source: null });
      if (url.includes('/api/items/uncommitted')) return respond(200, { paths: [], absent: [], known: true });
      if (url.includes('/api/agents/branches')) return respond(200, { branches: ['main'] });
      if (url.endsWith('/api/settings/review')) return respond(200, review);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return respond(200, { sessionId: 'sess-1', runId: 'r-1' });
    }) as jest.Mock;
    return calls;
  }

  async function openModes(): Promise<HTMLElement> {
    render(
      <SettingsProvider>
        <OrchestrateSheet
          project="/abs/alpha"
          projectName="alpha"
          source="github"
          items={[]}
          spawnMaxPermission="acceptEdits"
          onClose={() => {}}
          refresh={() => {}}
        />
      </SettingsProvider>
    );
    await userEvent.click(screen.getByRole('button', { name: 'next' }));
    await userEvent.click(screen.getByRole('button', { name: 'next' }));
    return screen.findByRole('group', { name: 'Reviewer' });
  }

  async function start(calls: { url: string; body: Record<string, unknown> }[]): Promise<Record<string, unknown>> {
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/agents/orchestrate'))).toBe(true));
    return calls.find((c) => c.url.endsWith('/api/agents/orchestrate'))!.body;
  }

  it('seeds from the saved setting and sends no review when untouched', async () => {
    const calls = stubSheet(DEFAULT_REVIEW_CONFIG);
    const section = await openModes();
    expect((within(section).getByRole('combobox', { name: 'Small groups — model' }) as HTMLSelectElement).value).toBe('sonnet');
    const body = await start(calls);
    expect('review' in body).toBe(false);
  });

  it('sends the edited config as review once the small model changes', async () => {
    const calls = stubSheet(DEFAULT_REVIEW_CONFIG);
    const section = await openModes();
    await userEvent.selectOptions(within(section).getByRole('combobox', { name: 'Small groups — model' }), 'haiku');
    const body = await start(calls);
    expect(body.review).toEqual({ ...DEFAULT_REVIEW_CONFIG, small: { model: 'haiku', effort: null } });
  });
});
