/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { App } from '../client/src/App';
import { NARROW_QUERY } from '../client/src/hooks/useNarrow';
import type { TrackerProjectRow, TrackersPayload } from '../shared/types';

/**
 * The shell strip (the tracker strip spec, §1): `.shell > .rail + .maincol > (.topstrip + .main)`, and the tracker chip in exactly ONE of two homes — the
 * strip at desktop width, the rail bar below 700 px — chosen in JS from `useNarrow`, never drawn twice and hidden by CSS.
 *
 * Board and Settings are stubbed for `nav.test.tsx`'s reason: the subject is the shell, and a real BoardView would bring four fetches and a polling clock
 * to assert nothing about it. `/api/trackers` is answered for real, because the chip reads the shell's own `useTrackers` through the provider App mounts.
 */
jest.mock('../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../client/src/components/settings/SettingsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'settings stub')
}));

/** `ui-use-narrow.test.tsx`'s stub: one fixed verdict, listeners remembered so a case can flip it. */
function installMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: NARROW_QUERY,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => {
      listeners.add(l);
    },
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => {
      listeners.delete(l);
    }
  };
  Object.defineProperty(window, 'matchMedia', { value: jest.fn(() => mql), configurable: true, writable: true });
  return {
    emit(next: boolean) {
      mql.matches = next;
      for (const l of listeners) l({ matches: next } as MediaQueryListEvent);
    }
  };
}

function row(over: Partial<TrackerProjectRow> = {}): TrackerProjectRow {
  return {
    name: 'alpha',
    path: '/abs/alpha',
    source: 'github',
    repo: 'futin/alpha',
    polledAt: new Date(Date.now() - 5_000).toISOString(),
    access: 'ok',
    detail: null,
    connect: null,
    ...over
  };
}

function stubFetch(trackers: TrackersPayload) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const body = String(input).includes('/api/trackers') ? trackers : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  }) as unknown as typeof fetch;
}

const healthy = (rows: TrackerProjectRow[] = [row()]): TrackersPayload => ({
  platforms: [{ kind: 'github', hasToken: true, login: 'futin', limit: 5000, remaining: 4930, reset: 1_790_000_000 }],
  projects: rows
});

const chipCount = () => document.querySelectorAll('[data-testid="tracker-chip"]').length;

beforeEach(() => {
  localStorage.clear();
  stubFetch(healthy());
});

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

describe('the shell strip', () => {
  it('draws the chip in the top strip at desktop width, and nowhere else', async () => {
    installMatchMedia(false);
    render(<App />);
    const chip = await screen.findByTestId('tracker-chip');
    expect(chip.closest('.topstrip')).not.toBeNull();
    expect(chipCount()).toBe(1);
    expect(document.querySelector('.rail-bar')).toBeNull();
  });

  it('moves the chip into the rail bar below 700 px', async () => {
    installMatchMedia(true);
    render(<App />);
    const chip = await screen.findByTestId('tracker-chip');
    expect(chip.closest('.rail-bar')).not.toBeNull();
    expect(chip.closest('.topstrip')).toBeNull();
    expect(chipCount()).toBe(1);
  });

  it('closes the popover when the chip changes home', async () => {
    // Review Focus 4: a popover anchored to a chip that just moved would be drawn against nothing.
    const mm = installMatchMedia(false);
    render(<App />);
    await userEvent.click(await screen.findByTestId('tracker-chip'));
    expect(screen.getByRole('dialog', { name: 'Tracker' })).toBeInTheDocument();
    act(() => mm.emit(true));
    expect(screen.queryByRole('dialog', { name: 'Tracker' })).toBeNull();
    expect(screen.getByTestId('tracker-chip').closest('.rail-bar')).not.toBeNull();
  });

  it('keeps the strip in the tree when there is no tracker', async () => {
    installMatchMedia(false);
    stubFetch(healthy([row({ source: 'files', repo: null, polledAt: null })]));
    render(<App />);
    await screen.findByText('board stub');
    await act(async () => {
      await Promise.resolve();
    });
    const strip = document.querySelector('.topstrip');
    expect(strip).not.toBeNull();
    expect(strip!.children).toHaveLength(0);
  });

  it('the strip precedes the main column and the rail precedes both', async () => {
    installMatchMedia(false);
    render(<App />);
    await screen.findByTestId('tracker-chip');
    const shell = [...document.querySelector('.shell')!.children].map((el) => `${el.tagName.toLowerCase()}.${el.classList[0]}`);
    expect(shell).toEqual(['nav.rail', 'div.maincol']);
    const col = [...document.querySelector('.maincol')!.children].map((el) => `${el.tagName.toLowerCase()}.${el.classList[0]}`);
    expect(col).toEqual(['div.topstrip', 'main.main']);
  });
});
