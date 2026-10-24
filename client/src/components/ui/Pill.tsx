import type { ReactNode } from 'react';

export type PillTone = 'neutral' | 'live' | 'warn' | 'bad' | 'done';

/**
 * Pill — §1's status micro-label: 11/500 at a 999 px radius
 * (.claude/DESIGN.md §1's type scale, §4's `radius-full`).
 *
 * The count beside a column name, a run's mode, the stage word on a live strip,
 * `crashed`, `paused` and `uncommitted` are all this one shape. They are a
 * pill rather than a chip because nothing here is clickable: §7 gives the chip
 * a stroke and a pointer, and a pill only ever states a fact.
 *
 * Five tones and no more, each naming a reading rather than a colour —
 * `neutral` for a count, `live` for something running, `warn` for something
 * waiting on a person, `bad` for a failure, `done` for a finished thing — so a
 * palette swap moves the colour and never the meaning.
 *
 * `off` is NOT a sixth tone: it is a state any tone can be in, for a fact that
 * does not hold — a model a machine may not run, an effort it will not take.
 * The tone class stays on the element (the pill still names what it is a
 * reading OF) and `ui-pill-off` rides beside it, so the look that says "not
 * allowed" never has to be restated per tone and a palette swap still moves it.
 */
export function Pill({ children, tone = 'neutral', title, off = false }: { children: ReactNode; tone?: PillTone; title?: string; off?: boolean }) {
  return (
    <span className={`ui-pill ui-pill-${tone}${off ? ' ui-pill-off' : ''}`} title={title}>
      {children}
    </span>
  );
}
