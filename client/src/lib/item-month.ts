import { MONTHS } from './item-age';
import type { BacklogItem } from '../../../shared/types';

/**
 * item-month.ts — which month an item belongs to, and how a column's worth of
 * them is grouped under subheaders.
 *
 * Its own module beside item-age.ts, item-progress.ts and item-stale.ts, on
 * the same terms those three already keep: one question per file, delegating
 * rather than re-deriving. item-age.ts owns "how does a date read to a
 * person", item-stale.ts owns "is this age past the window", and this file
 * owns only "which calendar month is this, and what order do the months go
 * in".
 *
 * It exists for exactly one caller — Archive's columns (ArchiveView.tsx) —
 * and that is deliberate rather than premature: a column of six-week-old
 * items with no temporal structure is a list, not a view, and the grouping
 * rule is three separate decisions (which stamp, which order, where the
 * undated go) that a component would have inlined as three unexplained
 * comparisons.
 */

/**
 * The same permanent two-shape fork item-age.ts and item-stale.ts each
 * document: `start`/`stop` write a second-precision UTC timestamp, every file
 * stamped before they did carries a bare date, and nothing rewrites an
 * existing item's frontmatter. Both are on disk forever, so both are read.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The group an item with no usable stamp at all lands in. A real key rather
 *  than null, so every item has a group and none is silently dropped from a
 *  column — the failure the Board/Archive split exists to rule out, in
 *  miniature. */
export const UNDATED = '';

/**
 * The instant a stamp names, or null when it names none.
 *
 * A bare date is pinned to UTC midnight with the `T00:00:00Z` suffix
 * `daysSince` uses, and for the same reason: without it the string is parsed
 * in local time and an item filed on the 1st can group under the previous
 * month in Auckland and the correct one in London. A month heading two people
 * cannot agree on is worse than no heading.
 */
function stampMs(stamp: string): number | null {
  if (stamp === '') return null;
  const then = Date.parse(DATE_ONLY.test(stamp) ? `${stamp}T00:00:00Z` : stamp);
  return Number.isNaN(then) ? null : then;
}

/**
 * The stamp this item is grouped by: `updated` when it has one, `created`
 * otherwise.
 *
 * The same precedence and the same fallback `isStale` reads (item-stale.ts),
 * and it has to be the same one: Archive's contents are decided by that
 * predicate, so grouping them by a different date would sort a column by a
 * number nobody used to decide it was there.
 */
function groupStamp(item: BacklogItem): string {
  return item.updated !== '' ? item.updated : item.created;
}

/**
 * `YYYY-MM` for this item, or `UNDATED` when neither stamp is present or
 * parseable.
 *
 * A sortable key, not a label: `2026-08` compares lexicographically in
 * chronological order, which is what lets `groupByMonth` below order months
 * without parsing anything a second time. Rendering is `monthLabel`'s job.
 */
export function monthKey(item: BacklogItem): string {
  const ms = stampMs(groupStamp(item));
  if (ms === null) return UNDATED;
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, '0')}`;
}

/**
 * The subheader's words: `aug 2026`, or `undated`.
 *
 * The year is ALWAYS printed, unlike `formatCreated`, which drops a
 * current-year one as noise. The reasoning inverts here: a card's date sits
 * among forty other cards that are almost all this year, so the year is the
 * part that rarely varies — but a month heading's whole job is to separate one
 * group from the next, and an Archive column is exactly where two Augusts a
 * year apart end up adjacent. Two headings reading `aug` would present them as
 * one group that the cards underneath silently contradict.
 *
 * A key this function does not recognise (a malformed `YYYY-MM`, which
 * `monthKey` cannot actually produce) falls back to the key itself rather than
 * to a placeholder — same rule `formatCreated` keeps for an unparseable date:
 * showing what is actually there is what lets someone find it.
 */
export function monthLabel(key: string): string {
  if (key === UNDATED) return 'undated';
  const [year, month] = key.split('-');
  const name = MONTHS[Number(month) - 1];
  return name === undefined ? key : `${name} ${year}`;
}

export interface MonthGroup {
  /** The `YYYY-MM` sort key, or `UNDATED`. */
  key: string;
  /** What the subheader prints — `monthLabel(key)`. */
  label: string;
  items: BacklogItem[];
}

/**
 * One column's items, grouped under month subheaders, newest month first.
 *
 * Three ordering rules, and each one is a decision rather than a consequence:
 *
 * 1. **Newest month first.** Archive is read from the recent end — the thing
 *    that just went quiet is the thing most likely to come back.
 * 2. **`UNDATED` is always last**, and this is the rule the key's own sort
 *    order would get wrong: `''` sorts BEFORE every real key, so a plain
 *    descending sort would put the items nobody can date at the top of the
 *    column, above everything anyone can. It is pulled out and appended
 *    instead. An item with no usable stamp is a file to go and fix, not the
 *    headline.
 * 3. **Newest touched first within a group, tie-broken on `id`.** The
 *    tie-break is not decoration: every item in the `UNDATED` group ties by
 *    construction (they all have no stamp at all), so without it that group's
 *    order would be whatever order the fetch happened to return, which changes
 *    under the reader for no visible reason.
 *
 * Onto copies, never in place — the array belongs to the fetched index, the
 * same discipline `sortItems` keeps in BoardView.
 */
export function groupByMonth(items: BacklogItem[]): MonthGroup[] {
  const byKey = new Map<string, BacklogItem[]>();
  for (const item of items) {
    const key = monthKey(item);
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [item]);
    else bucket.push(item);
  }

  const keys = [...byKey.keys()].filter((k) => k !== UNDATED).sort((a, b) => b.localeCompare(a));
  if (byKey.has(UNDATED)) keys.push(UNDATED);

  return keys.map((key) => ({
    key,
    label: monthLabel(key),
    items: [...(byKey.get(key) ?? [])].sort((a, b) => {
      // -Infinity for an unstamped item so it sorts to the bottom of its own
      // group under the descending comparison, rather than NaN-scrambling it:
      // a comparator returning NaN leaves the array in an unspecified order,
      // which is the one thing rule 3 above exists to prevent.
      const at = stampMs(groupStamp(a)) ?? -Infinity;
      const bt = stampMs(groupStamp(b)) ?? -Infinity;
      return bt - at || a.id.localeCompare(b.id);
    })
  }));
}
