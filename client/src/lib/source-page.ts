import { SECTIONS, type Section } from './sections';

/**
 * source-page.ts — which page each source section last had open, and the one place a stored section from before the source rows is read (source-sections
 * spec, "Migrating stored values").
 *
 * The keys, the member lists and the guards, and nothing that touches React — `lib/jira-page.ts`'s split, for its reason: the guards can be tested without
 * rendering a section, and `hooks/useSourcePage.ts` is the one binding over them. Each source's tree and the shell are two mounted readers of one value
 * (and the shell writes it too, when it settles a legacy landing), which is why the values are module stores and not a `usePersistedState` per caller.
 *
 * Every guard takes `unknown`, not `string`: `localStorage` round-trips through `JSON.parse`, so a stored value can be a number, an object or `null` just
 * as easily as a word this union never had, and the one outcome a source section must never have is rendering no page.
 */

/** Files has no Settings page until there is a setting to put on it (spec, "Decided by the person"). Declaration order is the rail tree's order. */
export type FilesPage = 'board' | 'archive';
export const FILES_PAGES: readonly FilesPage[] = ['board', 'archive'];
export const FILES_PAGE_KEY = 'backlog-manager.files-page';

export function isFilesPage(v: unknown): v is FilesPage {
  return typeof v === 'string' && (FILES_PAGES as readonly string[]).includes(v);
}

/**
 * GitHub's pages. Declaration order is the rail tree's order: `prs` (the open pull requests of the registered GitHub repos, `.claude/DESIGN.md` §8.11)
 * sits between Board and Archive because it is live work like the Board, and Archive is what has gone quiet.
 */
export type GithubPage = 'board' | 'prs' | 'archive' | 'settings';
export const GITHUB_PAGES: readonly GithubPage[] = ['board', 'prs', 'archive', 'settings'];
export const GITHUB_PAGE_KEY = 'backlog-manager.github-page';

export function isGithubPage(v: unknown): v is GithubPage {
  return typeof v === 'string' && (GITHUB_PAGES as readonly string[]).includes(v);
}

/**
 * Where an unrecognised, absent or legacy section lands BEFORE the projects answer exists (spec, Fallback). A constant, because it is read in the shell's
 * `useState` initializer, before any answer; and GitHub, because today's Board is GitHub › Board. It is a provisional landing either way: the shell settles
 * it on the first projects answer, so a machine with no GitHub project never stays on it, and it is never written to the section key (#401).
 */
export const FALLBACK_SECTION: Section = 'github';

export interface LegacyResolution {
  section: Section;
  /** The page a legacy `board`/`archive` meant, so the settled source opens on it; `null` for every other input. */
  page: 'board' | 'archive' | null;
  /**
   * `true` when `section` is a GUESS the projects answer must settle — a legacy name, or nothing usable at all — and `false` when it is a section the
   * reader really stored (or a pin they really chose), which the shell holds like any other until an answer says its row is gone.
   */
  provisional: boolean;
}

/**
 * A section name read from outside this build — the `backlog-manager.section` key or a raw `landing` pin — coerced into one the rail has.
 *
 * `board` and `archive` were root sections until the source rows: every install before this change holds one of them, and an upgrade must not open on
 * a blank main area (spec Anti-goals). Neither can be mapped onto a source here, because which sources this machine has is the projects answer and this
 * runs before it; so both land on GitHub provisionally, remembering which page was meant, and the shell settles them. Anything else unrecognised — the
 * pre-Board `projects`, a hand-edited value, no key at all — lands on the same provisional fallback with no page.
 */
export function resolveLegacySection(raw: unknown): LegacyResolution {
  if (raw === 'board' || raw === 'archive') return { section: FALLBACK_SECTION, page: raw, provisional: true };
  if (SECTIONS.includes(raw as Section)) return { section: raw as Section, page: null, provisional: false };
  return { section: FALLBACK_SECTION, page: null, provisional: true };
}
