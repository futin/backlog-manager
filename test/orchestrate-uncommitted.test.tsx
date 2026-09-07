/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { OrchestrateSheet } from '../client/src/components/board/OrchestrateSheet';
import { SettingsProvider } from '../client/src/hooks/useSettings';
import type { BacklogItem } from '../shared/types';

/**
 * task-32 — the Orchestrate sheet's uncommitted flag.
 *
 * Its own file rather than more cases in test/orchestrator-start-ui.test.tsx:
 * that suite's `stubOrchestrate` deliberately answers this endpoint a CLEAN
 * tree and keeps it out of its `calls` list, so every case there can go on
 * asserting one launch request and no extra DOM. This file is the mirror
 * image — the endpoint's answer is the variable, and the launch is asserted
 * only where the flag is supposed to change it (or, in case 18, not to).
 */

function fakeItem(over: Partial<BacklogItem> = {}): BacklogItem {
  const base: BacklogItem = {
    id: 'task-1', title: 'a task', created: '2026-08-20', started: '', tags: [],
    updated: '', lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0,
    groomTokens: 0, executeTokens: 0, kind: '',
    section: 'tasks', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: true, path: '/abs/alpha/backlog/tasks/open/task-1.md'
  };
  return { ...base, ...over };
}

/** Three groomed, open, queueable rows — one of which the cases below flag. */
const BUG_1 = fakeItem({
  id: 'bug-1', title: 'Groomed bug', section: 'bugs',
  path: '/abs/alpha/backlog/bugs/open/bug-1.md'
});
const TASK_2 = fakeItem({
  id: 'task-2', title: 'Groomed task two', path: '/abs/alpha/backlog/tasks/open/task-2.md'
});
const TASK_3 = fakeItem({
  id: 'task-3', title: 'Groomed task three', path: '/abs/alpha/backlog/tasks/open/task-3.md'
});
const THREE = [BUG_1, TASK_2, TASK_3];

type UncommittedAnswer =
  | { paths: string[]; known: boolean }
  | 'reject'
  /** A 200 with no `paths` key at all. */
  | 'malformed'
  /** A 200 whose `paths` is not a list. */
  | 'malformed-type';

/**
 * Every request the sheet makes, with `/api/items/uncommitted` answered by
 * `answer` and the launch recorded in the returned array.
 *
 * merge-check answers `covered: true`, which is what keeps its setup hint out
 * of these cases' text assertions — the same default
 * `stubOrchestrate` picks, and for the same reason.
 */
function stub(answer: UncommittedAnswer): { url: string; body: unknown }[] {
  const calls: { url: string; body: unknown }[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/items/uncommitted')) {
      if (answer === 'reject') return Promise.reject(new Error('network down'));
      // Two malformed shapes, because they fail differently and only one of
      // them can prove the shape guard. `{ known: true }` — no `paths` at all,
      // the shape a wrong endpoint, a future rename or a stale catch-all stub
      // hands back — is ALSO absorbed by the render's own `known === true`
      // gate (`new Set(undefined)` is an empty set), so case 23 pins the
      // outcome rather than the guard. `paths: 5` is what the guard alone
      // catches: without it that value reaches `new Set(...)`, which throws
      // on a non-iterable and takes the whole sheet's render with it.
      const body = answer === 'malformed' ? { known: true }
        : answer === 'malformed-type' ? { known: true, paths: 5 }
        : answer;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    }
    if (url.includes('/api/agents/merge-check')) {
      return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve({ covered: true, source: null })
      } as Response);
    }
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({
      ok: true, status: 201, json: () => Promise.resolve({ sessionId: 'sess-1' })
    } as Response);
  }) as jest.Mock;
  return calls;
}

function renderSheet(items: BacklogItem[] = THREE) {
  const onClose = jest.fn();
  const refresh = jest.fn();
  render(
    <SettingsProvider>
      <OrchestrateSheet
        project="/abs/alpha"
        projectName="alpha"
        items={items}
        spawnMaxPermission="acceptEdits"
        onClose={onClose}
        refresh={refresh}
      />
    </SettingsProvider>
  );
  return { onClose, refresh };
}

/** Step 1 → step 3, the same two clicks `toModes` makes in the sibling suite. */
async function toModes(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'next' }));
  await userEvent.click(screen.getByRole('button', { name: 'next' }));
}

/** The row `div` for one queued id, addressed through its own checkbox so the
 *  lookup does not depend on DOM shape. */
function row(id: string): HTMLElement {
  const box = screen.getByLabelText(`select ${id}`);
  const item = box.closest('.run-drawer-item');
  if (item === null) throw new Error(`no row for ${id}`);
  return item as HTMLElement;
}

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  localStorage.clear();
});

describe('OrchestrateSheet — the uncommitted flag', () => {
  // --- case 16 ----------------------------------------------------------
  it('case 16: chips only the rows the payload names', async () => {
    stub({ paths: [TASK_2.path], known: true });
    renderSheet();

    await waitFor(() => expect(within(row('task-2')).getByText('uncommitted')).toBeInTheDocument());
    expect(within(row('bug-1')).queryByText('uncommitted')).not.toBeInTheDocument();
    expect(within(row('task-3')).queryByText('uncommitted')).not.toBeInTheDocument();
    // The row stays selectable and stays in the list: the run really will
    // queue it, gate it and report it, and this screen has no authority to
    // decide otherwise (the same rule that keeps an ungroomed row enabled).
    expect(screen.getByLabelText('select task-2')).toBeEnabled();
    expect(screen.getByLabelText('select task-2')).toBeChecked();
  });

  // A path the payload names that is NOT in the queue must chip nothing and
  // count nothing — the server answers about the whole `backlog/` tree
  // (ideas, refactors, done items, out-of-scope), and only bugs and tasks a
  // run can queue are on this screen at all.
  it('ignores an uncommitted path that is not a queued row', async () => {
    stub({ paths: ['/abs/alpha/backlog/ideas/open/idea-4.md'], known: true });
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('orchestrate-queue')).toBeInTheDocument());

    await waitFor(() => expect(screen.queryByText('uncommitted')).not.toBeInTheDocument());
    expect(screen.queryByTestId('orchestrate-uncommitted-note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /deselect uncommitted/ })).not.toBeInTheDocument();
  });

  // --- case 17 ----------------------------------------------------------
  it("case 17: the step 1 note carries the count and the run's own verdict string", async () => {
    stub({ paths: [BUG_1.path, TASK_3.path], known: true });
    renderSheet();

    const note = await screen.findByTestId('orchestrate-uncommitted-note');
    // The literal string `buildGatedQueue` writes into the run file's own
    // reasons — the whole point of this note is that the two surfaces say one
    // thing, so a person who finds the skip afterwards can match it up.
    expect(note).toHaveTextContent('not committed on main');
    expect(note).toHaveTextContent('2 items are');
    expect(note).toHaveTextContent('groomed on disk only');
  });

  it('says "item is" for one row and "items are" for two', async () => {
    stub({ paths: [BUG_1.path], known: true });
    renderSheet();
    expect(await screen.findByTestId('orchestrate-uncommitted-note')).toHaveTextContent('1 item is');
  });

  // --- case 18 ----------------------------------------------------------
  //
  // Decision 5's pin, and the assertion has to be about the ABSENT KEY rather
  // than its value: the difference between "drain the queue" and "run exactly
  // these ids" is whether `ids` is there at all, and an implementation that
  // auto-excluded flagged rows would send a two-id list here — a run that
  // silently drops an item committed while the sheet sat open.
  it('case 18: an untouched sheet posts no ids at all, flagged rows and all', async () => {
    const calls = stub({ paths: [TASK_2.path], known: true });
    renderSheet();
    await waitFor(() => expect(within(row('task-2')).getByText('uncommitted')).toBeInTheDocument());
    await toModes();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({
      project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge', questionMode: 'park'
    });
    expect(Object.keys(calls[0].body as object)).not.toContain('ids');
  });

  // --- case 19 ----------------------------------------------------------
  it('case 19: deselect uncommitted posts exactly the committed ids in queue order', async () => {
    const calls = stub({ paths: [TASK_2.path], known: true });
    renderSheet();

    const deselect = await screen.findByRole('button', { name: 'deselect uncommitted (1)' });
    await userEvent.click(deselect);

    expect(screen.getByLabelText('select task-2')).not.toBeChecked();
    expect(screen.getByLabelText('select bug-1')).toBeChecked();
    expect(screen.getByLabelText('select task-3')).toBeChecked();
    // Nothing left to deselect, so the control retires rather than sitting
    // there claiming work it has already done.
    expect(screen.queryByRole('button', { name: /deselect uncommitted/ })).not.toBeInTheDocument();

    await toModes();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    // Queue order — bugs before tasks — not the payload's order and not the
    // order the button happened to walk.
    expect(calls[0].body).toEqual({
      project: '/abs/alpha', permissionMode: 'acceptEdits', mergeMode: 'merge', questionMode: 'park',
      ids: ['bug-1', 'task-3']
    });
  });

  /**
   * The other half of case 19, on its own sheet rather than a second Start on
   * the same one: a successful launch sets `busy` and swaps Start for a
   * disabled `starting…`, because in the app the sheet closes at that point.
   * Two launches from one instance is a state this component never reaches.
   *
   * What it pins is that `deselect uncommitted` is not one-way — `select all`
   * is the only control that can return `selected` to `null`, and therefore
   * the only route back to the whole-queue REQUEST (see `selected`'s own
   * comment: a full explicit set and `null` describe the same selection but
   * not the same instruction).
   */
  it('case 19b: select all after deselect uncommitted restores the no-ids request', async () => {
    const calls = stub({ paths: [TASK_2.path], known: true });
    renderSheet();

    await userEvent.click(await screen.findByRole('button', { name: 'deselect uncommitted (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'select all' }));
    expect(screen.getByLabelText('select task-2')).toBeChecked();
    // The control comes back, because the row is selected again.
    expect(screen.getByRole('button', { name: 'deselect uncommitted (1)' })).toBeInTheDocument();

    await toModes();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(Object.keys(calls[0].body as object)).not.toContain('ids');
  });

  // --- case 20 ----------------------------------------------------------
  it('case 20: deselecting every row falls into the existing empty-selection refusal, not a new one', async () => {
    stub({ paths: [BUG_1.path, TASK_2.path, TASK_3.path], known: true });
    renderSheet();

    await userEvent.click(await screen.findByRole('button', { name: 'deselect uncommitted (3)' }));

    expect(screen.getByText('pick at least one item, or select all to drain the queue.')).toBeInTheDocument();
    expect(screen.getByText('0 of 3 selected')).toBeInTheDocument();
    // The same refusal unticking three boxes by hand produces — `next` is
    // where it lives since the sheet became a wizard.
    expect(screen.getByRole('button', { name: 'next' })).toBeDisabled();
  });

  // --- case 21 ----------------------------------------------------------
  it('case 21: known: false renders no chip and no note, even with paths listed', async () => {
    // Not a hypothetical pairing: the server returns `paths: []` on every
    // `known: false` path today, and a payload with both is exactly what a
    // client that treated `known` as decorative would render a confident,
    // unfounded chip from. `known` is the gate.
    stub({ paths: [TASK_2.path], known: false });
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('orchestrate-queue')).toBeInTheDocument());

    await waitFor(() => expect(screen.queryByText('uncommitted')).not.toBeInTheDocument());
    expect(screen.queryByTestId('orchestrate-uncommitted-note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /deselect uncommitted/ })).not.toBeInTheDocument();
  });

  // --- case 22 ----------------------------------------------------------
  it('case 22: a rejected fetch renders nothing, shows no error, and still launches', async () => {
    const calls = stub('reject');
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('orchestrate-queue')).toBeInTheDocument());

    expect(screen.queryByText('uncommitted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('orchestrate-uncommitted-note')).not.toBeInTheDocument();
    // The failure must not reach the sheet's own error line — same posture as
    // the merge-check hint: this exists to stop a run wasting a slot, not to
    // gate one.
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();

    await toModes();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(Object.keys(calls[0].body as object)).not.toContain('ids');
  });

  // --- case 23 ----------------------------------------------------------
  it('case 23: a malformed 200 is treated exactly like a rejection', async () => {
    // Routed through `fetchUncommitted`'s shape guard, not a render-time
    // `?.`: `known` alone cannot carry this, because `undefined` is falsy and
    // a body missing `paths` would happen to suppress the chip today while
    // silently asserting the opposite the day the render guard is written
    // `known !== false`.
    const calls = stub('malformed');
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('orchestrate-queue')).toBeInTheDocument());

    expect(screen.queryByText('uncommitted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('orchestrate-uncommitted-note')).not.toBeInTheDocument();

    await toModes();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it('case 23b: a 200 whose paths is not a list is treated identically, and the sheet still renders', async () => {
    // The guard's own red proof. Deleting the `if (!isUncommittedItems(data))`
    // check in `fetchUncommitted` puts `5` into `new Set(...)` during render,
    // which throws `number is not iterable` and unmounts the sheet — so the
    // queue assertion below, not the missing chip, is what goes red.
    const calls = stub('malformed-type');
    renderSheet();
    await waitFor(() => expect(screen.getByTestId('orchestrate-queue')).toBeInTheDocument());
    // A real tick past the resolved fetch, so the failure has actually landed
    // rather than still being in flight when the assertions run.
    await waitFor(() => expect(screen.getByLabelText('select task-2')).toBeChecked());

    expect(screen.queryByText('uncommitted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('orchestrate-uncommitted-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('orchestrate-queue')).toBeInTheDocument();

    await toModes();
    await userEvent.click(screen.getByRole('button', { name: 'start' }));
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  // --- case 24 ----------------------------------------------------------
  it('case 24: fetches exactly once per sheet open, whatever is picked or walked', async () => {
    stub({ paths: [TASK_2.path], known: true });
    renderSheet();
    await waitFor(() => expect(within(row('task-2')).getByText('uncommitted')).toBeInTheDocument());

    await toModes();
    // The merge-mode picker re-fires merge-check by design; this read must
    // not follow it, because nothing on this sheet can change the answer.
    await userEvent.selectOptions(screen.getByLabelText('Merge mode'), 'branch');
    await userEvent.selectOptions(screen.getByLabelText('Merge mode'), 'merge');
    await userEvent.click(screen.getByRole('button', { name: 'back' }));
    await userEvent.click(screen.getByRole('button', { name: 'next' }));

    const spy = global.fetch as unknown as jest.Mock;
    const asked = spy.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('/api/items/uncommitted'));
    expect(asked).toHaveLength(1);
    // The URL carries the project, encoded — the same contract
    // `fetchMergeCheck` has.
    expect(asked[0]).toBe(`/api/items/uncommitted?project=${encodeURIComponent('/abs/alpha')}`);
  });

  // Step 2 deliberately carries no chip — the flag is a step 1 fact about
  // membership, and step 2 has no checkbox to act on it with. Pinned so the
  // omission reads as a decision rather than something nobody noticed.
  it('renders no chip on the order step', async () => {
    stub({ paths: [TASK_2.path], known: true });
    renderSheet();
    await waitFor(() => expect(within(row('task-2')).getByText('uncommitted')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.getByTestId('orchestrate-order')).toBeInTheDocument();
    expect(screen.queryByText('uncommitted')).not.toBeInTheDocument();
  });
});
