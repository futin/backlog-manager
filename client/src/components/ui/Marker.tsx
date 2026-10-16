import type { ReactNode } from 'react';

export type MarkerTone = 'groomed' | 'kind' | 'done' | 'stale' | 'untyped' | 'match';

/**
 * Marker — the word on a card's marker row (.claude/DESIGN.md §8.3).
 *
 * A marker is not a pill: it carries no fill and no stroke, only a weight and
 * an ink, because the marker row is a line of several of them and four filled
 * pills in a row on a card the size of this one is a second card. `groomed` is
 * the only one that takes an accent; `kind` and `done` are `--ink3` and
 * `stale` is the one warning the row can carry.
 *
 * `match` is the Jira card's F1 marker (grouped-board spec §5): `1 match: PAY-162` or `N matches`, on a top card shown only because an issue folded
 * under it matches the filter. Inked `--amber-text`, never bare `--amber` — it sits beside the card's amber ring, which already carries the hue, so the
 * word needs only to be legible on paper in every theme.
 *
 * `title` is optional. It existed first for the `queued · stale` marker, which became the card's queued band (`queuedStripFor`, ItemCard.tsx); today the
 * `match` marker passes one — past one match the word is a count and the keys travel in the title, since a card cannot hold a list. A caller that passes
 * none renders no empty `title` attribute.
 */
export function Marker({ children, tone, title }: { children: ReactNode; tone: MarkerTone; title?: string }) {
  return (
    <span className={`ui-marker ui-marker-${tone}`} title={title}>
      {children}
    </span>
  );
}
