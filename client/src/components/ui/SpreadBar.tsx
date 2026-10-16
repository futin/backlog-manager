import { progressLine } from '../../lib/jira';

/**
 * SpreadBar — the card-scale spread bar (.claude/DESIGN.md §3's spread-bar line, §8.9.1; grouped-board spec §4 and §6).
 *
 * How far along the issues folded under a Jira card are: a 4 px track of up to three segments — done in `--fill-progress`, in progress in `--fill-live`,
 * to do in `--ink3` — with 2 px gaps, and an optional 12 px `--ink3` caption under it (`progressLine`'s words). The card's fold block and the issue modal's
 * Children head both draw it, which is why it lives here and not in either (CLAUDE.md: a look two surfaces draw has one home in `components/ui/`).
 *
 * **Why not `ProgressRow`.** That is §7's progress row — ONE fill over a `--steel` track at 10 px, a quantity against a budget. This is three quantities
 * side by side at card scale with no remainder: a spread, not a fill. Bending `ProgressRow` into segments would give every meter on the board a mode it
 * never uses.
 *
 * Each segment is drawn only when its count is not zero, and grows by its count (`flex-grow`), so a zero never leaves a double gap and the bar needs no
 * arithmetic of its own; with all three at zero nothing is rendered at all. The segments are decoration — the track is `role="img"` and its accessible name
 * is the caption, or without one the same words, so a reader who never sees the bar still hears it. No text inside the bar.
 */
export function SpreadBar({ done, doing, todo, caption }: { done: number; doing: number; todo: number; caption?: string | null }) {
  const label = caption ?? progressLine({ done, doing, todo });
  if (label === null || done + doing + todo === 0) return null;
  const segments = [
    { key: 'done', n: done },
    { key: 'doing', n: doing },
    { key: 'todo', n: todo }
  ].filter((s) => s.n > 0);

  return (
    <div className="ui-spread">
      <div className="ui-spread-track" role="img" aria-label={label}>
        {segments.map((s) => (
          <span key={s.key} className={`ui-spread-seg ui-spread-${s.key}`} style={{ flexGrow: s.n }} />
        ))}
      </div>
      {caption != null && <div className="ui-spread-caption">{caption}</div>}
    </div>
  );
}
