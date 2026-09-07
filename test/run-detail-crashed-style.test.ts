import { readStyles, ruleBlock } from './helpers/css-rule';

/**
 * bug-29 gave the Runs detail pane a "last heartbeat … · every stage below is
 * last reported, not current" note for a crashed run. `run-detail.test.tsx`
 * proves the node renders and what it says; nothing there can prove it is
 * VISIBLE as the alert it is meant to be — the component suites never load the
 * stylesheet, and jsdom performs no layout, so an unstyled note would pass
 * every rendering assertion while reading on screen as one more quiet meta
 * line a person skims past. Which is precisely the failure the note exists to
 * prevent: this pane's stages now MOVE for a crashed run, so a reader who
 * misses this line reads all of them as current.
 *
 * So this guards the stylesheet's own text, the same way
 * `run-drawer-tail-style.test.ts` guards the verification tail's scroll box.
 */
const SELECTOR = '.run-detail-crashed';

describe('run detail crashed-note stylesheet rule', () => {
  const block = ruleBlock(readStyles(), SELECTOR);

  it('has a rule in client/src/styles.css', () => {
    expect(block).not.toBeNull();
    expect((block as string).trim()).not.toEqual('');
  });

  it('is boxed, so it reads as an alert rather than another meta line', () => {
    // The same treatment `.run-detail-mode-note` gets right beside it — a
    // background, a border and padding are what lift a line out of the pane's
    // ordinary prose register.
    expect(block).toContain('background:');
    expect(block).toContain('border:');
    expect(block).toContain('padding:');
  });

  it('carries the amber every other surface prints this verdict in', () => {
    // `.run-strip-crashed-label` (the Board strip) and the `crashed` status
    // badge (`runs-status-warn`, via `runStatusChip`) are both amber. One
    // colour for one verdict: a reader who learns what amber means on the
    // board should not have to learn it again here.
    expect(block).toContain('var(--amber)');
  });
});
