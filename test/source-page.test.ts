import { FILES_PAGES, FILES_PAGE_KEY, GITHUB_PAGES, GITHUB_PAGE_KEY, isFilesPage, isGithubPage, resolveLegacySection } from '../client/src/lib/source-page';
import { SECTIONS } from '../client/src/lib/sections';

/*
  The source sections' page stores and the legacy-section reader (source-sections spec, "Migrating stored values"). `resolveLegacySection` runs in the
  shell's initializer, before the projects answer exists, so it cannot pick a source: a legacy `board`/`archive` lands on GitHub provisionally with the page
  it meant, a real section is kept as stored, and anything else lands on the provisional fallback with no page.
*/
describe('resolveLegacySection', () => {
  it.each([
    ['board', { section: 'github', page: 'board', provisional: true }],
    ['archive', { section: 'github', page: 'archive', provisional: true }],
    ['runs', { section: 'runs', page: null, provisional: false }],
    ['github', { section: 'github', page: null, provisional: false }],
    ['jira', { section: 'jira', page: null, provisional: false }],
    ['projects', { section: 'github', page: null, provisional: true }],
    [42, { section: 'github', page: null, provisional: true }],
    [undefined, { section: 'github', page: null, provisional: true }]
  ])('resolves %p', (raw, expected) => {
    expect(resolveLegacySection(raw)).toEqual(expected);
  });

  it('keeps every section the rail has as stored, never provisionally', () => {
    for (const s of SECTIONS) expect(resolveLegacySection(s)).toEqual({ section: s, page: null, provisional: false });
  });

  it('compares exactly, not case-folded', () => {
    expect(resolveLegacySection('Board')).toEqual({ section: 'github', page: null, provisional: true });
  });
});

describe('the page stores', () => {
  it('lists Files as Board, Archive and GitHub as Board, PRs, Archive, Settings, in tree order', () => {
    expect(FILES_PAGES).toEqual(['board', 'archive']);
    expect(GITHUB_PAGES).toEqual(['board', 'prs', 'archive', 'settings']);
  });

  it('keys each source under its own name', () => {
    expect(FILES_PAGE_KEY).toBe('backlog-manager.files-page');
    expect(GITHUB_PAGE_KEY).toBe('backlog-manager.github-page');
  });

  it('guards each page list, refusing a page the other source has', () => {
    expect(isFilesPage('archive')).toBe(true);
    expect(isFilesPage('settings')).toBe(false);
    expect(isGithubPage('settings')).toBe(true);
    expect(isGithubPage('prs')).toBe(true);
    expect(isFilesPage('prs')).toBe(false);
    for (const bad of ['pulls', 'Board', '', null, undefined, 3, {}]) {
      expect(isFilesPage(bad)).toBe(false);
      expect(isGithubPage(bad)).toBe(false);
    }
  });
});
