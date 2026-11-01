import { drawnSources, errorSource, firstDrawn, inSource, narrowToSource, settleSection, sourceSectionOf } from '../client/src/lib/sources';
import { issueUrn } from '../server/src/tracker/map-issue';
import type { ItemsIndex, ProjectSummary } from '../shared/types';

/** Only `source` is read by the derivations; the rest of a summary is filler the cast papers over. */
function project(source: ProjectSummary['source']): ProjectSummary {
  return { name: 'p', path: '/p', source } as ProjectSummary;
}

describe('sourceSectionOf', () => {
  it.each([
    ['github', 'github'],
    ['files', 'files'],
    ['unsupported', 'files'],
    [null, 'files']
  ] as const)('%s -> %s', (source, section) => {
    expect(sourceSectionOf(source)).toBe(section);
  });
});

describe('drawnSources', () => {
  it('draws nothing for no projects', () => {
    expect(drawnSources([])).toEqual({ files: false, github: false });
  });
  it('draws both rows for a files and a github project', () => {
    expect(drawnSources([project('files'), project('github')])).toEqual({ files: true, github: true });
  });
  it('folds an unsupported project into Files', () => {
    expect(drawnSources([project('unsupported')])).toEqual({ files: true, github: false });
  });
  it('folds a null-source (missing) project into Files', () => {
    expect(drawnSources([project(null)])).toEqual({ files: true, github: false });
  });
});

describe('firstDrawn', () => {
  it('prefers files when both are drawn', () => {
    expect(firstDrawn({ files: true, github: true })).toBe('files');
  });
  it('falls to github when only github is drawn', () => {
    expect(firstDrawn({ files: false, github: true })).toBe('github');
  });
  it('falls to runs when nothing is drawn', () => {
    expect(firstDrawn({ files: false, github: false })).toBe('runs');
  });
});

describe('settleSection', () => {
  it('keeps a drawn source section', () => {
    expect(settleSection('github', { files: false, github: true })).toBe('github');
  });
  it('moves an undrawn github to files when files is drawn', () => {
    expect(settleSection('github', { files: true, github: false })).toBe('files');
  });
  it('moves an undrawn files to github when github is drawn', () => {
    expect(settleSection('files', { files: false, github: true })).toBe('github');
  });
  it('moves an undrawn files to runs when nothing is drawn', () => {
    expect(settleSection('files', { files: false, github: false })).toBe('runs');
  });
  it('passes jira through untouched', () => {
    expect(settleSection('jira', { files: false, github: false })).toBe('jira');
  });
  it('passes settings through untouched', () => {
    expect(settleSection('settings', { files: false, github: false })).toBe('settings');
  });
});

describe('inSource', () => {
  const projects: ProjectSummary[] = [
    { name: 'a', path: '/a', source: 'files' } as ProjectSummary,
    { name: 'b', path: '/b', source: 'github' } as ProjectSummary,
    { name: 'c', path: '/c', source: 'unsupported' } as ProjectSummary,
    { name: 'd', path: '/d', source: null } as ProjectSummary
  ];
  it('is true for a project under the source it belongs to, false under the other', () => {
    expect(inSource('/b', projects, 'github')).toBe(true);
    expect(inSource('/b', projects, 'files')).toBe(false);
    expect(inSource('/a', projects, 'files')).toBe(true);
    expect(inSource('/a', projects, 'github')).toBe(false);
  });
  it('folds unsupported and null-source projects into files', () => {
    expect(inSource('/c', projects, 'files')).toBe(true);
    expect(inSource('/d', projects, 'files')).toBe(true);
    expect(inSource('/c', projects, 'github')).toBe(false);
  });
  it('is false for a path no project carries, under either source', () => {
    expect(inSource('/nope', projects, 'files')).toBe(false);
    expect(inSource('/nope', projects, 'github')).toBe(false);
  });
});

describe('narrowToSource', () => {
  const projects = [
    { name: 'a', path: '/a', source: 'files' },
    { name: 'b', path: '/b', source: 'github' },
    { name: 'c', path: '/c', source: 'unsupported' }
  ] as ProjectSummary[];
  const index = {
    items: [{ id: '1', projectPath: '/a' }, { id: '2', projectPath: '/b' }, { id: '3', projectPath: '/c' }, { id: '4', projectPath: '/gone' }],
    errors: ['/c/backlog/source.json: unsupported']
  } as unknown as ItemsIndex;

  it('keeps the items of the source and drops an unregistered project', () => {
    expect(narrowToSource(index, projects, 'files')!.items.map((i) => i.id)).toEqual(['1', '3']);
    expect(narrowToSource(index, projects, 'github')!.items.map((i) => i.id)).toEqual(['2']);
  });
  it('cuts the index errors by source too', () => {
    expect(narrowToSource(index, projects, 'files')!.errors).toEqual(index.errors);
    expect(narrowToSource(index, projects, 'github')!.errors).toEqual([]);
  });
  it('passes the not-yet-fetched null through, and reads a null registry as empty', () => {
    expect(narrowToSource(null, projects, 'files')).toBeNull();
    expect(narrowToSource(index, null, 'files')!.items).toEqual([]);
  });
});

/*
 * Index errors, routed by what they name (final review I1). Every string is distinct and built in the server's own format — the URN through the server's
 * own `issueUrn`, so a change to the prefix there turns this red rather than silently sending every GitHub warning to Files — and each list is asserted in
 * full, so an error routed to the wrong page fails on both sides.
 */
describe('errorSource', () => {
  const projects = [
    { name: 'a', path: '/w/a', source: 'files', repo: null },
    { name: 'b', path: '/w/b', source: 'github', repo: 'futin/b' },
    { name: 'bb', path: '/w/bb', source: 'files', repo: null },
    { name: 'c', path: '/w/c', source: 'unsupported', repo: null },
    { name: 'd', path: '/w/d', source: 'unsupported', repo: null },
    { name: 'nested', path: '/w/b/vendor/n', source: 'files', repo: null }
  ] as ProjectSummary[];

  const URN_WARNING = `${issueUrn('futin/b', 7)}: 2 type labels (bug, task) — using bug`;
  // The server answers `unsupported` for a marker with no valid repo (#400), so `/w/d` is this error's normal owner. `STALE_REPO` is the one way a github row
  // can still meet it: the shell reads `/api/projects` on mount and focus while the index keeps polling, so a marker broken in between reaches a row that has
  // not heard yet, and the error goes where that row is drawn.
  const BAD_REPO = '/w/d: backlog/source.json names no valid "repo" (expected "owner/name")';
  const STALE_REPO = '/w/b: backlog/source.json names no valid "repo" (expected "owner/name")';
  const BAD_FILE = '/w/a/backlog/bugs/open/bug-3-x.md: frontmatter has no closing --- line';
  const PREFIX_TWIN = '/w/bb/backlog/ideas/open/idea-1-y.md: frontmatter has no closing --- line';
  const BAD_MARKER = '/w/c/backlog/source.json: invalid JSON (Unexpected token)';
  const NESTED = '/w/b/vendor/n/backlog/bugs/open/bug-1-z.md: frontmatter has no closing --- line';
  const NOBODY = 'registry.json: something nobody owns';

  it.each([
    ['a GitHub issue URN goes to GitHub', URN_WARNING, 'github'],
    ['a github project path goes to GitHub', STALE_REPO, 'github'],
    ['a marker with no valid repo goes to Files, where its unsupported project is drawn (#400)', BAD_REPO, 'files'],
    ['a file inside a files project goes to Files', BAD_FILE, 'files'],
    ['a path that only shares a prefix with a github project goes to its own project, not that one', PREFIX_TWIN, 'files'],
    ['an unsupported marker goes to Files, where its project is drawn', BAD_MARKER, 'files'],
    ['the longest registered path wins for a nested project', NESTED, 'files'],
    ['an error naming nothing registered goes to Files', NOBODY, 'files']
  ] as const)('%s', (_name, error, section) => {
    expect(errorSource(error, projects)).toBe(section);
  });

  it('narrowToSource splits a mixed error list between the two pages, order kept', () => {
    const index = { items: [], errors: [BAD_FILE, URN_WARNING, NOBODY, BAD_REPO, STALE_REPO, BAD_MARKER] } as unknown as ItemsIndex;
    expect(narrowToSource(index, projects, 'files')!.errors).toEqual([BAD_FILE, NOBODY, BAD_REPO, BAD_MARKER]);
    expect(narrowToSource(index, projects, 'github')!.errors).toEqual([URN_WARNING, STALE_REPO]);
  });

  it('routes a URN to GitHub before the registry has answered, and a path to Files', () => {
    const index = { items: [], errors: [URN_WARNING, BAD_REPO] } as unknown as ItemsIndex;
    expect(narrowToSource(index, null, 'github')!.errors).toEqual([URN_WARNING]);
    expect(narrowToSource(index, null, 'files')!.errors).toEqual([BAD_REPO]);
  });
});
