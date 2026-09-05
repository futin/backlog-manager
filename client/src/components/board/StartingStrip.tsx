import { elapsedSince } from '../../lib/item-age';
import { projectLabel } from '../../lib/project-label';
import type { StartingRun } from '../../../../shared/types';

/**
 * The placeholder row for a run this server has spawned but whose
 * `run.json` does not exist yet (task-14) — `RunStrip`'s smaller sibling,
 * rendered in the same `.run-strips` stack and wearing the same frame so a
 * run's first minute reads as a continuation of the board rather than as a
 * different kind of thing appearing.
 *
 * It exists because `GET /api/orchestrator/runs` cannot see a run before
 * `orchestrate.mjs init` writes it (SKILL.md §2), which is 1–5 minutes after
 * the click: the dashboard spawn, the session boot, a 1360-line SKILL.md
 * read and the §1 `plan` turn. For that whole stretch the board previously
 * showed nothing at all, which is indistinguishable from a click that
 * silently failed.
 *
 * **No progress bar and no percentage, deliberately.** `RunStrip`'s own
 * `.run-strip-bar` answers "how much of the queue has merged", and there is
 * no queue yet — a 0%-filled bar reads as a run that is stalled at its first
 * item, which is a worse lie than the honest absence of one. For the same
 * reason there is no count, no stage chip and no item id: everything a run
 * strip normally says comes off the run file, and the whole point of this
 * component is the window in which that file does not exist. The only two
 * facts available are which project was asked and how long ago, so those are
 * the only two it prints.
 *
 * Not a `<button>` and not clickable, unlike both of `RunStrip`'s shapes:
 * there is no run to open a drawer onto. A non-interactive `<div>` is the
 * honest element for a row with nothing to activate — making it focusable
 * to look consistent would put a control in the tab order that does nothing
 * when a keyboard user reaches it.
 */
export function StartingStrip({ starting, now }: { starting: StartingRun; now?: number }): JSX.Element {
  const label = projectLabel(starting.project);
  // The same ladder the card's in-progress bar and the crashed strip's
  // heartbeat both read off, so "now"/"2m" means the same thing everywhere
  // on this board. `null` (an unparseable or future stamp — see
  // `elapsedSince`) prints an em dash rather than `NaNm`, matching the fresh
  // strip's own `age ?? '—'` fallback; `now` is threaded through for the
  // tests that need a fixed clock.
  const age = elapsedSince(starting.requestedAt, now);

  return (
    <div className="run-strip run-strip-starting" data-testid="starting-strip">
      {/* Dotted rather than filled, and never the cyan `.run-strip-dot-live`
          the fresh strip uses: this run is not heartbeating, because it has
          not started reporting yet. aria-hidden for the same reason the
          fresh strip's dot is — the words beside it carry the fact. */}
      <span className="run-strip-dot run-strip-dot-starting" aria-hidden="true" />
      <span className="run-strip-project">{label}</span>
      <span className="run-strip-starting-label">starting…</span>
      <span className="run-strip-heartbeat">{age ?? '—'}</span>
    </div>
  );
}
