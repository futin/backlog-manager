/**
 * releases.ts — what the rail's version chip and the What's new drawer decide, with no React in it (`test/releases-lib.test.ts`). The data is
 * `GET /api/releases` (server/src/releases/), this checkout's own release tags.
 *
 * The unseen dot is a per-viewer convenience over `localStorage`, never a record — which is why it lives in the browser and not in a server file: a first
 * visit seeds the newest version so a fresh install never shows every release as new, a stored value that is not a version counts as missing and is
 * reseeded, and storage that throws (a private window, blocked site data) means no dot rather than a crash. docs/subsystems/releases.md has the whole story.
 */
import type { ReleaseType } from '../../../shared/types';

export const LAST_SEEN_KEY = 'backlog-manager.releases-last-seen';

const VERSION = /^\d+\.\d+\.\d+$/;

/** A bare `X.Y.Z` — not `v0.2.0`, not a prerelease, not whatever an older build or a hand edit left in storage. */
export function isVersion(s: unknown): s is string {
  return typeof s === 'string' && VERSION.test(s);
}

/** Numeric order per part, so `0.10.0` is above `0.9.0` — a string compare would put it below. Both must be versions. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** `v0.2.0` on the tag, `v0.2.0+3` three commits past it — the shape `git describe` would give, minus the sha. */
export function chipLabel(current: { version: string; ahead: number }): string {
  return current.ahead > 0 ? `v${current.version}+${current.ahead}` : `v${current.version}`;
}

const CC_PREFIX = /^[a-z]+(?:\([a-z0-9-]+\))?!?: ?/;

/** The title without its `type(scope)!: ` prefix, which the badge already says. A title with none — the baseline's — is returned as it is. */
export function displayTitle(title: string): string {
  return title.replace(CC_PREFIX, '');
}

/** The type badge's words. Breaking is not a fourth type — it is a badge of its own beside this one — and the baseline has none. */
export const TYPE_LABEL: Record<Exclude<ReleaseType, 'baseline'>, string> = { feat: 'Feature', fix: 'Fix', perf: 'Performance' };

/**
 * Should the chip carry the dot, and must storage be seeded? A dot only when the newest release is above the stored one; a missing or junk stored value is
 * not "everything is new" but a first visit, so it answers no dot and asks the caller to store the newest (`seed`). Pure: the caller does the writing.
 */
export function dotState(newest: string | null, stored: string | null): { dot: boolean; seed: string | null } {
  if (!isVersion(newest)) return { dot: false, seed: null };
  if (!isVersion(stored)) return { dot: false, seed: newest };
  return { dot: compareVersions(newest, stored) > 0, seed: null };
}

/** The last version the viewer opened the drawer on, or `null` — a storage that throws reads as never having seen one. */
export function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

/** Stores it; a storage that throws is swallowed, and the dot then simply never shows. */
export function writeLastSeen(v: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, v);
  } catch {
    /* a private window or blocked site data */
  }
}

/** `16 Oct 2026`, in the viewer's own timezone; a date that does not parse is shown as it came rather than as `Invalid Date`. */
export function formatReleaseDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
