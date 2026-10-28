/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { ItemsStep } from '../client/src/components/board/orchestrate/ItemsStep';
import { ModesStep } from '../client/src/components/board/orchestrate/ModesStep';
import { OrderStep } from '../client/src/components/board/orchestrate/OrderStep';
import type { OrchestrateDraft } from '../client/src/hooks/useOrchestrateDraft';
import type { RunOnState } from '../client/src/hooks/useRunOn';
import { EFFORT_OPTIONS, MODEL_OPTIONS } from '../client/src/lib/agents';
import { mergeModeOptionLabels } from '../client/src/lib/merge-mode';
import { arrangeOrder, orchestrateQueue, resolveSelection, uncommittedFates } from '../client/src/lib/orchestrate-draft';
import { daysAgoDate } from './helpers/dates';
import type { BacklogItem, UncommittedItems } from '../shared/types';

/**
 * #306 — each Orchestrate step rendered ALONE, from a hand-built `OrchestrateDraft`: the capability the split exists to buy. No `SettingsProvider`, no fetch
 * stub — a step that still needed either would fail here, which is the point. The sheet as a whole, walked step to step, stays
 * `test/orchestrator-start-ui.test.tsx`'s.
 */

function item(over: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'task-1',
    title: 'a task',
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
    path: '/abs/alpha/backlog/tasks/open/task-1.md',
    source: 'files',
    url: null,
    assignee: null,
    untyped: false,
    ...over
  };
}

const A = item({ id: 'task-a', title: 'first', path: '/abs/alpha/backlog/tasks/open/task-a.md' });
const B = item({ id: 'task-b', title: 'second', path: '/abs/alpha/backlog/tasks/open/task-b.md' });

const homeRunOn: RunOnState = {
  offers: null,
  machine: 'home',
  pick: () => {},
  remote: false,
  label: null,
  lock: { prOnly: false, models: [], efforts: [] },
  model: '',
  setModel: () => {},
  effort: '',
  setEffort: () => {},
  modelOptions: MODEL_OPTIONS,
  effortOptions: EFFORT_OPTIONS,
  request: {},
  blocked: false,
  loading: false,
  note: null
};

/**
 * A draft built the way the hook builds one — through the same lib derivations — from a handful of inputs, so a fixture cannot describe a state the hook
 * could never produce. Every action is an inert `jest.fn()` the case can assert on.
 */
function makeDraft(
  over: Partial<OrchestrateDraft> & { items?: BacklogItem[]; uncommitted?: UncommittedItems | null; order?: string[] | null } = {}
): OrchestrateDraft {
  const { items = [A, B], uncommitted = null, order = null, ...rest } = over;
  const queue = orchestrateQueue(items);
  const queueIds = queue.map(({ item: i }) => i.id);
  const selection = resolveSelection(queueIds, null);
  const fates = uncommittedFates(queue, uncommitted);
  return {
    project: '/abs/alpha',
    allowedModes: ['plan', 'acceptEdits'],
    mode: 'acceptEdits',
    setMode: jest.fn(),
    runOn: homeRunOn,
    prOffered: true,
    mergeMode: 'merge',
    setMergeMode: jest.fn(),
    mergeModeLabels: mergeModeOptionLabels('main'),
    questionMode: 'park',
    setQuestionMode: jest.fn(),
    base: 'main',
    setBase: jest.fn(),
    branches: ['main'],
    mergeCoverage: null,
    queue,
    queueIds,
    ...selection,
    ...fates,
    uncommittedSelected: fates.uncommittedIds.filter(selection.isSelected),
    order,
    arranged: arrangeOrder(order, selection.selectedIds),
    byId: new Map(queue.map(({ item: i }) => [i.id, i])),
    toggle: jest.fn(),
    selectAll: jest.fn(),
    selectNone: jest.fn(),
    deselectUncommitted: jest.fn(),
    move: jest.fn(),
    resetOrder: jest.fn(),
    busy: false,
    error: null,
    start: jest.fn(),
    ...rest
  };
}

describe('ItemsStep', () => {
  it('renders the queue and the uncommitted note, and a checkbox calls toggle with its row’s id', () => {
    const draft = makeDraft({ uncommitted: { paths: [B.path], absent: [B.path], known: true } });
    render(<ItemsStep draft={draft} />);
    expect(screen.getByTestId('orchestrate-step-items')).toBeInTheDocument();
    expect(within(screen.getByTestId('orchestrate-queue')).getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByTestId('orchestrate-uncommitted-note')).toHaveTextContent('1 is missing from main altogether');
    fireEvent.click(screen.getByRole('checkbox', { name: 'select task-b' }));
    expect(draft.toggle).toHaveBeenCalledWith('task-b');
  });

  it('draws no uncommitted note without an answer', () => {
    render(<ItemsStep draft={makeDraft({ uncommitted: null })} />);
    expect(screen.queryByTestId('orchestrate-uncommitted-note')).not.toBeInTheDocument();
  });
});

describe('OrderStep', () => {
  it('draws the arranged rows in order, moves one, and disables the two moves off the ends', () => {
    const draft = makeDraft();
    render(<OrderStep draft={draft} />);
    const rows = screen.getAllByTestId('orchestrate-order-row');
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['task-a', 'task-b']);
    fireEvent.click(screen.getByRole('button', { name: 'move task-b up' }));
    expect(draft.move).toHaveBeenCalledWith(1, -1);
    expect(screen.getByRole('button', { name: 'move task-a up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'move task-b down' })).toBeDisabled();
  });
});

describe('ModesStep', () => {
  const mergeOptions = (): string[] =>
    Array.from((screen.getByRole('combobox', { name: 'Merge mode' }) as HTMLSelectElement).options).map((o) => o.value);

  it('offers pr only when the draft says the source can run it', () => {
    const { unmount } = render(<ModesStep draft={makeDraft({ prOffered: false })} />);
    expect(mergeOptions()).not.toContain('pr');
    unmount();
    render(<ModesStep draft={makeDraft({ prOffered: true })} />);
    expect(mergeOptions()).toContain('pr');
  });

  it('draws the setup hint for an uncovered merge run, and not under branch mode', () => {
    const uncovered = { covered: false, source: null };
    const { unmount } = render(<ModesStep draft={makeDraft({ mergeCoverage: uncovered, mergeMode: 'merge' })} />);
    expect(screen.getByText('/abs/alpha/.claude/settings.local.json')).toBeInTheDocument();
    expect(screen.getByText(/Bash\(git merge --no-ff \*\)/)).toBeInTheDocument();
    unmount();
    render(<ModesStep draft={makeDraft({ mergeCoverage: uncovered, mergeMode: 'branch' })} />);
    expect(screen.queryByText('/abs/alpha/.claude/settings.local.json')).not.toBeInTheDocument();
  });

  it('shows start’s error', () => {
    render(<ModesStep draft={makeDraft({ error: 'boom' })} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
