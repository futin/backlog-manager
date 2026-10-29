import type { ProjectSummary } from '../../../shared/types';

/**
 * Which rail row a project's items are shown under (source-sections spec) — a DISPLAY grouping of `ProjectSummary.source`, nothing more. Which adapter
 * actually reads or writes an item stays `ItemsService.writerFor`'s decision; this only decides where the board draws it.
 *
 * `github` → GitHub. Everything else lands in Files: `files` is the obvious one, `unsupported` is a committed marker this build cannot honour (the board
 * still lists the project, and its reason travels in `ItemsIndex.errors`), and `null` is a project with no `backlog/` at all (`missing`) — a registered
 * path that has lost its store is still a project the person registered, and Files is where a registered path with a store-shaped problem belongs.
 */
export type SourceSection = 'files' | 'github';

export function sourceSectionOf(source: ProjectSummary['source']): SourceSection {
  return source === 'github' ? 'github' : 'files';
}

/** Which source rows the rail draws: one per source that owns at least one registered project, never an empty one. */
export type DrawnSources = { files: boolean; github: boolean };

export function drawnSources(projects: readonly ProjectSummary[]): DrawnSources {
  const drawn: DrawnSources = { files: false, github: false };
  for (const p of projects) drawn[sourceSectionOf(p.source)] = true;
  return drawn;
}

/**
 * The first row the rail draws, in rail order (`files`, `github`), else `runs` — the section that needs no project to exist. It is where a shell lands
 * when the section it was on has just lost its row.
 */
export function firstDrawn(drawn: DrawnSources): SourceSection | 'runs' {
  if (drawn.files) return 'files';
  if (drawn.github) return 'github';
  return 'runs';
}

/**
 * `section` itself unless it is a source section whose row is not drawn, in which case `firstDrawn(drawn)`.
 *
 * Generic over the caller's section union and touching only the `files`/`github` values, so any non-source section (`jira`, `runs`, `settings`)
 * passes through byte-for-byte, and the function types against the section union before and after it grows its source members.
 */
export function settleSection<S extends string>(section: S, drawn: DrawnSources): S | SourceSection | 'runs' {
  // Compared through a plain `string`: TypeScript does not narrow a generic `S` by equality, so indexing `drawn` with `section` directly would not compile.
  const key: string = section;
  if (key === 'files' || key === 'github') return drawn[key] ? section : firstDrawn(drawn);
  return section;
}
