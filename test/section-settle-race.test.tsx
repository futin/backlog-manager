/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { App } from '../client/src/App';

/*
  A reader's click that lands between the projects answer's COMMIT and that commit's settle EFFECT must win (App.tsx, the settle effect).

  The projects answer is a default-lane render, so React hands the commit's passive effects to the scheduler as a task of their own. A real Scheduler usually
  runs that task straight after the commit, in the same macrotask, so the gap is invisible — until a 5 ms frame deadline expires between the two, which is
  what a loaded machine (jest's worker pool, a busy laptop) does. A click landing there renders as a sync update, and React flushes the deferred effects first:
  with the closure of the render that still held `pending`, the settle called `change('files')` AFTER the click's `change('runs')`, and queue order made Files
  win. Seen as a flake of nav.test.tsx's "clicking Runs" case (18 of 40 runs under eight-way parallel load, never on an idle machine).

  So this suite swaps React's scheduler for `scheduler/unstable_mock`, which runs nothing until told: `unstable_flushUntilNextPaint` performs the answer's
  render and commit and stops at the paint, leaving the passive effects queued — the gap, held open on purpose. Its own file because the mock scheduler
  changes how every render in the file is driven; the shell's other cases stay on the real one in nav.test.tsx and source-sections.test.tsx.

  `scheduler` is not hoisted under pnpm, so both the mock and the handle are resolved from react-dom, the module that requires it.
*/
jest.mock(require.resolve('scheduler', { paths: [require.resolve('react-dom')] }), () =>
  jest.requireActual(require.resolve('scheduler/unstable_mock', { paths: [require.resolve('react-dom')] }))
);
jest.mock('../client/src/components/board/BoardView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'board stub')
}));
jest.mock('../client/src/components/runs/RunsView', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', null, 'runs stub')
}));

const Scheduler = require(require.resolve('scheduler', { paths: [require.resolve('react-dom')] })) as {
  unstable_flushUntilNextPaint: () => void;
  unstable_flushAllWithoutAsserting: () => void;
};

const SECTION_KEY = 'backlog-manager.section';
const PROJECTS = [
  {
    name: 'alpha',
    path: '/abs/alpha',
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 0, ideas: 0, tasks: 0, refactors: 0, 'out-of-scope': 0 },
    source: 'files'
  }
];

const railRows = (): HTMLElement[] =>
  within(screen.getByRole('navigation', { name: 'Sections' }))
    .getAllByRole('button')
    .filter((t) => t.classList.contains('rail-link'));
const marked = (): string[] =>
  railRows()
    .filter((t) => t.getAttribute('aria-current') === 'page')
    .map((t) => t.textContent ?? '');
const row = (label: string): HTMLElement => {
  const found = railRows().find((t) => t.textContent === label);
  if (!found) throw new Error(`no rail row named ${label}`);
  return found;
};

describe('the provisional landing settle', () => {
  let answer!: () => void;
  // Expected noise, for the whole file: the answer's render runs outside act by design — act would flush its effects inside the commit and close the
  // gap — and the lazy chunks it opens finish loading outside act too, after the case has asserted.
  let quiet: jest.SpyInstance;
  beforeAll(() => (quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined)));
  afterAll(() => quiet.mockRestore());

  beforeEach(() => {
    localStorage.clear();
    const answered = new Promise<void>((resolve) => (answer = resolve));
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const reply = Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes('/api/projects') ? PROJECTS : {}) } as Response);
      return url.includes('/api/projects') ? answered.then(() => reply) : reply;
    }) as jest.Mock;
  });

  it('keeps a click that lands between the projects answer commit and its settle effect', async () => {
    render(<App />);
    // No stored section: a provisional landing, so nothing is marked and no source row is drawn until the projects answer.
    expect(railRows().map((t) => t.textContent)).toEqual(['Runs', 'Settings']);

    answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    Scheduler.unstable_flushUntilNextPaint();

    // The gap itself: the answer is committed (the Files row is drawn), the settle has not run (nothing is marked yet).
    expect(railRows().map((t) => t.textContent)).toEqual(['Files', 'Runs', 'Settings']);
    expect(marked()).toEqual([]);

    fireEvent.click(row('Runs'));
    Scheduler.unstable_flushAllWithoutAsserting();

    expect(marked()).toEqual(['Runs']);
    expect(JSON.parse(localStorage.getItem(SECTION_KEY) ?? 'null')).toBe('runs');
  });
});
