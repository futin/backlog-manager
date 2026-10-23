/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { LaunchSheet } from '../client/src/components/board/LaunchSheet';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { daysAgoDate } from './helpers/dates';
import { homeOffer, homeOnly, proOffer, proSuggested } from './helpers/offers';
import { COMMIT_RULE, finishClause } from '../shared/agent';
import { NO_MACHINE_TEXT } from '../client/src/lib/dashboards';
import type { AgentPlan, BacklogItem, ProjectOffers } from '../shared/types';

const ITEM: BacklogItem = {
  id: 'task-12',
  title: 'Add CSP',
  created: daysAgoDate(2),
  started: '',
  tags: [],
  updated: '',
  lastCommit: '',
  phase: '',
  groomElapsed: 0,
  executeElapsed: 0,
  groomTokens: 0,
  executeTokens: 0,
  kind: '',
  section: 'tasks',
  status: 'open',
  project: 'alpha',
  projectPath: '/abs/alpha',
  groomed: true,
  path: '/abs/alpha/backlog/tasks/open/task-12.md',
  source: 'files',
  url: null,
  assignee: null,
  untyped: false
};

const PLAN: AgentPlan = {
  action: 'execute',
  prompt: 'Use the backlog-manager:backlog-execute skill on task-12.',
  project: 'alpha',
  allowedModes: ['plan', 'acceptEdits'],
  defaultMode: 'acceptEdits'
};

/**
 * `branches` is the list `GET /api/agents/branches` answers with, or `'reject'` for a network failure; absent, the route answers an empty list. `offers` is what
 * `GET /api/dashboards/offers` answers — home alone when absent, which is what every server without a remote configured says — or `'reject'` for a network
 * failure, or `'pending'` for an answer that never comes.
 */
function stub(handlers: {
  plan?: unknown;
  dispatch?: { ok: boolean; body: unknown };
  branches?: string[] | 'reject';
  offers?: ProjectOffers | 'reject' | 'pending';
}) {
  const calls: { url: string; body: unknown }[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/plan')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(handlers.plan ?? PLAN) } as Response);
    }
    if (url.includes('/api/dashboards/offers')) {
      if (handlers.offers === 'reject') return Promise.reject(new Error('NetworkError'));
      if (handlers.offers === 'pending') return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(handlers.offers ?? homeOnly()) } as Response);
    }
    if (url.includes('/api/agents/branches')) {
      if (handlers.branches === 'reject') return Promise.reject(new Error('NetworkError'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ branches: handlers.branches ?? [] }) } as Response);
    }
    const d = handlers.dispatch ?? { ok: true, body: { sessionId: 'sess-1' } };
    return Promise.resolve({ ok: d.ok, status: d.ok ? 200 : 409, json: () => Promise.resolve(d.body) } as Response);
  }) as jest.Mock;
  return calls;
}

const realFetch = global.fetch;

/** Two clicks that both land before React re-renders — `test/run-controls.test.tsx`'s `doubleClick`, for the same reason: `userEvent.click` awaits between
 *  clicks, so the second lands on a re-rendered (disabled) control and the case would pass with the guard deleted. Only a raw dispatch pair inside one `act`
 *  reaches `useAction`'s ref guard (#286). */
function doubleClick(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
});

// Same hazard test/agents-dispatch.test.ts guards against, and the same fix: a
// suite that leaves a mock on global.fetch hands it to whatever runs next in
// the same worker, where a case that forgot to stub passes on someone else's
// leftovers instead of failing loudly on a real network call.
afterEach(() => {
  global.fetch = realFetch;
});

// Correction over the brief's literal test: every case here mounts LaunchSheet
// inside SettingsProvider, the way test/settings-view.test.tsx already wraps
// SettingsView. Outside a provider, useSettings() falls back to DEFAULT_SETTINGS
// with a no-op update and never touches localStorage (see the last lines of
// client/src/hooks/useSettings.tsx) — so the "seed localStorage, then assert the
// built href" case below could never observe a seeded linkBase without this.
function renderSheet(props: { item: BacklogItem; onClose: () => void }) {
  render(
    <SettingsProvider>
      <LaunchSheet {...props} />
    </SettingsProvider>
  );
}

async function openSheet() {
  renderSheet({ item: ITEM, onClose: () => {} });
  await waitFor(() => expect(screen.getByRole('button', { name: 'launch' })).toBeEnabled());
}

describe('LaunchSheet', () => {
  it('shows the composed prompt, the project, and only the allowed modes', async () => {
    stub({});
    await openSheet();
    expect(screen.getByLabelText('Prompt')).toHaveValue(PLAN.prompt);
    expect(screen.getByText('alpha')).toBeInTheDocument();
    const modes = screen.getByLabelText('Permission mode') as HTMLSelectElement;
    expect([...modes.options].map((o) => o.value)).toEqual(['plan', 'acceptEdits']);
    expect(modes.value).toBe('acceptEdits');
  });

  // #285: `prompt` is state seeded from the `useFetched` plan once per fetched plan — a re-render of the parent must not re-seed it over an edit.
  it('keeps a typed prompt when the parent re-renders', async () => {
    stub({});
    const onClose = (): void => {};
    const { rerender } = render(
      <SettingsProvider>
        <LaunchSheet item={ITEM} onClose={onClose} />
      </SettingsProvider>
    );
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(PLAN.prompt));
    const prompt = screen.getByLabelText('Prompt');
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'my own words');

    rerender(
      <SettingsProvider>
        <LaunchSheet item={{ ...ITEM }} onClose={() => {}} />
      </SettingsProvider>
    );
    expect(screen.getByLabelText('Prompt')).toHaveValue('my own words');
  });

  it('dispatches the edited prompt with the derived action', async () => {
    const calls = stub({});
    await openSheet();
    const prompt = screen.getByLabelText('Prompt');
    await userEvent.clear(prompt);
    await userEvent.type(prompt, 'do it my way');
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/dispatch'))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('/dispatch'))?.body as Record<string, unknown>;
    expect(sent).toEqual({
      itemPath: ITEM.path,
      action: 'execute',
      prompt: 'do it my way',
      permissionMode: 'acceptEdits',
      // An execute launch always names its finish, even untouched — the server appends the closing clause from it.
      finish: 'in-place',
      remoteControl: true
    });
  });

  it('replaces the form with a link to the session once it launches', async () => {
    stub({});
    localStorage.setItem('backlog-manager.settings', JSON.stringify({ linkBase: 'http://dash:5174' }));
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));
    const link = await screen.findByRole('link', { name: /open in dashboard/ });
    expect(link).toHaveAttribute('href', 'http://dash:5174/?session=sess-1');
    expect(screen.queryByRole('button', { name: 'launch' })).not.toBeInTheDocument();
  });

  it('renders the server error verbatim and leaves the form usable', async () => {
    stub({ dispatch: { ok: false, body: { error: 'too many launches in flight' } } });
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));
    expect(await screen.findByText('too many launches in flight')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'launch' })).toBeEnabled();
  });

  // #286 — before useAction, `launch` had no ref guard: both clicks of one tick read `busy` as false and both POSTed.
  it('sends one dispatch for a double-click on launch', async () => {
    const calls = stub({});
    await openSheet();
    // The dispatch never answers, so the in-flight window stays open for the whole case and nothing settles after it ends.
    const answered = global.fetch as jest.Mock;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/plan') ? answered(input, init) : (calls.push({ url: String(input), body: undefined }), new Promise(() => {}))
    ) as jest.Mock;

    doubleClick(screen.getByRole('button', { name: 'launch' }));

    // The branch list and the machine offers the sheet reads on open are reads, not launches — only the dispatch POST may land twice here.
    expect(calls.filter((c) => !c.url.endsWith('/plan') && !c.url.includes('/api/agents/branches') && !c.url.includes('/api/dashboards/offers'))).toHaveLength(1);
  });

  it('offers no launch at all when the plan comes back blocked', async () => {
    stub({ plan: { ...PLAN, blocked: 'remote answers are off in the dashboard' } });
    renderSheet({ item: ITEM, onClose: () => {} });
    expect(await screen.findByText('remote answers are off in the dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'launch' })).not.toBeInTheDocument();
  });

  /* The other half of `blocked = plan?.blocked ?? planError`, and the half
     that produced the worse bug: a rejected plan fetch used to leave
     `planError` set forever, so every subsequent item rendered permanently
     blocked with the FIRST item's message. BoardView's `key` is what resets
     it; this case is what proves the state exists and is reachable at all,
     which nothing exercised before. */
  it('offers no launch when the plan fetch itself fails, and says why', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('NetworkError'))) as jest.Mock;
    renderSheet({ item: ITEM, onClose: () => {} });
    expect(await screen.findByText('NetworkError')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'launch' })).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    stub({});
    const onClose = jest.fn();
    renderSheet({ item: ITEM, onClose });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  /* The listener lives on `window`, so it outlives the component unless the
     effect's cleanup actually runs. This suite asserted "closes on Escape"
     and nothing more, which is a property a permanently-leaked listener also
     satisfies — and a leaked one keeps calling a closed sheet's onClose on
     every later Escape anywhere in the app. Unmounting and pressing again is
     the only assertion that tells the two apart.
     The board-level case in test/dispatch-button.test.tsx covers the
     complementary gap: Escape reaching this listener at all when focus is
     still on the button that opened the sheet. */
  it('removes its Escape listener when it unmounts', async () => {
    stub({});
    const onClose = jest.fn();
    const { unmount } = render(
      <SettingsProvider>
        <LaunchSheet item={ITEM} onClose={onClose} />
      </SettingsProvider>
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'launch' })).toBeEnabled());
    unmount();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
  /* Both pickers start on "default", which submits nothing: the CLI's own
     default is a real choice and the one a reader gets by not choosing. The
     sheet deliberately does not remember the last pick — a sticky "max" from
     last week silently spending on a trivial groom is the failure mode a
     per-launch control exists to avoid. */
  it('offers model and effort, both defaulting to no choice', async () => {
    stub({});
    await openSheet();
    const model = screen.getByLabelText('Model') as HTMLSelectElement;
    const effort = screen.getByLabelText('Effort') as HTMLSelectElement;
    expect(model.value).toBe('');
    expect(effort.value).toBe('');
    expect([...model.options].map((o) => o.textContent)).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable']);
    expect([...effort.options].map((o) => o.textContent)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('omits both fields from the dispatch when neither was picked', async () => {
    const calls = stub({});
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/dispatch'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/dispatch'))?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('effort');
  });

  it('preselects the stored defaults, and sends them without a pick', async () => {
    localStorage.setItem(
      'backlog-manager.settings',
      JSON.stringify({
        dispatchDefaultModel: 'sonnet',
        dispatchDefaultEffort: 'low'
      })
    );
    const calls = stub({});
    await openSheet();
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('sonnet');
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('low');
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/dispatch'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/dispatch'))?.body as Record<string, unknown>;
    expect(body.model).toBe('sonnet');
    expect(body.effort).toBe('low');
  });

  it('lets a per-launch pick override the stored default', async () => {
    localStorage.setItem(
      'backlog-manager.settings',
      JSON.stringify({
        dispatchDefaultModel: 'sonnet',
        dispatchDefaultEffort: 'low'
      })
    );
    const calls = stub({});
    await openSheet();
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'opus');
    // Back to the CLI default: the stored default must not creep back in.
    await userEvent.selectOptions(screen.getByLabelText('Effort'), '');
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/dispatch'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/dispatch'))?.body as Record<string, unknown>;
    expect(body.model).toBe('opus');
    expect(body).not.toHaveProperty('effort');
  });

  it('sends the picked model and effort', async () => {
    const calls = stub({});
    await openSheet();
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'haiku');
    await userEvent.selectOptions(screen.getByLabelText('Effort'), 'max');
    await userEvent.click(screen.getByRole('button', { name: 'launch' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/dispatch'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/dispatch'))?.body as Record<string, unknown>;
    expect(body.model).toBe('haiku');
    expect(body.effort).toBe('max');
  });
  /* The three launch controls sit on one row, the way the dashboard's own
     SpawnPanel groups them: they are one decision ("how should this run"),
     and stacked they pushed the launch button below the fold on a phone.
     Asserted on the shared parent rather than on any CSS value — the rule
     lives in styles.css, but the grouping is the part a later edit could undo
     without noticing. */
  it('groups permission mode, model and effort on one row', async () => {
    stub({});
    await openSheet();
    const row = screen.getByLabelText('Permission mode').closest('.sheet-row');
    expect(row).not.toBeNull();
    expect(row).toContainElement(screen.getByLabelText('Model'));
    expect(row).toContainElement(screen.getByLabelText('Effort'));
  });

  /*
   * The execute finish picker (spec §4). Finish seeds from Settings and is overridable for the one launch; Base exists only while Finish reads PR; the
   * clause line under the prompt is `finishClause` for the current picks — the same function the server appends with, so the sheet shows what will be sent.
   */
  describe('execute finish picker', () => {
    const dispatchBody = (calls: { url: string; body: unknown }[]): Record<string, unknown> =>
      calls.find((c) => c.url.endsWith('/dispatch'))?.body as Record<string, unknown>;
    const launchNow = async (calls: { url: string; body: unknown }[]): Promise<Record<string, unknown>> => {
      await userEvent.click(screen.getByRole('button', { name: 'launch' }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/dispatch'))).toBe(true));
      return dispatchBody(calls);
    };

    it('shows In place by default, with no Base select and the commit rule as the clause line, and sends finish with no base', async () => {
      const calls = stub({});
      await openSheet();
      const finish = screen.getByLabelText('Finish') as HTMLSelectElement;
      expect(finish.value).toBe('in-place');
      expect([...finish.options].map((o) => [o.value, o.textContent])).toEqual([
        ['in-place', 'In place'],
        ['pr', 'PR']
      ]);
      expect(screen.queryByLabelText('Base')).not.toBeInTheDocument();
      expect(screen.getByText(COMMIT_RULE)).toBeInTheDocument();
      const body = await launchNow(calls);
      expect(body.finish).toBe('in-place');
      expect(body).not.toHaveProperty('base');
    });

    it('seeds PR from Settings, offers the project branches, tracks the clause line, and sends finish and the picked base', async () => {
      localStorage.setItem('backlog-manager.settings', JSON.stringify({ executeDefaultFinish: 'pr' }));
      const calls = stub({ branches: ['main', 'develop'] });
      await openSheet();
      expect((screen.getByLabelText('Finish') as HTMLSelectElement).value).toBe('pr');
      const base = screen.getByLabelText('Base') as HTMLSelectElement;
      await waitFor(() => expect([...base.options].map((o) => o.value)).toEqual(['main', 'develop']));
      expect(base.value).toBe('main');
      expect(screen.getByText(finishClause('pr', 'main'))).toBeInTheDocument();
      expect(screen.queryByText(COMMIT_RULE)).not.toBeInTheDocument();
      expect(calls.some((c) => c.url.includes('/api/agents/branches?project=%2Fabs%2Falpha'))).toBe(true);

      await userEvent.selectOptions(base, 'develop');
      expect(screen.getByText(finishClause('pr', 'develop'))).toBeInTheDocument();
      expect(screen.queryByText(finishClause('pr', 'main'))).not.toBeInTheDocument();

      const body = await launchNow(calls);
      expect(body.finish).toBe('pr');
      expect(body.base).toBe('develop');
    });

    // Review Focus 4: a base picked under PR must not ride along once the person has gone back to In place.
    it('sends no base after PR, a base pick and a flip back to In place', async () => {
      const calls = stub({ branches: ['main', 'develop'] });
      await openSheet();
      await userEvent.selectOptions(screen.getByLabelText('Finish'), 'pr');
      const base = screen.getByLabelText('Base') as HTMLSelectElement;
      await waitFor(() => expect([...base.options].map((o) => o.value)).toEqual(['main', 'develop']));
      await userEvent.selectOptions(base, 'develop');
      await userEvent.selectOptions(screen.getByLabelText('Finish'), 'in-place');
      expect(screen.queryByLabelText('Base')).not.toBeInTheDocument();
      expect(screen.getByText(COMMIT_RULE)).toBeInTheDocument();
      const body = await launchNow(calls);
      expect(body.finish).toBe('in-place');
      expect(body).not.toHaveProperty('base');
    });

    // Review Focus 2: the list only offers alternatives to the default, so losing it must cost the alternatives and never the launch.
    it('offers only main when the branch list fails, and still launches onto it', async () => {
      localStorage.setItem('backlog-manager.settings', JSON.stringify({ executeDefaultFinish: 'pr' }));
      const calls = stub({ branches: 'reject' });
      await openSheet();
      const base = screen.getByLabelText('Base') as HTMLSelectElement;
      expect([...base.options].map((o) => o.value)).toEqual(['main']);
      const body = await launchNow(calls);
      expect(body.finish).toBe('pr');
      expect(body.base).toBe('main');
    });

    it('keeps a typed prompt when Finish flips, and fetches the plan once', async () => {
      const calls = stub({ branches: ['main'] });
      await openSheet();
      const prompt = screen.getByLabelText('Prompt');
      await userEvent.clear(prompt);
      await userEvent.type(prompt, 'my own words');
      await userEvent.selectOptions(screen.getByLabelText('Finish'), 'pr');
      await userEvent.selectOptions(screen.getByLabelText('Finish'), 'in-place');
      expect(screen.getByLabelText('Prompt')).toHaveValue('my own words');
      expect(calls.filter((c) => c.url.endsWith('/plan'))).toHaveLength(1);
    });

    it('draws no Finish, no clause line and no finish or base key for a groom launch', async () => {
      localStorage.setItem('backlog-manager.settings', JSON.stringify({ executeDefaultFinish: 'pr' }));
      const calls = stub({ plan: { ...PLAN, action: 'groom', prompt: 'Groom task-12.' } });
      await openSheet();
      expect(screen.queryByLabelText('Finish')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Base')).not.toBeInTheDocument();
      expect(screen.queryByText(COMMIT_RULE)).not.toBeInTheDocument();
      expect(screen.queryByText(finishClause('pr', 'main'))).not.toBeInTheDocument();
      const body = await launchNow(calls);
      expect(body.action).toBe('groom');
      expect(body).not.toHaveProperty('finish');
      expect(body).not.toHaveProperty('base');
      expect(calls.some((c) => c.url.includes('/api/agents/branches'))).toBe(false);
    });
  });

  /*
   * Multi-dashboard task 9 — the "Run on" group at the top of the sheet. Home-only offers draw nothing and send the request this sheet always sent
   * (Review Focus 1); a remote pick locks Finish to PR, narrows Model and Effort to that machine's lists and renames the button; switching back to home gives
   * Finish back as the person had it (Review Focus 5) and leaves a narrowed-away model on the Settings default.
   */
  describe('run on', () => {
    const dispatchCalls = (calls: { url: string; body: unknown }[]) => calls.filter((c) => c.url.endsWith('/dispatch'));
    const launchBody = async (calls: { url: string; body: unknown }[], name: string): Promise<Record<string, unknown>> => {
      await userEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(dispatchCalls(calls)).toHaveLength(1));
      return dispatchCalls(calls)[0].body as Record<string, unknown>;
    };
    const options = (label: string): string[] => [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((o) => o.value);

    it('draws no group for home-only offers, keeps the button text, and sends the request it always sent with no machine key', async () => {
      const calls = stub({ offers: homeOnly() });
      await openSheet();
      expect(screen.queryByRole('group', { name: 'Run on' })).not.toBeInTheDocument();
      expect(screen.queryByText('Run on')).not.toBeInTheDocument();
      expect(calls.filter((c) => c.url.includes('/api/dashboards/offers?project=%2Fabs%2Falpha'))).toHaveLength(1);
      const body = await launchBody(calls, 'launch');
      expect(body).toEqual({ itemPath: ITEM.path, action: 'execute', prompt: PLAN.prompt, permissionMode: 'acceptEdits', finish: 'in-place', remoteControl: true });
      expect(body).not.toHaveProperty('machine');
    });

    it('starts on the suggested machine, locked: Finish at PR with its hint, Model and Effort narrowed with no hint of their own, the button naming the machine', async () => {
      const calls = stub({ offers: proSuggested(), branches: ['main', 'develop'] });
      renderSheet({ item: ITEM, onClose: () => {} });
      const start = await screen.findByRole('button', { name: 'Start on Pro' });
      await waitFor(() => expect(start).toBeEnabled());
      expect(screen.queryByRole('button', { name: 'launch' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Pro\b/ })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: /^Home\b/ })).toHaveAttribute('aria-pressed', 'false');

      const finish = screen.getByLabelText('Finish') as HTMLSelectElement;
      expect(finish.value).toBe('pr');
      expect(finish).toBeDisabled();
      expect(screen.getByText('Required when running on Pro')).toBeInTheDocument();
      // '' first: the "default" option stays drawable on a remote (final-review I4), the machine's own list after it.
      expect(options('Model')).toEqual(['', 'opus', 'sonnet']);
      expect(screen.queryByText('Pro runs opus, sonnet')).not.toBeInTheDocument();
      expect(options('Effort')).toEqual(['', 'low', 'high']);
      expect(screen.queryByText('Pro runs low, high')).not.toBeInTheDocument();
      // The Base select shows exactly as it does for a PR finish today, and the clause line follows it.
      const base = screen.getByLabelText('Base') as HTMLSelectElement;
      await waitFor(() => expect([...base.options].map((o) => o.value)).toEqual(['main', 'develop']));
      await userEvent.selectOptions(base, 'develop');
      expect(screen.getByText(finishClause('pr', 'develop'))).toBeInTheDocument();

      const body = await launchBody(calls, 'Start on Pro');
      expect(body).toMatchObject({ machine: 'Pro', finish: 'pr', base: 'develop' });
    });

    it('sends a remote groom with the machine and no finish', async () => {
      const calls = stub({ offers: proSuggested(), plan: { ...PLAN, action: 'groom', prompt: 'Groom task-12.' } });
      renderSheet({ item: ITEM, onClose: () => {} });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start on Pro' })).toBeEnabled());
      expect(screen.queryByLabelText('Finish')).not.toBeInTheDocument();
      const body = await launchBody(calls, 'Start on Pro');
      expect(body.machine).toBe('Pro');
      expect(body).not.toHaveProperty('finish');
    });

    // Review Focus 5.
    it('gives Finish back and keeps the narrowed model on the Settings default when the person switches back to home', async () => {
      localStorage.setItem('backlog-manager.settings', JSON.stringify({ dispatchDefaultModel: 'opus' }));
      const calls = stub({ offers: proSuggested() });
      renderSheet({ item: ITEM, onClose: () => {} });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start on Pro' })).toBeEnabled());

      // The person's own picks are made on home, where Finish and model are theirs to set.
      await userEvent.click(screen.getByRole('button', { name: /^Home\b/ }));
      expect(screen.getByRole('button', { name: 'launch' })).toBeEnabled();
      await userEvent.selectOptions(screen.getByLabelText('Model'), 'haiku');
      expect((screen.getByLabelText('Finish') as HTMLSelectElement).value).toBe('in-place');

      await userEvent.click(screen.getByRole('button', { name: /^Pro\b/ }));
      expect((screen.getByLabelText('Finish') as HTMLSelectElement).value).toBe('pr');
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('opus');

      await userEvent.click(screen.getByRole('button', { name: /^Home\b/ }));
      const finish = screen.getByLabelText('Finish') as HTMLSelectElement;
      expect(finish.value).toBe('in-place');
      expect(finish).toBeEnabled();
      expect(screen.queryByText('Required when running on Pro')).not.toBeInTheDocument();
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('opus');
      expect(options('Model')).toContain('haiku');
      expect(screen.queryByText('Pro runs opus, sonnet')).not.toBeInTheDocument();

      const body = await launchBody(calls, 'launch');
      expect(body).toMatchObject({ finish: 'in-place', model: 'opus' });
      expect(body).not.toHaveProperty('machine');
      expect(body).not.toHaveProperty('base');
    });

    // Final-review I4: default Settings ('' for both) with a remote suggested. The default is never narrowed into the machine's first value — nobody
    // chose `low` — so neither key is sent, on Pro (the server fills the model) or after switching back to home.
    it('sends no model or effort on Pro with default Settings, and shows default on both selects', async () => {
      const calls = stub({ offers: proSuggested() });
      renderSheet({ item: ITEM, onClose: () => {} });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start on Pro' })).toBeEnabled());
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
      expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('');
      const body = await launchBody(calls, 'Start on Pro');
      expect(body.machine).toBe('Pro');
      expect(body).not.toHaveProperty('model');
      expect(body).not.toHaveProperty('effort');
    });

    it('sends no model or effort on home after the suggested Pro, with default Settings', async () => {
      const calls = stub({ offers: proSuggested() });
      renderSheet({ item: ITEM, onClose: () => {} });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start on Pro' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /^Home\b/ }));
      expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('');
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('');
      const body = await launchBody(calls, 'launch');
      expect(body).not.toHaveProperty('machine');
      expect(body).not.toHaveProperty('model');
      expect(body).not.toHaveProperty('effort');
    });

    it('falls to the first listed model and effort when the Settings default is not among them', async () => {
      localStorage.setItem('backlog-manager.settings', JSON.stringify({ dispatchDefaultModel: 'opus', dispatchDefaultEffort: 'max' }));
      const calls = stub({ offers: { ...proSuggested(), machines: [homeOffer(), proOffer({ models: ['sonnet', 'haiku'], efforts: ['medium'] })] } });
      renderSheet({ item: ITEM, onClose: () => {} });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start on Pro' })).toBeEnabled());
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('sonnet');
      expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('medium');
      const body = await launchBody(calls, 'Start on Pro');
      expect(body).toMatchObject({ model: 'sonnet', effort: 'medium' });
    });

    // Final-review I4: the state under a narrowed select is the Settings default, so home gets back `opus`/`max` — not Pro's first-listed sonnet/medium.
    it('restores the Settings default on home after a remote showed its first listed values', async () => {
      localStorage.setItem('backlog-manager.settings', JSON.stringify({ dispatchDefaultModel: 'opus', dispatchDefaultEffort: 'max' }));
      stub({ offers: { ...proSuggested(), machines: [homeOffer(), proOffer({ models: ['sonnet', 'haiku'], efforts: ['medium'] })] } });
      renderSheet({ item: ITEM, onClose: () => {} });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start on Pro' })).toBeEnabled());
      expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('medium');
      await userEvent.click(screen.getByRole('button', { name: /^Home\b/ }));
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('opus');
      expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('max');
    });

    it("shows the server's 409 in the error slot and stays open", async () => {
      const refusal = 'Pro is not offered for alpha: dashboard unreachable — connect ECONNREFUSED';
      stub({ offers: proSuggested(), dispatch: { ok: false, body: { error: refusal } } });
      const onClose = jest.fn();
      renderSheet({ item: ITEM, onClose });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start on Pro' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: 'Start on Pro' }));
      expect(await screen.findByText(refusal)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start on Pro' })).toBeEnabled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps launch disabled while the offers load', async () => {
      stub({ offers: 'pending' });
      renderSheet({ item: ITEM, onClose: () => {} });
      await screen.findByLabelText('Prompt');
      expect(screen.getByRole('button', { name: 'launch' })).toBeDisabled();
    });

    it('keeps launch disabled, and says why, when no machine is offered', async () => {
      stub({
        offers: {
          project: '/abs/alpha',
          machines: [homeOffer({ offered: false, reason: 'dashboard unreachable — down', usage: null }), proOffer({ offered: false, reason: 'sync is off for o/r on Pro', usage: null })],
          suggestion: null
        }
      });
      renderSheet({ item: ITEM, onClose: () => {} });
      await screen.findByText(NO_MACHINE_TEXT);
      expect(screen.getByRole('button', { name: 'launch' })).toBeDisabled();
    });

    it('runs here, and says so, when the machine list cannot be read', async () => {
      const calls = stub({ offers: 'reject' });
      await openSheet();
      expect(screen.getByText(/could not load the machine list/i)).toBeInTheDocument();
      const body = await launchBody(calls, 'launch');
      expect(body).not.toHaveProperty('machine');
    });
  });

  /*
   * #227: dispatch is offered over a stale hand claim, and the sheet says the new session takes it over — naming whose it was, on which machine, and how
   * long it has been silent. A live claim never reaches this form, and an untracked item has no claim to name.
   */
  it('names the stale claim a launch will take over, and says nothing for a fresh one', async () => {
    stub({});
    const beat = new Date(Date.now() - 42 * 60_000).toISOString();
    renderSheet({
      item: { ...ITEM, source: 'github', started: beat, phase: 'execute', holder: { session: 'b1c2d3e4-5f6a', host: 'aj_linux', heartbeat: beat } },
      onClose: () => {}
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'launch' })).toBeEnabled());
    expect(screen.getByText(/^takes over a stale claim — session b1c2d3e4 on aj_linux, no heartbeat 4\dm$/)).toBeInTheDocument();
  });

  it('draws no takeover note for an unclaimed item', async () => {
    stub({});
    await openSheet();
    expect(screen.queryByText(/takes over a stale claim/)).not.toBeInTheDocument();
  });
});
