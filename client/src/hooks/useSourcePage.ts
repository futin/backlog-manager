import { FILES_PAGE_KEY, GITHUB_PAGE_KEY, isFilesPage, isGithubPage, type FilesPage, type GithubPage } from '../lib/source-page';
import { persistedStore } from './persistedStore';

/**
 * useSourcePage — the page each source section has open (source-sections spec): Files' `board | archive` and GitHub's `board | prs | archive | settings`. Two
 * `persistedStore`s, for the reason that file gives: the rail's tree and the shell are two mounted readers of each value, and the shell writes it too — when it
 * settles a legacy `board`/`archive` landing onto whichever source it lands on, and through the in-page links it hands down.
 *
 * `lib/source-page.ts` stays the one home of the keys, the lists and the guards. Anything stored that is not a page — including a page only the other source
 * has — is `board`, the page every source has.
 */
const files = persistedStore<FilesPage>(FILES_PAGE_KEY, isFilesPage, 'board');
const github = persistedStore<GithubPage>(GITHUB_PAGE_KEY, isGithubPage, 'board');

export const useFilesPage = files.useValue;
export const setFilesPage = files.set;
export const useGithubPage = github.useValue;
export const setGithubPage = github.set;
