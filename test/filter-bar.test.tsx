/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { FilterBar, FilterSection, ProjectPicks } from '../client/src/components/FilterBar';
import type { FilterBarSort } from '../client/src/components/FilterBar';
import { buildProjectHues } from '../client/src/lib/project-hue';
import type { RegistryProject } from '../shared/types';
import { mediaBlocks, readStyles, ruleBlock } from './helpers/css-rule';

/**
 * The band's filter track and the three pieces its popover is built from (the band-filter spec's §1, §2; .claude/DESIGN.md §8.3). What this suite owns is the
 * track's reading of its props and the open/close mechanics; `ui-popover.test.tsx` owns the panel's own dismissal, and the Board and Archive suites own what
 * their callers put inside it. The names asserted here — the two dialogs, the two buttons, the groups — are the ones those suites query by, so a rename is
 * a change to all three at once.
 */

type SortKey = 'created' | 'name' | 'project';

const SORT_OPTIONS: FilterBarSort<SortKey>['options'] = [
  { value: 'created', label: 'Created', hint: 'when it was filed' },
  { value: 'name', label: 'Name', hint: 'title, A–Z' },
  { value: 'project', label: 'Project', hint: 'grouped by repo' }
];

function sortProp(over: Partial<FilterBarSort<SortKey>> = {}): FilterBarSort<SortKey> {
  return { key: 'created', dir: 'desc', options: SORT_OPTIONS, onKey: jest.fn(), onDir: jest.fn(), ...over };
}

const filterButton = (name: string | RegExp = /^Filters/): HTMLElement => screen.getByRole('button', { name });
const sortButton = (): HTMLElement => screen.getByRole('button', { name: 'Change sort' });

describe('FilterBar — the track', () => {
  it('reads Filters with no badge and no raised look when nothing is set', () => {
    render(
      <FilterBar count={0} onClear={() => {}}>
        <p>body</p>
      </FilterBar>
    );
    const button = filterButton('Filters');
    expect(button).not.toHaveClass('on');
    expect(within(button).queryByText(/\d/)).toBeNull();
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('reads Filters, 2 set with a badge and the raised look when two are set', () => {
    render(
      <FilterBar count={2} onClear={() => {}}>
        <p>body</p>
      </FilterBar>
    );
    const button = filterButton('Filters, 2 set');
    expect(button).toHaveClass('on');
    expect(within(button).getByText('2')).toBeInTheDocument();
  });

  it('opens a dialog named Filters holding the children and Clear all, and a second click closes it', async () => {
    const user = userEvent.setup();
    render(
      <FilterBar count={0} onClear={() => {}}>
        <p>the body</p>
      </FilterBar>
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(filterButton());
    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    expect(within(dialog).getByText('the body')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
    expect(filterButton()).toHaveAttribute('aria-expanded', 'true');

    await user.click(filterButton());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(filterButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('Clear all calls onClear while something is set, and the popover stays open', async () => {
    const user = userEvent.setup();
    const onClear = jest.fn();
    render(
      <FilterBar count={2} onClear={onClear}>
        <p>body</p>
      </FilterBar>
    );
    await user.click(filterButton());
    const clear = screen.getByRole('button', { name: 'Clear all' });
    expect(clear).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
  });

  it('Clear all is inert at count 0: aria-disabled, and a click does not call onClear', async () => {
    const user = userEvent.setup();
    const onClear = jest.fn();
    render(
      <FilterBar count={0} onClear={onClear}>
        <p>body</p>
      </FilterBar>
    );
    await user.click(filterButton());
    const clear = screen.getByRole('button', { name: 'Clear all' });
    expect(clear).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, not `disabled`: the control stays in the tab order so a keyboard reader can land on it and hear that it is unavailable.
    expect(clear).not.toBeDisabled();

    await user.click(clear);
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
  });

  it('closes on Escape and on a press outside the track, through Popover', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <FilterBar count={0} onClear={() => {}}>
          <p>body</p>
        </FilterBar>
        <p>elsewhere</p>
      </div>
    );
    await user.click(filterButton());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(filterButton());
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('FilterBar — the sort control', () => {
  it('draws Sort: <key> (<dir>) from the chosen option’s label', () => {
    const { rerender } = render(
      <FilterBar count={0} onClear={() => {}} sort={sortProp({ key: 'created', dir: 'desc' })}>
        <p>body</p>
      </FilterBar>
    );
    expect(screen.getByText(/^Sort:/)).toHaveTextContent('Sort: Created (desc)');

    rerender(
      <FilterBar count={0} onClear={() => {}} sort={sortProp({ key: 'name', dir: 'asc' })}>
        <p>body</p>
      </FilterBar>
    );
    expect(screen.getByText(/^Sort:/)).toHaveTextContent('Sort: Name (asc)');

    rerender(
      <FilterBar count={0} onClear={() => {}} sort={sortProp({ key: 'project', dir: 'asc' })}>
        <p>body</p>
      </FilterBar>
    );
    expect(screen.getByText(/^Sort:/)).toHaveTextContent('Sort: Project (asc)');
  });

  it('opens a dialog named Sort by with three rows, the chosen one pressed, a Direction switch and the foot line', async () => {
    const user = userEvent.setup();
    render(
      <FilterBar count={0} onClear={() => {}} sort={sortProp({ key: 'name', dir: 'desc' })}>
        <p>body</p>
      </FilterBar>
    );
    expect(sortButton()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(sortButton()).toHaveAttribute('aria-expanded', 'false');

    await user.click(sortButton());
    expect(sortButton()).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'Sort by' });

    // Each row's name is its bare label — the hint is visible text beside it, not part of the name — so these are exact-string lookups.
    expect(within(dialog).getByRole('button', { name: 'Created' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(dialog).getByRole('button', { name: 'Name' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'false');
    for (const hint of ['when it was filed', 'title, A–Z', 'grouped by repo']) expect(within(dialog).getByText(hint)).toBeInTheDocument();

    const direction = within(dialog).getByRole('group', { name: 'Direction' });
    expect(within(direction).getByRole('button', { name: 'Ascending' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(direction).getByRole('button', { name: 'Descending' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('Live cards always sort first, whatever the order.')).toBeInTheDocument();
  });

  it('a row calls onKey with its value and Ascending calls onDir; neither closes the popover', async () => {
    const user = userEvent.setup();
    const sort = sortProp({ key: 'created', dir: 'desc' });
    render(
      <FilterBar count={0} onClear={() => {}} sort={sort}>
        <p>body</p>
      </FilterBar>
    );
    await user.click(sortButton());
    const dialog = screen.getByRole('dialog', { name: 'Sort by' });

    await user.click(within(dialog).getByRole('button', { name: 'Project' }));
    expect(sort.onKey).toHaveBeenCalledTimes(1);
    expect(sort.onKey).toHaveBeenCalledWith('project');
    expect(screen.getByRole('dialog', { name: 'Sort by' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Ascending' }));
    expect(sort.onDir).toHaveBeenCalledTimes(1);
    expect(sort.onDir).toHaveBeenCalledWith('asc');
    expect(screen.getByRole('dialog', { name: 'Sort by' })).toBeInTheDocument();
  });

  it('one popover at a time, in either order', async () => {
    const user = userEvent.setup();
    render(
      <FilterBar count={0} onClear={() => {}} sort={sortProp()}>
        <p>body</p>
      </FilterBar>
    );
    await user.click(filterButton());
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['Filters']);

    await user.click(sortButton());
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['Sort by']);
    expect(filterButton()).toHaveAttribute('aria-expanded', 'false');
    expect(sortButton()).toHaveAttribute('aria-expanded', 'true');

    await user.click(filterButton());
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['Filters']);

    // The open one's own button closes it, and nothing is left open.
    await user.click(filterButton());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with no sort prop draws no sort button, no Sort: text and no divider', () => {
    const { container } = render(
      <FilterBar count={0} onClear={() => {}}>
        <p>body</p>
      </FilterBar>
    );
    expect(screen.queryByRole('button', { name: 'Change sort' })).toBeNull();
    expect(screen.queryByText(/Sort:/)).toBeNull();
    expect(container.querySelector('.filter-bar-sep')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('ProjectPicks', () => {
  const projects: RegistryProject[] = [
    { name: 'alpha', path: '/code/alpha', createdAt: '2026-01-01T00:00:00Z' },
    { name: 'beta', path: '/code/beta', createdAt: '2026-01-02T00:00:00Z' }
  ];
  const hues = buildProjectHues(projects);

  function picks(over: Partial<React.ComponentProps<typeof ProjectPicks>> = {}) {
    const onPick = jest.fn();
    const utils = render(<ProjectPicks projects={projects} value="all" allValue="all" hues={hues} onPick={onPick} {...over} />);
    return { onPick, ...utils };
  }

  it('draws All projects and one chip per project, in registry order, inside a group named Project', () => {
    picks();
    const group = screen.getByRole('group', { name: 'Project' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All projects', 'alpha', 'beta']);
  });

  it('presses All projects when value is the all value, and nothing else', () => {
    picks();
    expect(screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual(['All projects']);
  });

  it('presses the chip whose path equals value, and not All projects', () => {
    picks({ value: '/code/beta' });
    expect(screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual(['beta']);
  });

  it('reports the project’s PATH, and the all value for All projects', async () => {
    const user = userEvent.setup();
    const { onPick } = picks({ value: '/code/beta' });

    await user.click(screen.getByRole('button', { name: 'alpha' }));
    expect(onPick).toHaveBeenLastCalledWith('/code/alpha');
    await user.click(screen.getByRole('button', { name: 'All projects' }));
    expect(onPick).toHaveBeenLastCalledWith('all');
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it('two checkouts of one repo get two chips, each reporting its own path, and only the picked one is pressed', async () => {
    const user = userEvent.setup();
    const twins: RegistryProject[] = [
      { name: 'alpha', path: '/a/alpha', createdAt: '2026-01-01T00:00:00Z' },
      { name: 'alpha', path: '/b/alpha', createdAt: '2026-01-02T00:00:00Z' }
    ];
    const { onPick } = picks({ projects: twins, hues: buildProjectHues(twins), value: '/b/alpha' });

    const chips = screen.getAllByRole('button', { name: 'alpha' });
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true']);

    await user.click(chips[0]);
    expect(onPick).toHaveBeenLastCalledWith('/a/alpha');
    await user.click(chips[1]);
    expect(onPick).toHaveBeenLastCalledWith('/b/alpha');
  });

  it('draws each project’s hue dot, and none on All projects', () => {
    const { container } = picks();
    expect(screen.getByRole('button', { name: 'All projects' }).querySelector('.ui-dot')).toBeNull();
    for (const p of projects) {
      expect(screen.getByRole('button', { name: p.name }).querySelector('.ui-dot')).toHaveClass(`ui-dot-proj-${hues.hueFor(p.name)}`);
    }
    expect(container.querySelectorAll('.ui-dot')).toHaveLength(projects.length);
  });

  it('draws the hint after the heading only when given, and the group is still named exactly Project', () => {
    const { unmount } = picks();
    expect(screen.getByText('Project').parentElement).toHaveTextContent(/^Project$/);
    unmount();

    picks({ hint: '· one at a time — Orchestrate needs one' });
    const heading = screen.getByText('Project').parentElement as HTMLElement;
    expect(heading).toHaveTextContent('Project · one at a time — Orchestrate needs one');
    // The group is named from the title, not from the whole heading: a name that swallowed the hint would no longer match this exact string.
    expect(screen.getByRole('group', { name: 'Project' })).toBeInTheDocument();
  });
});

describe('FilterSection', () => {
  it('draws its title and its children, and no hint unless one is given', () => {
    const { container } = render(
      <FilterSection title="Status">
        <button type="button">child</button>
      </FilterSection>
    );
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'child' })).toBeInTheDocument();
    expect(container).toHaveTextContent(/^Statuschild$/);
  });

  it('draws the hint beside the title when given', () => {
    render(
      <FilterSection title="Status" hint="· none picked = all">
        <span>child</span>
      </FilterSection>
    );
    expect(screen.getByText('Status').parentElement).toHaveTextContent('Status · none picked = all');
  });

  it('adds its full-width class only when fill is set', () => {
    const { container, rerender } = render(
      <FilterSection title="Status" fill>
        <span>child</span>
      </FilterSection>
    );
    expect(container.firstElementChild).toHaveClass('filter-bar-section-fill');

    rerender(
      <FilterSection title="Status">
        <span>child</span>
      </FilterSection>
    );
    expect(container.firstElementChild).not.toHaveClass('filter-bar-section-fill');
  });
});

/**
 * No suite loads styles.css into jsdom, so the rules that make the track and the Status switch work are read off the source — the way `ui-popover.test.tsx`
 * reads the panel's. Comments are blanked first so a selector named inside one is never the "first block" `ruleBlock` finds.
 */
describe('FilterBar stylesheet rules', () => {
  const css = readStyles().replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  function declarations(body: string | null, label: string): Record<string, string> {
    expect({ label, found: body !== null }).toEqual({ label, found: true });
    const out: Record<string, string> = {};
    for (const decl of (body as string).split(';')) {
      const at = decl.indexOf(':');
      if (at === -1) continue;
      out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim().replace(/\s+/g, ' ');
    }
    return out;
  }
  const rule = (selector: string): Record<string, string> => declarations(ruleBlock(css, selector), selector);

  it('the wrapper is the panel’s positioning parent and keeps the track at the right of a wrapped line', () => {
    expect(rule('.filter-bar-wrap')).toMatchObject({ position: 'relative', 'margin-left': 'auto' });
  });

  it('the Status switch lays out full width from the section’s own class, its options flex: 1', () => {
    expect(rule('.filter-bar-section-fill [role="group"]')).toMatchObject({ display: 'flex' });
    // `nowrap` rides with `flex: 1`: without it `In progress` wraps onto two lines inside the 28 px pill (measured in a browser, 266 px content box).
    expect(rule('.filter-bar-section-fill [role="group"] button')).toMatchObject({ flex: '1', 'white-space': 'nowrap' });
  });

  it('the badge is 11 px, guard 3’s floor', () => {
    expect(rule('.filter-bar-badge')['font-size']).toBe('11px');
  });

  it('the sort label is drawn on desktop and not in the 700 px block', () => {
    expect(rule('.filter-bar-sortlab')['white-space']).toBe('nowrap');
    const phone = mediaBlocks(css, '@media (max-width: 700px)').filter((b) => b.includes('.filter-bar-sortlab'));
    expect(phone).toHaveLength(1);
    expect(declarations(ruleBlock(phone[0], '.filter-bar-sortlab'), '.filter-bar-sortlab (phone)')).toMatchObject({ display: 'none' });
  });
});
