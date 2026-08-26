/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ItemDrawer } from '../client/src/components/board/ItemDrawer';
import type { BacklogItem } from '../shared/types';

const ITEM: BacklogItem = {
  id: 'bug-2', title: 'groomed bug', created: '2026-08-20', tags: ['ui'],
  section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
  groomed: true, path: '/abs/alpha/backlog/bugs/open/bug-2-groomed-bug.md'
};

describe('ItemDrawer', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('## Cause\n\noff by one\n') } as Response)
    ) as jest.Mock;
  });

  it('fetches the body by path and renders the markdown', async () => {
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/items/body?path=${encodeURIComponent(ITEM.path)}`
    );
    await waitFor(() => expect(screen.getByText('Cause')).toBeInTheDocument());
    expect(screen.getByText('off by one')).toBeInTheDocument();
  });

  it('shows the item meta: pill, project, created, path', async () => {
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'groomed bug' })).toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText(/alpha · 2026-08-20/)).toBeInTheDocument();
    expect(screen.getByText(ITEM.path)).toBeInTheDocument();
    // Lets the mocked fetch's state update land inside act() before the test
    // ends — otherwise React logs an act() warning on every run because
    // nothing above this line waits on the body fetch this component always
    // fires on mount.
    await screen.findByText('off by one');
  });

  it('closes on Escape, on the close button, and on the backdrop', async () => {
    const onClose = jest.fn();
    render(<ItemDrawer item={ITEM} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await userEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('shows an unavailable state when the body fetch fails', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: false, status: 404 } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('item file unavailable')).toBeInTheDocument());
  });

  it('drops raw HTML instead of passing it to dangerouslySetInnerHTML', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('safe text\n\n<img src=x onerror="window.__pwned=1">')
      } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('safe text')).toBeInTheDocument());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('.drawer-body')?.innerHTML).not.toContain('onerror');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('neutralizes a javascript: href instead of rendering it as a clickable link', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('[click](javascript:alert(1))')
      } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('click')).toBeInTheDocument());
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.querySelector('.drawer-body')?.innerHTML).not.toContain('javascript:');
  });

  // Round 2: a scheme hidden behind an HTML character reference reads as "no
  // scheme, therefore relative" to any check that runs before the entities
  // are decoded — which is every check that runs on marked's output, since
  // decoding only happens later, when dangerouslySetInnerHTML hands the
  // string to jsdom's (the browser's, in production) own HTML parser. That
  // is exactly why these assertions read the parsed DOM's `a.protocol`
  // rather than grepping the HTML string: the string form of every one of
  // these bodies never contains the literal substring "javascript:" even
  // when the rendered anchor is fully executable.
  it.each([
    ['decimal entity', '[click](&#106;avascript:alert(1))'],
    ['zero-padded decimal entity', '[click](&#0000106;avascript:alert(1))'],
    ['hex entity', '[click](&#x6A;avascript:alert(1))'],
    ['colon hidden as an entity', '[click](javascript&#58;alert(1))'],
    ['tab as a decimal entity', '[click](java&#9;script:alert(1))'],
    ['tab as a named entity', '[click](java&Tab;script:alert(1))'],
    ['newline as a named entity', '[click](java&NewLine;script:alert(1))'],
    ['reference-style definition', '[click][r]\n\n[r]: &#106;avascript:alert(1)\n']
  ])('neutralizes a javascript: scheme hidden behind an entity — %s', async (_desc, body) => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(body) } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('click')).toBeInTheDocument());
    const link = document.querySelector('.drawer-body a') as HTMLAnchorElement | null;
    // A real anchor still renders (the scheme check alone can't see through
    // the entity, same as before) — the fix is that escaping `&` when the
    // href is interpolated stops the browser from ever reconstituting the
    // entity into a `j`, a `:`, or a stripped-out tab, so whatever scheme
    // the parser resolves is never javascript:.
    expect(link).not.toBeNull();
    expect(link!.protocol).not.toBe('javascript:');
  });

  it('never requests a script-scheme image src', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('![logo](javascript:alert(1))')
      } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    // Waits on the loading state clearing rather than the alt text becoming
    // visible: alt text is only ever *visible* text in the disallowed-src
    // fallback this test is trying to prove exists — waiting on it directly
    // would make a pre-fix run (where the src renders as a real, invisible
    // <img alt> attribute) hang until timeout instead of failing cleanly.
    await waitFor(() => expect(screen.queryByText('loading…')).not.toBeInTheDocument());
    expect(document.querySelector('.drawer-body img')).not.toBeInTheDocument();
  });

  it('never requests a remote image src — this board only ever talks to its own origin', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('![logo](https://evil.example/tracker.gif)')
      } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText('loading…')).not.toBeInTheDocument());
    expect(document.querySelector('.drawer-body img')).not.toBeInTheDocument();
  });

  // The other half of the fix: none of the above should come at the cost of
  // ordinary Markdown. These exercise exactly the branch round 2 rewrote
  // (link/image now hand-build their tag instead of deferring to marked's
  // default), so a regression here would be silent otherwise.
  it.each([
    ['https:', '[docs](https://example.com/page)'],
    ['http:', '[docs](http://example.com/page)'],
    ['mailto:', '[docs](mailto:team@example.com)']
  ])('still renders an ordinary %s link as clickable', async (protocol, body) => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(body) } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument());
    const link = document.querySelector('.drawer-body a') as HTMLAnchorElement | null;
    expect(link?.protocol).toBe(protocol);
  });

  it.each([
    ['relative', '[docs](./other.md)', './other.md'],
    ['anchor', '[docs](#section)', '#section']
  ])('still renders an ordinary %s link with its href intact', async (_kind, body, href) => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(body) } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument());
    const link = document.querySelector('.drawer-body a');
    expect(link?.getAttribute('href')).toBe(href);
  });

  it('still renders a relative image as a real img tag', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('![diagram](./diagram.png)')
      } as Response)
    );
    render(<ItemDrawer item={ITEM} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector('.drawer-body img')).not.toBeNull());
    const img = document.querySelector('.drawer-body img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('./diagram.png');
    expect(img.getAttribute('alt')).toBe('diagram');
  });
});
