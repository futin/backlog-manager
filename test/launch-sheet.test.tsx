/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { LaunchSheet } from '../client/src/components/board/LaunchSheet';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import type { AgentPlan, BacklogItem } from '../shared/types';

const ITEM: BacklogItem = {
  id: 'task-12', title: 'Add CSP', created: '2026-08-20', started: '', tags: [],
  section: 'tasks', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
  groomed: true, path: '/abs/alpha/backlog/tasks/open/task-12.md'
};

const PLAN: AgentPlan = {
  action: 'execute',
  prompt: 'Use the backlog-manager:backlog-execute skill on task-12.',
  project: 'alpha',
  allowedModes: ['plan', 'acceptEdits'],
  defaultMode: 'acceptEdits'
};

function stub(handlers: { plan?: unknown; dispatch?: { ok: boolean; body: unknown } }) {
  const calls: { url: string; body: unknown }[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/plan')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(handlers.plan ?? PLAN) } as Response);
    }
    const d = handlers.dispatch ?? { ok: true, body: { sessionId: 'sess-1' } };
    return Promise.resolve({ ok: d.ok, status: d.ok ? 200 : 409, json: () => Promise.resolve(d.body) } as Response);
  }) as jest.Mock;
  return calls;
}

const realFetch = global.fetch;

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
      itemPath: ITEM.path, action: 'execute', prompt: 'do it my way',
      permissionMode: 'acceptEdits', remoteControl: true
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
});
