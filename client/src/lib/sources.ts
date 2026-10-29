import type { ItemsIndex, ProjectSummary } from '../../../shared/types';

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
 * How many registered projects each source row owns — the Sources card's `n projects` (Settings › Shared). The same `sourceSectionOf` grouping the rail
 * draws its rows by, so the card never counts a project under one source while the rail shows it under the other. Typed on `source` alone because the card
 * counts the tracker payload's rows (`TrackerProjectRow`), which carry the same field as `ProjectSummary` over the same registry.
 */
export function projectsPerSource(projects: readonly Pick<ProjectSummary, 'source'>[]): Record<SourceSection, number> {
  const counts: Record<SourceSection, number> = { files: 0, github: 0 };
  for (const p of projects) counts[sourceSectionOf(p.source)] += 1;
  return counts;
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

/**
 * Whether the project at `projectPath` is drawn under `source` — what `BoardView` and `ArchiveView` ask of every item before any other derivation, so a
 * count, a filter, a warning and the Orchestrate sheet's project list all read ONE source's set. Matched by path, the registry's own key (two checkouts of
 * a repo share a name and never a path). A path no registered project carries is in NO source: an item whose project has just been unregistered would
 * otherwise land on whichever page asked, and the board's fail-open rule is about a stored PICK going stale, not about a row with no home.
 */
export function inSource(projectPath: string, projects: readonly ProjectSummary[], source: SourceSection): boolean {
  const project = projects.find((p) => p.path === projectPath);
  return project !== undefined && sourceSectionOf(project.source) === source;
}

/** The registered projects drawn under `source`, in registry order — the half of `inSource` a page needs as a list (its project picks, its warnings). */
export function projectsIn(projects: readonly ProjectSummary[], source: SourceSection): ProjectSummary[] {
  return projects.filter((p) => sourceSectionOf(p.source) === source);
}

/**
 * The one narrowing both pages share: an index cut to the items `source` draws, with `errors` kept ONLY on Files. An index error names no project, only a
 * file, so it cannot be attributed finer than the source that owns the unreadable projects (`unsupported` and `missing`), and that source is Files — the
 * rule lives here, once, so Board and Archive cannot drift apart on it. `null` (not fetched yet) passes through, and a `null` registry reads as empty, which
 * keeps every item out until the projects arrive rather than showing them under whichever page asked.
 */
export function narrowToSource(index: ItemsIndex | null, projects: readonly ProjectSummary[] | null, source: SourceSection): ItemsIndex | null {
  if (index === null) return null;
  const registry = projects ?? [];
  return { items: index.items.filter((i) => inSource(i.projectPath, registry, source)), errors: source === 'files' ? index.errors : [] };
}
