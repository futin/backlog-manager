import { useEffect, useState } from 'react';

import { FILES_PAGE_KEY, GITHUB_PAGE_KEY, isFilesPage, isGithubPage, type FilesPage, type GithubPage } from '../lib/source-page';

/**
 * useSourcePage — the page each source section has open (source-sections spec): Files' `board | archive` and GitHub's `board | archive | settings`.
 * `useJiraPage`'s module store and its reason, twice: the rail's tree and the shell are two mounted readers of each value, and the shell writes it too —
 * when it settles a legacy `board`/`archive` landing onto whichever source it lands on, and through the in-page links it hands down. `usePersistedState`
 * is a `useState` per caller, so a write from one would reach localStorage and never reach the already-mounted other.
 *
 * One factory rather than two hand copies of `useJiraPage`, because the two stores differ only in their key, their guard and their member type, and two
 * copies of the subscribe/write/read body would be two things free to drift. `lib/source-page.ts` stays the one home of the keys, the lists and the guards.
 *
 * Reads go through the guard on the way out of storage, and anything that is not a page — absent, not JSON, a page only the other source has — is
 * `board`, the page every source has. Storage is read on every mount rather than cached beside the listeners, so a `localStorage.clear()` or a write from
 * a second tab is never contradicted by a stale module value.
 */
function pageStore<P extends string>(key: string, isPage: (v: unknown) => v is P, fallback: P) {
  type Listener = (p: P) => void;
  const listeners = new Set<Listener>();

  const read = (): P => {
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return isPage(parsed) ? parsed : fallback;
    } catch {
      // Private mode, or a stored value that is not JSON at all.
      return fallback;
    }
  };

  const set = (page: P): void => {
    try {
      // JSON, the way `usePersistedState` writes every other key.
      localStorage.setItem(key, JSON.stringify(page));
    } catch {
      /* ignore: private mode / quota — the in-memory value still moves */
    }
    for (const l of listeners) l(page);
  };

  const usePage = (): [P, (p: P) => void] => {
    const [page, setPage] = useState<P>(read);
    useEffect(() => {
      listeners.add(setPage);
      return () => {
        listeners.delete(setPage);
      };
    }, []);
    return [page, set];
  };

  return { usePage, set };
}

const files = pageStore<FilesPage>(FILES_PAGE_KEY, isFilesPage, 'board');
const github = pageStore<GithubPage>(GITHUB_PAGE_KEY, isGithubPage, 'board');

export const useFilesPage = files.usePage;
export const setFilesPage = files.set;
export const useGithubPage = github.usePage;
export const setGithubPage = github.set;
