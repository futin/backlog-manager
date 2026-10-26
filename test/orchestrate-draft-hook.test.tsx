/**
 * @jest-environment jsdom
 */
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useOrchestrateDraft } from '../client/src/hooks/useOrchestrateDraft';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import { homeOnly } from './helpers/offers';
import type { PermissionMode } from '../shared/types';

/**
 * #306 step 6 — the permission mode follows the host ceiling. Before it the hook seeded `mode` once, from the ceiling at mount, and never looked again: a
 * ceiling that dropped while the sheet was open left a pick above it, sent with Start, and refused by the server. Now the pick is stored and the sent value
 * is derived in render, `mergeMode`'s pattern — so a ceiling that rises again gives the pick back.
 */

const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const answer = (body: unknown): Promise<Response> => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    if (url.includes('/api/dashboards/offers')) return answer(homeOnly());
    if (url.includes('/api/agents/branches')) return answer({ branches: ['main'] });
    if (url.includes('/api/agents/merge-check')) return answer({ covered: true, source: null });
    if (url.includes('/api/items/uncommitted')) return answer({ paths: [], absent: [], known: true });
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  }) as jest.Mock;
});

afterEach(() => {
  global.fetch = realFetch;
});

const wrapper = ({ children }: { children: ReactNode }) => <SettingsProvider>{children}</SettingsProvider>;

function renderDraft(spawnMaxPermission: PermissionMode | null) {
  return renderHook(
    ({ ceiling }: { ceiling: PermissionMode | null }) =>
      useOrchestrateDraft({ project: '/abs/alpha', source: 'files', items: [], spawnMaxPermission: ceiling, refresh: () => {}, onClose: () => {} }),
    { wrapper, initialProps: { ceiling: spawnMaxPermission } }
  );
}

describe('useOrchestrateDraft — mode', () => {
  it('clamps a pick to a ceiling that drops, and gives it back when the ceiling rises', async () => {
    const { result, rerender } = renderDraft('acceptEdits');
    await waitFor(() => expect(result.current.runOn.loading).toBe(false));
    act(() => result.current.setMode('acceptEdits'));
    expect(result.current.mode).toBe('acceptEdits');
    rerender({ ceiling: 'plan' });
    expect(result.current.mode).toBe('plan');
    rerender({ ceiling: 'acceptEdits' });
    expect(result.current.mode).toBe('acceptEdits');
  });

  it('seeds auto under a ceiling above it', async () => {
    const { result } = renderDraft('bypassPermissions');
    await waitFor(() => expect(result.current.runOn.loading).toBe(false));
    expect(result.current.mode).toBe('auto');
  });
});
