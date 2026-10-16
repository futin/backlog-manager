import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { disabledReason, gateView } from '../client/src/lib/gate-view';

/**
 * #272: `gateView` is the disabled half of the board's two re-asking gated controls, rendered by `GatedChip`. Pure, so it is pinned here under jest's
 * default `node` environment — the render and the click are `test/ui-gated-chip.test.tsx`'s.
 */
describe('gateView', () => {
  const GATE = 'dashboard does not list /p';
  const OTHER = 'held by a session';

  it('blocks nothing and re-asks nothing when no block speaks', () => {
    expect(gateView(null, null, true)).toEqual({ blocked: null, reverifiable: false });
  });

  it('re-asks a visibility block that speaks alone', () => {
    expect(gateView(GATE, null, true)).toEqual({ blocked: GATE, reverifiable: true });
  });

  it('cannot re-ask without a way to ask', () => {
    expect(gateView(GATE, null, false)).toEqual({ blocked: GATE, reverifiable: false });
  });

  // The rule the Orchestrate chip used to break (#272 step 0): a second block makes the re-ask pointless, and the gate's reason still outranks it.
  it('shows the visibility block over any other, and re-asks neither', () => {
    expect(gateView(GATE, OTHER, true)).toEqual({ blocked: GATE, reverifiable: false });
  });

  it('never re-asks a block a status refetch cannot move', () => {
    expect(gateView(null, OTHER, true)).toEqual({ blocked: OTHER, reverifiable: false });
  });
});

describe('disabledReason', () => {
  it('is the reason of a disabling gate and null for every other', () => {
    expect(disabledReason({ control: 'disabled', reason: 'r' })).toBe('r');
    expect(disabledReason({ control: 'hidden', reason: 'r' })).toBeNull();
    expect(disabledReason({ control: 'enabled' })).toBeNull();
    expect(disabledReason(null)).toBeNull();
  });
});

// The file header's claim, held: the model imports nothing that would need a DOM to test.
it('imports nothing from React or components/', () => {
  const src = readFileSync(join(__dirname, '..', 'client/src/lib/gate-view.ts'), 'utf8');
  expect(src).not.toMatch(/from 'react'/);
  expect(src).not.toMatch(/from '[^']*components\//);
});
