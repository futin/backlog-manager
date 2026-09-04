import { lastTouched } from '../client/src/lib/item-touched';
import type { BacklogItem } from '../shared/types';

function fakeItem(over: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'bug-1', title: 'a bug', created: '', started: '', updated: '',
    lastCommit: '', phase: '', groomElapsed: 0, executeElapsed: 0, groomTokens: 0, executeTokens: 0, kind: '', tags: [],
    section: 'bugs', status: 'open', project: 'alpha', projectPath: '/abs/alpha',
    groomed: false, path: '/abs/alpha/backlog/bugs/open/bug-1.md',
    ...over
  };
}

describe('lastTouched', () => {
  it('prefers updated over both fallbacks', () => {
    const item = fakeItem({ created: '2026-01-01', lastCommit: '2026-02-01T00:00:00+00:00', updated: '2026-03-01T00:00:00Z' });
    expect(lastTouched(item)).toBe('2026-03-01T00:00:00Z');
  });

  it('falls back to lastCommit when updated is absent', () => {
    const item = fakeItem({ created: '2026-01-01', lastCommit: '2026-02-01T00:00:00+00:00' });
    expect(lastTouched(item)).toBe('2026-02-01T00:00:00+00:00');
  });

  it('falls back to created when neither stamp is present', () => {
    expect(lastTouched(fakeItem({ created: '2026-01-01' }))).toBe('2026-01-01');
  });

  it('is empty when the item carries no stamp at all', () => {
    expect(lastTouched(fakeItem({}))).toBe('');
  });

  it('prefers a present-but-malformed stamp over a valid lower rung', () => {
    // Presence, not validity. The readers treat an unageable stamp as fresh,
    // which keeps a broken file on the Board instead of hiding it in Archive.
    const item = fakeItem({ created: '2026-01-01', lastCommit: '2026-02-01T00:00:00+00:00', updated: 'whenever' });
    expect(lastTouched(item)).toBe('whenever');
  });
});
