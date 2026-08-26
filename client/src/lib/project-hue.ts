/**
 * The pill's colour, keyed on the project rather than on the item's type.
 *
 * Two things have to hold at once, and neither alone is enough.
 *
 * STATIC. A project wears the same colour on every render, every reload, and
 * for as long as it stays registered — a colour that shuffled when a new
 * project appeared would be worse than no colour, because the eye would have
 * learned the old one. There is no colour field to store anywhere (the
 * registry has exactly one writer, and it is a skill, not this app), so the
 * colour is derived.
 *
 * DISTINCT. Deriving it from a hash alone is not enough: eight buckets and
 * five projects collide about three times in four, and the very first real
 * registry this ran against put guide-manager and claude-agents-dashboard on
 * the same hue. A colour two projects share is a colour that has to be
 * double-checked against the text, which is the entire cost the feature was
 * meant to remove.
 *
 * So: the hash picks a project's *preference*, and `buildProjectHues` hands
 * out the actual hues in registration order, giving each project its
 * preference when free and the next free hue when not. That keeps both
 * properties as long as the registry only grows — which is the case, because
 * `registerProject` in skills/backlog/tools/backlog.mjs upserts by path and
 * never removes, so an existing project is always assigned before any project
 * registered after it and can never be displaced by one. Hand-deleting a line
 * out of registry.json can still shift the projects registered after it; that
 * is the one way to move a colour, and it is not a thing the tooling does.
 *
 * Keyed on the display NAME and not on projectPath, even though the path is
 * the board's stable identity elsewhere (two checkouts of one repo share a
 * name but never a path). The pill shows the name, so hashing anything else
 * would let two pills both read "alpha" in different colours, which looks like
 * a bug rather than a distinction.
 */

import type { RegistryProject } from '../../../shared/types';

/**
 * How many --proj-N tokens each theme block in shared/theme.css defines.
 *
 * Set by what the eye can actually separate, not by how many projects a
 * registry might hold: past roughly eight, outline pills at 9px stop being
 * tellable apart at a glance and a bigger palette buys nothing. A ninth
 * project therefore shares a hue with an earlier one — it falls back to its
 * raw hash preference — and the pill's text carries it from there.
 *
 * Raising it means adding that many tokens to all five theme blocks and the
 * matching .pill-proj-N rules in client/src/styles.css; test/project-hue.test.ts
 * checks the first half of that and will fail loudly on the second.
 */
export const PROJECT_HUES = 8;

/**
 * FNV-1a, 32-bit. A named, fully specified hash rather than a hand-rolled
 * `charCode * 31` sum because the output is user-visible and long-lived: once
 * a project is violet on this board it should stay violet, so the function
 * that decides it is one whose behaviour is pinned by test/project-hue.test.ts
 * rather than one anybody would feel free to "tidy". Math.imul keeps the
 * multiply in 32-bit integer space — a plain `*` overflows into a double at
 * the third character and the result stops being FNV at all.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 before the modulo: Math.imul yields a SIGNED 32-bit int, and a
  // negative % 8 is negative in JS, which would index a token that isn't there.
  return hash >>> 0;
}

/**
 * A project's preferred hue, 1-based to line up with the --proj-N token names.
 * Intrinsic to the name — the same everywhere, on any machine, whatever else
 * is registered. What a project actually gets is this or, if an earlier
 * registration took it, the next free one.
 */
export function projectHueIndex(project: string): number {
  return (fnv1a(project) % PROJECT_HUES) + 1;
}

/** The class to hang next to `pill`, for a hue index. */
export function pillClass(hue: number): string {
  return `pill-proj-${hue}`;
}

/** What the board hands down to a card or the drawer: name in, class out. */
export interface ProjectHues {
  classFor(project: string): string;
}

/**
 * The registry's hue assignment, in one pass over the registered projects.
 *
 * Ordered by `createdAt` rather than by the array's own order: both are
 * first-registration order today, but createdAt is the field that *means* it
 * and is never rewritten on a later upsert, so a registry.json someone
 * reordered by hand still produces the same colours. `path` breaks a tie,
 * being the registry's unique key — two projects registered in the same
 * millisecond still order deterministically instead of by whichever the sort
 * happened to leave first.
 */
export function buildProjectHues(projects: readonly RegistryProject[]): ProjectHues {
  const order = [...projects].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.path.localeCompare(b.path)
  );

  const assigned = new Map<string, number>();
  const taken = new Set<number>();

  for (const project of order) {
    // Two checkouts of one repo share a name, and the pill can only show that
    // name — so they share the hue, and the first registration is the one that
    // sets it. Skipping here (rather than overwriting) is what makes that the
    // FIRST one.
    if (assigned.has(project.name)) continue;

    const preferred = projectHueIndex(project.name);
    // Linear probe from the preference, wrapping. When every hue is already
    // taken the loop runs its full lap and leaves `hue` back at `preferred`,
    // which is the fallback we want for a ninth project: its own intrinsic
    // colour, shared with whoever holds it, rather than a slot chosen by an
    // arbitrary probe order.
    let hue = preferred;
    for (let step = 1; step <= PROJECT_HUES && taken.has(hue); step += 1) {
      hue = ((preferred - 1 + step) % PROJECT_HUES) + 1;
    }

    assigned.set(project.name, hue);
    taken.add(hue);
  }

  return {
    classFor(project: string): string {
      // An item always belongs to a registered project (the scan walks the
      // registry to find items at all), so the fallback is for the window
      // where /api/items has answered and /api/projects has not: the raw
      // preference, which is usually the hue the assignment lands on anyway.
      return pillClass(assigned.get(project) ?? projectHueIndex(project));
    }
  };
}
