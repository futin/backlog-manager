import { drawnSources, firstDrawn, settleSection, sourceSectionOf } from '../client/src/lib/sources';
import type { ProjectSummary } from '../shared/types';

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
