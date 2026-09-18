import type { MergeMode } from '../../../shared/types';

/**
 * merge-mode.ts — the words the merge-mode PICKER puts on its two options
 * (design §2.2), on both surfaces that draw one: the Orchestrate sheet's
 * per-launch control and Settings' default.
 *
 * Each label names the OUTCOME a successful run ends in, never the flag a
 * caller would type — "why would I pick 'branch'" is a worse question for
 * this control to answer than "why would I pick 'leave branches for me'".
 * A `Record<MergeMode, string>` return type rather than an ordered pair of
 * literals, for the same reason `isMergeMode` is a guard rather than an
 * inline comparison chain (shared/agent.ts): the compiler refuses to build
 * this file the day `MergeMode` gains a third member and nobody has decided
 * what these controls call it. That reasoning came with the constant this
 * function replaces (`MERGE_MODE_LABELS`, formerly in `OrchestrateSheet.tsx`)
 * and survives the move intact — what did not survive was the constant's
 * SHAPE. A module-level record of static strings is evaluated once at import
 * time, so it can never vary with the base a sheet's picker is currently
 * sitting on, and after task-44 made the base run-scoped that is exactly
 * what the `merge` label has to do (bug-36: the picker read "Merge to main"
 * while the note directly beneath it correctly named a feature branch).
 *
 * `base` is `string | null`, and `null` means "no base is knowable at this
 * point" — never "main". Settings picks a DEFAULT, before any run and so
 * before any base exists; answering `main` there would reinstate this same
 * bug on the one surface that genuinely cannot know the destination, which
 * is why the base-less wording names the base branch as a role rather than
 * guessing which branch fills it.
 *
 * Not to be confused with `mergeModeLabel` (`lib/run-stage.ts`), whose name
 * is one character away: that one is the short BADGE word for a run that has
 * already started and whose mode may have been downgraded ('branch mode',
 * 'branch mode (downgraded)'). This one is the picker's option text, before
 * a run exists. Two near-homonyms in one `lib/` is how the next edit lands
 * in the wrong file, so each says so in its own doc comment.
 */
export function mergeModeOptionLabels(base: string | null): Record<MergeMode, string> {
  return {
    merge: base === null ? 'Merge into the base branch' : `Merge to ${base}`,
    branch: 'Leave branches for me'
  };
}
