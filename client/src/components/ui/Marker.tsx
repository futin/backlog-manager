import type { ReactNode } from 'react';

export type MarkerTone = 'groomed' | 'kind' | 'done' | 'stale' | 'untyped' | 'machine';

/**
 * Marker — the word on a card's marker row (.claude/DESIGN.md §8.3).
 *
 * A marker is not a pill: it carries no fill and no stroke, only a weight and
 * an ink, because the marker row is a line of several of them and four filled
 * pills in a row on a card the size of this one is a second card. `groomed` is
 * the only one that takes an accent; `kind` and `done` are `--ink3` and
 * `stale` is the one warning the row can carry.
 *
 * `machine` is multi-dashboard task 10's reading of WHERE a card's work is: `running on Pro` for a live claim a remote holds, `Starting on Pro` for a launch
 * sent there that has not claimed yet. `--ink3` like `kind`: it names a place, not a problem, so it takes no warning ink and no accent.
 *
 * `title` is optional. It existed first for the `queued · stale` marker, which became the card's queued band (`queuedStripFor`, lib/live-bar.ts), and later
 * carried the Jira card's F1 `N matches` keys until the parent lanes retired that marker (parent-lanes spec §6.2: filters match per issue, so no card is
 * shown for another's match). Any `CardMarker` may still pass one; a caller that passes none renders no empty `title` attribute.
 */
export function Marker({ children, tone, title }: { children: ReactNode; tone: MarkerTone; title?: string }) {
  return (
    <span className={`ui-marker ui-marker-${tone}`} title={title}>
      {children}
    </span>
  );
}
