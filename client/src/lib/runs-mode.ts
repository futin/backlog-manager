/**
 * runs-mode.ts — the Runs section's one view switch (task-18): its history,
 * or the watchdog that watches its live runs.
 *
 * Pure, with no React in it, for the same reason `lib/run-range.ts` is: the
 * guard is the interesting part and it should be testable without rendering
 * a section. It is a `lib/` module rather than an export from `RunsView`
 * because the persisted key and the guard describe the STORED value, and a
 * test that pins "a stored `banana` opens on Runs" should not have to import
 * a lazy-loaded section to state the key it is writing.
 *
 * PERSISTED, unlike the range control and the project filter sitting beside
 * it in the same bar — both of which carry a comment saying explicitly that
 * they are not. That is not an inconsistency, it is the distinction: those
 * two SCOPE one corpus, so restoring them silently reopens the section
 * showing a subset of what is there, with nothing on screen naming the
 * subset. Mode picks which of two surfaces the section is, the control
 * naming that choice is always visible, and a person who left on Watchdog
 * while a run was live wants to come back to it. Section-like, so it
 * persists like the section key does — through a guard, for the same reason
 * `resolveSection` has one.
 */

export type RunsMode = 'runs' | 'watchdog';

/** Declaration order is render order in the segmented control. */
export const RUNS_MODES: readonly RunsMode[] = ['runs', 'watchdog'];

export const RUNS_MODE_KEY = 'backlog-manager.runs-mode';

/** The button label for each mode — stated here so the control renders off
 *  the same list the guard accepts, never a second hand-written pair. */
export const MODE_BUTTON: Record<RunsMode, string> = {
  runs: 'Runs',
  watchdog: 'Watchdog'
};

/**
 * Takes `unknown`, not `string`: `localStorage` round-trips through
 * `JSON.parse`, so a stored value can come back as a number, an object or
 * `null` just as easily as a word this union never had.
 */
export function isRunsMode(v: unknown): v is RunsMode {
  return typeof v === 'string' && (RUNS_MODES as readonly string[]).includes(v);
}
