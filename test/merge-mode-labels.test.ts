import { mergeModeOptionLabels } from '../client/src/lib/merge-mode';

/*
 * bug-36. The merge-mode picker's option words, which used to be a module-level
 * constant inside `OrchestrateSheet.tsx` and so could not vary with the base the
 * sheet's picker was sitting on. The whole point of the function these cases
 * cover is that `merge`'s label is a function of the destination, so the cases
 * are mostly "same call, different base" — and the one that matters most is the
 * `null` one, since that is the surface (Settings) that genuinely cannot know a
 * base and must therefore not be told `main`.
 *
 * A file of its own rather than more cases in `test/merge-mode.test.ts`: that
 * suite drives `POST /api/agents/orchestrate` through supertest and shares only
 * the words "merge mode" with this one. Plain jest, no jsdom — the function is
 * pure and renders nothing.
 */
describe('mergeModeOptionLabels', () => {
  it("names main as the destination when main is the base", () => {
    // The commonest run, and the string the sheet showed before this bug was
    // filed — pinned so the fix cannot be read as a regression for the base
    // that was always correct.
    expect(mergeModeOptionLabels('main').merge).toBe('Merge to main');
  });

  it('names whatever branch the base actually is', () => {
    // The case that was impossible to state before: the label is derived, so a
    // base two fields away on the same screen reaches it.
    expect(mergeModeOptionLabels('feature/tracker-backed').merge).toBe('Merge to feature/tracker-backed');
  });

  it('says "the base branch" — never "main" — when no base is knowable', () => {
    // Settings picks a DEFAULT, before any run and therefore before any base
    // exists. `null` means exactly that, and the wrong answer here is the whole
    // of bug-36: a surface that cannot know the destination must not name one.
    expect(mergeModeOptionLabels(null).merge).toBe('Merge into the base branch');
    expect(mergeModeOptionLabels(null).merge).not.toBe('Merge to main');
  });

  it('leaves the branch-mode label alone for every base', () => {
    // Branch mode's outcome does not mention a destination — it stops before
    // one — so the base must not reach it. Asserted for all three inputs
    // because "I derived one label and accidentally derived both" is the
    // plausible way to get this wrong.
    expect(mergeModeOptionLabels('main').branch).toBe('Leave branches for me');
    expect(mergeModeOptionLabels('feature/tracker-backed').branch).toBe('Leave branches for me');
    expect(mergeModeOptionLabels(null).branch).toBe('Leave branches for me');
  });
});
