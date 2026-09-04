import { projectLabel } from '../client/src/lib/project-label';

/**
 * The tail `RunStrip`, `RunDrawer` and `RunsView` print in place of a run's
 * bare `OrchestratorRun.project` path. All three callers pass exactly that
 * field — a registry absolute path, written on a POSIX host by
 * `backlog.mjs` — which is why nothing below covers a Windows separator or a
 * relative path. That omission is deliberate, not an oversight: adding a
 * backslash-separator branch would be hardening against an input no caller
 * can produce.
 */
describe('projectLabel', () => {
  it.each([
    // The doc comment's own example, asserted verbatim so the comment on
    // project-label.ts cannot drift away from the behaviour it describes.
    ['/Users/dev/code/example-app', 'example-app'],
    // A trailing separator is dropped by `filter(Boolean)` — it does not
    // produce an empty tail, and repeated separators go the same way.
    ['/Users/dev/code/example-app/', 'example-app'],
    ['/Users/dev/code/example-app//', 'example-app'],
    // No separator at all: the whole path is its own tail.
    ['example-app', 'example-app'],
    ['/single', 'single'],
    // Spaces and parentheses are not separators and must survive intact —
    // a registry path is whatever directory the user actually has.
    ['/Users/dev/code/my app (2)', 'my app (2)']
  ])('reads %s as %s', (path, expected) => {
    expect(projectLabel(path)).toBe(expected);
  });

  // The `?? path` fallback, and the reason it is not dead code: `''.split('/')`
  // is `['']`, which `filter(Boolean)` empties, so `pop()` is `undefined`. The
  // result is the empty string itself — not `undefined`, and not a placeholder
  // like "(unknown)" that a caller would then have to recognise.
  it('returns the empty string for an empty path, via the ?? fallback', () => {
    expect(projectLabel('')).toBe('');
  });

  // Same fallback reached a second way: `'/'` filters down to nothing too. This
  // is the only input for which the function is an identity — it returns the
  // path rather than a tail of it — which is why it gets its own assertion
  // instead of a table row.
  it('returns the path unchanged for a bare separator', () => {
    expect(projectLabel('/')).toBe('/');
  });
});
