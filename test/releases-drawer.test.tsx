/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ReleasesDrawer } from '../client/src/components/ReleasesDrawer';
import { Drawer } from '../client/src/components/ui/Drawer';
import { formatReleaseDate } from '../client/src/lib/releases';
import type { ReleasesResponse } from '../shared/types';

/*
  The What's new drawer (DESIGN.md §8.10) over `ui/Drawer` (§8.7's third overlay shape). The data is `test/api-releases.test.ts`'s populated fixture as the
  route answers it, with `0.2.0`'s notes given a `### Sub` line so the markdown path is visible, and `0.2.1` without a `url` — what an origin that is not
  GitHub gives.
*/

const DATA: ReleasesResponse = {
  current: { version: '0.2.1', ahead: 0 },
  releases: [
    { version: '0.2.1', date: '2026-10-16T12:00:00+00:00', title: 'fix(api)!: tighten', type: 'fix', scope: 'api', pr: 13, breaking: true, notes: '' },
    {
      version: '0.2.0',
      date: '2026-10-15T12:00:00+00:00',
      title: 'feat(releases): version chip',
      type: 'feat',
      scope: 'releases',
      pr: 12,
      url: 'https://github.com/futin/backlog-manager/pull/12',
      breaking: false,
      notes: '- Shows the running version\n\n### Sub'
    },
    { version: '0.1.0', date: '2026-10-14T12:00:00+00:00', title: 'Baseline — versioning starts here', type: 'baseline', breaking: false, notes: '' }
  ]
};

function entry(version: string): HTMLElement {
  return screen.getByTestId(`release-${version}`);
}

describe('Drawer', () => {
  it('is a named dialog, and the scrim, the ✕ and Escape each call onClose', async () => {
    const onClose = jest.fn();
    render(
      <Drawer label="Panel" onClose={onClose}>
        <p>inside</p>
      </Drawer>
    );
    const dialog = screen.getByRole('dialog', { name: 'Panel' });
    expect(within(dialog).getByText('inside')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(document.querySelector('.ui-drawer-scrim') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not close on a click inside the panel', async () => {
    const onClose = jest.fn();
    render(
      <Drawer label="Panel" onClose={onClose}>
        <p>inside</p>
      </Drawer>
    );
    await userEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ReleasesDrawer', () => {
  it("is headed What's new and lists every release in the order given, each with its date", () => {
    render(<ReleasesDrawer data={DATA} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: "What's new" });
    expect(within(dialog).getByRole('heading', { name: "What's new" })).toBeInTheDocument();
    const order = Array.from(dialog.querySelectorAll('[data-testid^="release-"]')).map((n) => n.getAttribute('data-testid'));
    expect(order).toEqual(['release-0.2.1', 'release-0.2.0', 'release-0.1.0']);
    for (const r of DATA.releases) expect(within(entry(r.version)).getByText(formatReleaseDate(r.date), { exact: false })).toBeInTheDocument();
  });

  it('draws a feature with its badge, its title without the prefix, its notes as markdown and its PR link', () => {
    render(<ReleasesDrawer data={DATA} onClose={() => {}} />);
    const e = entry('0.2.0');
    expect(within(e).getByText('Feature')).toBeInTheDocument();
    expect(within(e).getByText('version chip')).toBeInTheDocument();
    expect(within(e).queryByText('feat(releases): version chip')).not.toBeInTheDocument();
    expect(within(e).getByText('Shows the running version').closest('li')).not.toBeNull();
    expect(within(e).getByRole('heading', { level: 3, name: 'Sub' })).toBeInTheDocument();
    const link = within(e).getByRole('link', { name: 'PR #12' });
    expect(link).toHaveAttribute('href', 'https://github.com/futin/backlog-manager/pull/12');
  });

  it('draws Breaking as a badge of its own, no notes element for empty notes, and no link without a url', () => {
    render(<ReleasesDrawer data={DATA} onClose={() => {}} />);
    const e = entry('0.2.1');
    expect(within(e).getByText('Fix')).toBeInTheDocument();
    expect(within(e).getByText('Breaking')).toBeInTheDocument();
    expect(within(e).getByText('Fix')).not.toBe(within(e).getByText('Breaking'));
    expect(e.querySelector('.releases-notes')).toBeNull();
    expect(within(e).queryByRole('link')).not.toBeInTheDocument();
  });

  it('draws the baseline as where versioning starts, with no badge', () => {
    render(<ReleasesDrawer data={DATA} onClose={() => {}} />);
    const e = entry('0.1.0');
    expect(within(e).getByText('Versioning starts here · v0.1.0')).toBeInTheDocument();
    expect(e.querySelector('.releases-badge')).toBeNull();
  });
});
