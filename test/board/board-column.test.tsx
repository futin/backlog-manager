/**
 * @jest-environment jsdom
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { BoardColumn } from '../../client/src/components/board/BoardColumn';
import BoardView from '../../client/src/components/board/BoardView';
import { daysAgoDate, daysAgoStamp } from '../helpers/dates';
import { readStyles, ruleBlock, ruleBlocks } from '../helpers/css-rule';
import type { AgentsStatus, BacklogItem, ItemsIndex, OrchestratorRunsPayload, ProjectSummary } from '../../shared/types';
import { OrchestratorRunsProvider } from '../../client/src/hooks/OrchestratorRunsContext';

/**
 * `BoardColumn` and the card's marker row — the two pieces of §8.3 that are
 * about a card's neighbours rather than about the card. Plus the deletion
 * itself: the three components this task took off the Board are gone from
 * `client/src` entirely, which is a claim no rendering test can make.
 *
 * The column header's own rule — that it draws NONE — is a stylesheet fact and
 * is asserted against the sheet's text for the reason every `*-style` suite
 * here documents: jsdom performs no layout and these suites never load
 * `styles.css`, so a rendered assertion about a border would pass whether or
 * not the declaration existed.
 */
const ROOT = join(__dirname, '..', '..');

const PROJECTS: ProjectSummary[] = [
  {
    name: 'alpha',
    path: '/abs/alpha',
    createdAt: '2026-08-26T00:00:00.000Z',
    missing: false,
    counts: { bugs: 1, ideas: 1, tasks: 1, refactors: 1, 'out-of-scope': 0 },
    source: 'files',
    repo: null,
    polledAt: null,
    access: null,
    detail: null,
    interval: null
  }
];

const AGENTS_STATUS: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'auto',
  projectPaths: ['/abs/alpha']
};

const NO_RUNS: OrchestratorRunsPayload = { runs: [], starting: [], remote: [], remoteStarting: [] };

function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  const base: BacklogItem = {
    id: 'bug-1',
    title: 'a bug',
    created: daysAgoDate(2),
    started: '',
    tags: [],
    // Fresh, so nothing here leaves for Archive on the staleness split.
    updated: daysAgoStamp(0),
    lastCommit: '',
    phase: '',
    groomElapsed: 0,
    executeElapsed: 0,
    groomTokens: 0,
    executeTokens: 0,
    kind: '',
    section: 'bugs',
    status: 'open',
    project: 'alpha',
    projectPath: '/abs/alpha',
    groomed: false,
    path: '/abs/alpha/backlog/bugs/open/bug-1.md',
    source: 'files',
    url: null,
    assignee: null,
    untyped: false,
    ...over
  };
  return { ...base, path: over.path ?? `/abs/alpha/backlog/${base.section}/open/${base.id}.md` };
}

const ITEMS: ItemsIndex = {
  items: [
    fakeItem({ id: 'ref-1', title: 'a refactor', section: 'refactors', groomed: null }),
    fakeItem({ id: 'idea-1', title: 'an idea', section: 'ideas', groomed: null }),
    fakeItem({ id: 'bug-1', title: 'a bug' }),
    fakeItem({ id: 'task-1', title: 'a task', section: 'tasks', groomed: true })
  ],
  errors: []
};

function stub(items: ItemsIndex = ITEMS, agents: AgentsStatus | null = AGENTS_STATUS): void {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const payload: unknown = url.includes('/api/agents/status')
      ? agents
      : url.includes('/api/orchestrator/runs')
        ? NO_RUNS
        : url.includes('/api/projects')
          ? PROJECTS
          : items;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
  }) as unknown as typeof fetch;
}

async function renderBoard(): Promise<void> {
  render(<OrchestratorRunsProvider><BoardView source="files" /></OrchestratorRunsProvider>);
  await waitFor(() => expect(screen.getByText('Bugs')).toBeInTheDocument());
}

beforeEach(() => {
  localStorage.clear();
  stub();
});

describe('BoardColumn', () => {
  /**
   * The ramp, left to right, in the order §8.2 gives it: refactors amber,
   * ideas mustard, bugs red, tasks green — replacing the magenta/mustard/red/
   * cyan ticks that stood here. Asserted as the four `Dot` classes in column
   * order rather than one at a time, because the ORDER is half the rule: the
   * ramp reads as increasing commitment from left to right, and four correct
   * hues in the wrong columns would pass four separate assertions.
   */
  it('heads each column with its ramp dot, in the design order', async () => {
    await renderBoard();
    const dots = screen.getAllByTestId('board-col').map((col) => (col.querySelector('.board-col-head .ui-dot') as HTMLElement).className);
    expect(dots).toEqual([
      expect.stringContaining('ui-dot-ramp-refactors'),
      expect.stringContaining('ui-dot-ramp-ideas'),
      expect.stringContaining('ui-dot-ramp-bugs'),
      expect.stringContaining('ui-dot-ramp-tasks')
    ]);
  });

  /** The Jira shelves' toned header left with the shelves (parent lanes): the `tone` prop, its `data-tone` hook, the page-local `.board-col-dot` and
   *  `.board-col-count` spans and the `todo`/`doing`/`done` slugs are gone. Asserted on the markup and on the sheet together — a rule left standing with no
   *  reader is how a redrawn surface comes to be restyled back by accident. */
  it('draws no toned header, and the stylesheet carries none', async () => {
    await renderBoard();
    for (const col of screen.getAllByTestId('board-col')) {
      expect(col).not.toHaveAttribute('data-tone');
      expect(col.querySelector('.board-col-dot, .board-col-count')).toBeNull();
    }
    const css = readStyles();
    expect(css).not.toMatch(/\.board-col\[data-tone/);
    expect(ruleBlock(css, '.board-col-dot')).toBeNull();
    expect(ruleBlock(css, '.board-col-count')).toBeNull();
  });

  /** The count is a `Pill` — the primitive — inside the span that lays it out.
   *  The old `.board-col-count` text node went with `.board-col-h` in task-39,
   *  when Archive — its last reader — moved onto this component. */
  it('carries the count in a neutral Pill pushed right', async () => {
    await renderBoard();
    const counts = screen.getAllByTestId('col-count');
    expect(counts.map((c) => c.textContent)).toEqual(['1', '1', '1', '1']);
    for (const count of counts) {
      expect(count).toHaveClass('board-col-pill');
      expect(count.querySelector('.ui-pill')).toHaveClass('ui-pill-neutral');
    }
  });

  /** The tick is gone with the rule under it — both were the old header's. */
  it('draws no tick, and the stylesheet declares none', async () => {
    await renderBoard();
    expect(document.querySelector('.board-col-tick')).toBeNull();
    // Task-39: and no rule survives for one either, now that Archive — which
    // kept the tick alive through task-37 — draws this header instead.
    expect(ruleBlock(readStyles(), '.board-col-tick')).toBeNull();
  });

  /**
   * No rule under the header: the cards' own ground gap is the only
   * separation. §8's standing "nothing on `--board` uses `--strip-hi` as its
   * only separator" rule does not apply here, because the separator is a gap
   * rather than a stroke — which is exactly why the absence has to be pinned
   * rather than left to read as an omission.
   */
  it('declares no border under the header, where the old one did', () => {
    const css = readStyles();
    expect(ruleBlock(css, '.board-col-head') as string).not.toMatch(/border/);
    // The old `.board-col-h` rule outlived the Board's header only because
    // Archive was still drawing it; task-39 put Archive on this component too,
    // so the class went with the last surface asking for it. Its absence is
    // asserted rather than left implied — a rule left standing with no reader
    // is how a redrawn surface comes to be restyled back by accident.
    expect(ruleBlock(css, '.board-col-h')).toBeNull();
  });

  /**
   * The `--steel` ground is opt-in (`ground`), not implied by the slug: the GitHub Board passes it, Archive does not, because Archive's sticky
   * `.archive-month` paints `--board` and would read as a white band across a steel column. The ground is one rule on `[data-ground]`. Asserted on the
   * attribute and on the sheet together — jsdom loads no stylesheet, so an attribute alone would stay green with the rule deleted.
   */
  it('draws the ground on the GitHub Board column, never on an Archive column', async () => {
    await renderBoard();
    for (const col of screen.getAllByTestId('board-col')) {
      expect(col).toHaveAttribute('data-ground');
      // The Board's column keeps its ramp Dot under the ground.
      expect(col.querySelector('.board-col-head .ui-dot')).not.toBeNull();
    }

    // Archive does not pass it, and its columns stay exactly as they were.
    const archive = render(
      <BoardColumn slug="bugs" label="Archived" count={1}>
        <i />
      </BoardColumn>,
    );
    expect(archive.container.querySelector('.board-col')).not.toHaveAttribute('data-ground');

    const css = readStyles();
    const ground = ruleBlock(css, '.board-col[data-ground]') as string;
    expect(ground).toMatch(/background:\s*var\(--steel\)/);
    expect(ground).toMatch(/border-radius:\s*16px/);
    expect(ground).toMatch(/padding:\s*12px/);
  });

  /**
   * The cut ground: `align-items: start` let each column end at its last card, so the ground stopped there (an empty In Progress was a 40 px strip). The
   * grid must stretch its items, and the board must fill the well down to its foot, so every column is one height. Read from the sheet, because jsdom
   * performs no layout.
   */
  it('lets the grid stretch its columns and the board fill the well', () => {
    const css = readStyles();
    // `ruleBlock` returns only the FIRST rule naming `.board-columns`, which is the `.board > .board-columns` fill rule, not the grid's own — so every rule
    // that names it is checked, and there must be several (the grid, the fill, the two width steps).
    const blocks = ruleBlocks(css, '.board-columns');
    expect(blocks.length).toBeGreaterThan(2);
    for (const block of blocks) expect(block).not.toMatch(/align-items:\s*start/);
    expect(ruleBlock(css, '.board > .board-columns') as string).toMatch(/flex:\s*1/);
  });

  /**
   * The fill chain's other links: `.board-columns` growing is not enough unless every ancestor up to the well grows with it. `.main` is the flex column, `.wrap`
   * flex-fills only where it holds a board of columns, and `.board` flex-fills inside that. Comments are stripped first, because the sheet's own comments
   * name these selectors and `ruleBlock` takes the first mention it finds.
   */
  it('keeps the whole fill chain flex from the well down to the columns', () => {
    const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, '');
    // `.main` is named by several rules (the well's own padding and ground among them), so it is the one that makes it a column that counts.
    expect(ruleBlocks(css, '.main').some((block) => /display:\s*flex/.test(block) && /flex-direction:\s*column/.test(block))).toBe(true);
    const wrap = ruleBlock(css, '.wrap:has(> .board > .board-columns)') as string;
    expect(wrap).toMatch(/flex:\s*1/);
    expect(wrap).toMatch(/display:\s*flex/);
    expect(wrap).toMatch(/flex-direction:\s*column/);
    expect(ruleBlock(css, '.wrap > .board:has(> .board-columns)') as string).toMatch(/flex:\s*1/);
  });
});

describe("the card's marker row", () => {
  /**
   * The regression guard for "the marker row renders whenever dispatch is
   * available, markers or not" (DESIGN.md §8.3). An ungroomed bug in a visible
   * project earns no marker at all — not `groomed`, not `kind`, not `done`,
   * not `stale` — so a row that only appeared when `markers.length > 0` would
   * leave its dispatch chip nowhere to sit, and the control that a reader must
   * be able to click to re-ask a stale status (bug-13) would be invisible.
   */
  it('renders with only the dispatch chip when no marker applies', async () => {
    stub({ items: [fakeItem({ id: 'bug-1', title: 'a bug', groomed: false })], errors: [] });
    await renderBoard();

    const card = screen.getByText('a bug').closest('.board-card') as HTMLElement;
    const row = within(card).getByTestId('marker-row');
    expect(row.querySelector('.ui-marker')).toBeNull();
    expect(within(row).getByRole('button', { name: 'groom' })).toBeInTheDocument();
  });

  /**
   * ...and the other half, which is what makes the rule a rule rather than
   * "always render the row": with the environment forbidding dispatch there is
   * no control to reserve space for, and an item with no markers gets no row.
   */
  it('renders no row at all when neither a marker nor a dispatch control applies', async () => {
    stub({ items: [fakeItem({ id: 'bug-1', title: 'a bug', groomed: false })], errors: [] }, { ...AGENTS_STATUS, enabled: false });
    await renderBoard();

    const card = screen.getByText('a bug').closest('.board-card') as HTMLElement;
    expect(within(card).queryByTestId('marker-row')).toBeNull();
  });
});

describe('what left the Board', () => {
  /**
   * `RunStrip`, `StartingStrip` and `RunDrawer` are gone (DESIGN.md §8.3's
   * "What leaves"), and this is the half no render can prove: a component
   * still imported but never mounted would pass every case above while
   * shipping in the bundle and inviting a second copy of rules that have
   * moved to Runs.
   *
   * The scan is over source text rather than the filesystem alone, because the
   * files being absent is the easy half — what matters is that nothing reaches
   * for them, including a re-export or a lazy import.
   */
  it('leaves no trace of the three departed components in client/src', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        // An IMPORT or a JSX mount, not a mention: several files explain in
        // prose where a rule used to live, and prose is the opposite of the
        // problem this catches.
        if (/from '[^']*(?:RunStrip|StartingStrip|RunDrawer)'|<(?:RunStrip|StartingStrip|RunDrawer)\b/.test(src)) {
          offenders.push(full.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(ROOT, 'client', 'src'));
    expect(offenders).toEqual([]);
  });
});
