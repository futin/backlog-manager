/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { ItemDrawer } from '../client/src/components/board/ItemDrawer';
import { buildProjectHues } from '../client/src/lib/project-hue';
import type { BacklogItem } from '../shared/types';

const ITEM: BacklogItem = {
  id: 'bug-2', title: 'groomed bug', created: '2026-08-20', tags: ['ui'],
  updated: '', phase: '', groomElapsed: 0, executeElapsed: 0,
  section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
  groomed: true, started: '', path: '/abs/alpha/backlog/bugs/open/bug-2-groomed-bug.md'
};

/* The drawer renders whatever assignment the board hands it, so the suite
   builds one from a one-project registry rather than hard-coding a class —
   which keeps this test about the drawer and leaves the hue arithmetic to
   test/project-hue.test.ts. */
const HUES = buildProjectHues([
  { name: 'alpha', path: '/abs/alpha', createdAt: '2026-08-26T00:00:00.000Z' }
]);

describe('ItemDrawer', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('## Cause\n\noff by one\n') } as Response)
    ) as jest.Mock;
  });

  // The card has room only for an elapsed reading; the drawer is where the
  // stored value belongs, since "in progress 47d" invites the follow-up question
  // "since when" and the answer is right there in the file. It prints BOTH: the
  // elapsed for reading, the raw value because that is what is on disk.
  it('names the moment an in-progress item was picked up, and says nothing when it was not', async () => {
    const { unmount } = render(
      <ItemDrawer item={{ ...ITEM, started: '2026-08-24' }} hues={HUES} onClose={() => {}} />
    );
    expect(screen.getByText(/in progress \d+d \(since 2026-08-24\)/)).toBeInTheDocument();
    unmount();

    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    expect(screen.queryByText(/in progress/)).not.toBeInTheDocument();
    // The first render was unmounted, so its `alive` flag swallowed its own
    // resolution; this second one is still mounted and its body fetch lands
    // either way, which is an un-acted state update unless the test waits for
    // it. Same reason as the two cases below.
    await screen.findByText('off by one');
  });

  // A timestamped value reads to the hour or minute, and the parenthetical
  // carries it verbatim — the drawer is the one surface with room to be exact,
  // and someone reconciling a card against the file needs the exact bytes.
  it('reads a timestamped start to the hour and still prints the stored value', async () => {
    const threeHoursAgo = `${new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 19)}Z`;
    render(<ItemDrawer item={{ ...ITEM, started: threeHoursAgo }} hues={HUES} onClose={() => {}} />);

    expect(screen.getByText(`bug-2 · 2026-08-20 · ◍ in progress 3h (since ${threeHoursAgo}) · ui`))
      .toBeInTheDocument();
    await screen.findByText('off by one');
  });

  /**
   * The accumulated buckets are history, not a live-only reading: unlike the
   * "in progress" segment above, which is gated on `isInProgress`, these are
   * not gated on status at all. `move` never rewrites an item's content, so a
   * done item's groomed/executed seconds are exactly as true after archiving
   * as before — the drawer is where that kind of history belongs, same
   * reasoning as the verbatim `started` value beside it. Each bucket is
   * independent (an item can carry both, either, or neither) and a zero
   * bucket renders nothing rather than "groomed for 0s", since `0` is also
   * what an item that was never groomed carries — there is nothing true to
   * say about it.
   */
  describe('accumulated time', () => {
    it('shows "groomed for" with the formatted total, and hides "worked for" when execute is zero', async () => {
      render(
        <ItemDrawer
          item={{ ...ITEM, groomElapsed: 3660, executeElapsed: 0 }}
          hues={HUES}
          onClose={() => {}}
        />
      );
      expect(screen.getByText(/groomed for 1h 1m/)).toBeInTheDocument();
      expect(screen.queryByText(/worked for/)).not.toBeInTheDocument();
      await screen.findByText('off by one');
    });

    it('shows neither bucket when both are zero', async () => {
      render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
      expect(screen.queryByText(/groomed for/)).not.toBeInTheDocument();
      expect(screen.queryByText(/worked for/)).not.toBeInTheDocument();
      await screen.findByText('off by one');
    });

    // The regression guard for the "history, not live-only" claim above: this
    // item is done, and rendering nothing here at all would be the bug the
    // isInProgress-gated segment already correctly opts out of for a done
    // item — this bucket must not inherit that gate by accident.
    it('shows accumulated execute time on a done item, not gated behind in-progress', async () => {
      render(
        <ItemDrawer
          item={{ ...ITEM, status: 'done', executeElapsed: 90 }}
          hues={HUES}
          onClose={() => {}}
        />
      );
      expect(screen.getByText(/worked for 1m/)).toBeInTheDocument();
      await screen.findByText('off by one');
    });
  });

  it('fetches the body by path and renders the markdown', async () => {
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/items/body?path=${encodeURIComponent(ITEM.path)}`
    );
    await waitFor(() => expect(screen.getByText('Cause')).toBeInTheDocument());
    expect(screen.getByText('off by one')).toBeInTheDocument();
  });

  it('shows the item meta: project pill, id, created, path', async () => {
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'groomed bug' })).toBeInTheDocument();
    expect(screen.getByText('alpha')).toHaveClass('pill', HUES.classFor('alpha'));
    expect(screen.getByText(/bug-2 · 2026-08-20/)).toBeInTheDocument();
    expect(screen.getByText(ITEM.path)).toBeInTheDocument();
    // Lets the mocked fetch's state update land inside act() before the test
    // ends — otherwise React logs an act() warning on every run because
    // nothing above this line waits on the body fetch this component always
    // fires on mount.
    await screen.findByText('off by one');
  });

  it('closes on Escape, on the close button, and on the backdrop', async () => {
    const onClose = jest.fn();
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={onClose} />);
    // Same reason as the case above: the mount fetch resolves whether or not
    // this test cares about the body, and letting it land after the last
    // assertion is an un-acted state update React warns about. It was the one
    // remaining act() warning in the suite.
    await screen.findByText('off by one');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await userEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('shows an unavailable state when the body fetch fails', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: false, status: 404 } as Response)
    );
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('item file unavailable')).toBeInTheDocument());
  });

  it('drops raw HTML instead of passing it to dangerouslySetInnerHTML', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('safe text\n\n<img src=x onerror="window.__pwned=1">')
      } as Response)
    );
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
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
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
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
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
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
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
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
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
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
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
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
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
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
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector('.drawer-body img')).not.toBeNull());
    const img = document.querySelector('.drawer-body img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('./diagram.png');
    expect(img.getAttribute('alt')).toBe('diagram');
  });

  // Round 3: a protocol-relative src (`//host/...`) has no `scheme:` for
  // isDisallowedScheme to match, so it read as "relative" and slipped past
  // the round-2 image guard — a real third-party fetch (leaking the
  // viewer's IP/UA/referrer) from a board whose own comments say it only
  // ever talks to its own origin. `/\host` and reference-definition forms
  // reach the same renderer the same way; a browser treats `\` the same as
  // `/` in a URL, and marked resolves a `[x][r]` / `[r]: <src>` reference
  // before the renderer ever runs.
  it.each([
    ['protocol-relative', '![logo](//evil.example/p.png)'],
    ['backslash variant of protocol-relative', '![logo](/\\evil.example/p.png)'],
    ['reference-definition form', '![logo][r]\n\n[r]: //evil.example/p.png\n']
  ])('never requests a protocol-relative image src — %s', async (_desc, body) => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(body) } as Response)
    );
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText('loading…')).not.toBeInTheDocument());
    // No <img> at all — same fallback as the scheme-based cases above, and
    // for the same reason: there is no safe src to neutralize this src down
    // to, so it renders as its alt text instead.
    expect(document.querySelector('.drawer-body img')).not.toBeInTheDocument();
  });

  it('still renders an absolute-path (single-slash) image as a real img tag', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('![diagram](/abs/path.png)')
      } as Response)
    );
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector('.drawer-body img')).not.toBeNull());
    const img = document.querySelector('.drawer-body img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/abs/path.png');
  });

  // Round 4: whitespace *inside* the destination. `schemeOf` stripped it
  // before sniffing a scheme; the protocol-relative check did not, so it saw
  // "starts with a tab, not a slash" and let the src through — and the URL
  // parser then deleted the tab and fetched from evil.example. Both guards
  // are now one `classifyTarget`, so there is a single normalization to get
  // right. Characters that matter are built by code point rather than written
  // as escapes, so the vector in the source is unambiguous.
  const TAB = String.fromCharCode(9);
  const FORM_FEED = String.fromCharCode(12);
  const C0_CONTROL = String.fromCharCode(1);

  it.each([
    ['leading space', '![logo](< //evil.example/p.png>)'],
    ['leading tab', `![logo](<${TAB}//evil.example/p.png>)`],
    ['leading tab, backslash spelling', `![logo](<${TAB}/\\evil.example/p.png>)`],
    ['leading tab, reference-definition form', `![logo][r]\n\n[r]: <${TAB}//evil.example/p.png>\n`],
    ['tab between the two slashes', `![logo](</${TAB}/evil.example/p.png>)`],
    ['leading form feed', `![logo](<${FORM_FEED}//evil.example/p.png>)`],
    ['leading C0 control', `![logo](<${C0_CONTROL}//evil.example/p.png>)`],
    ['leading tab, triple slash', `![logo](<${TAB}///evil.example/p.png>)`]
  ])('never requests an off-origin image src hidden behind whitespace — %s', async (_desc, body) => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(body) } as Response)
    );
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText('loading…')).not.toBeInTheDocument());
    const img = document.querySelector('.drawer-body img') as HTMLImageElement | null;
    // `.src` is the resolved property, not the attribute and not the HTML
    // string: only that form shows where the request would actually go. The
    // attribute still reads as a relative-looking path in every one of these,
    // which is exactly why a string check on the markup passes while the DOM
    // holds a live cross-origin fetch.
    expect(img?.src ?? '').not.toContain('evil.example');
    expect(img).not.toBeInTheDocument();
  });

  it('neutralizes a javascript: scheme split by whitespace', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(`[click](<java${TAB}script:alert(1)>)`)
      } as Response)
    );
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('click')).toBeInTheDocument());
    // Same normalization as the image cases above — a browser ignores the tab
    // when it sniffs the scheme, so the guard has to as well.
    expect(document.querySelector('.drawer-body a')).not.toBeInTheDocument();
  });

  it('still renders a nested relative image path as a real img tag', async () => {
    (global.fetch as jest.Mock).mockImplementation(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('![diagram](sub/dir/x.png)')
      } as Response)
    );
    render(<ItemDrawer item={ITEM} hues={HUES} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector('.drawer-body img')).not.toBeNull());
    const img = document.querySelector('.drawer-body img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('sub/dir/x.png');
    expect(new URL(img.src).origin).toBe(window.location.origin);
  });
});
