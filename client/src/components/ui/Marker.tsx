import type { ReactNode } from 'react';

export type MarkerTone = 'groomed' | 'kind' | 'done' | 'stale' | 'untyped';

/**
 * Marker — the word on a card's marker row (.claude/DESIGN.md §8.3).
 *
 * A marker is not a pill: it carries no fill and no stroke, only a weight and
 * an ink, because the marker row is a line of several of them and four filled
 * pills in a row on a card the size of this one is a second card. `groomed` is
 * the only one that takes an accent; `kind` and `done` are `--ink3` and
 * `stale` is the one warning the row can carry.
 */
export function Marker({ children, tone }: { children: ReactNode; tone: MarkerTone }) {
  return <span className={`ui-marker ui-marker-${tone}`}>{children}</span>;
}
