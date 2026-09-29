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
 *
 * `title` is optional, and no marker passes one today: it existed for the `queued · stale` marker, which became the card's queued band
 * (`queuedStripFor`, ItemCard.tsx). Kept because it is the one way a marker whose word cannot say what to do about it names the way out, and a caller
 * that passes none renders no empty `title` attribute.
 */
export function Marker({ children, tone, title }: { children: ReactNode; tone: MarkerTone; title?: string }) {
  return (
    <span className={`ui-marker ui-marker-${tone}`} title={title}>
      {children}
    </span>
  );
}
