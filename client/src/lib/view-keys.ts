import type { SourceSection } from './sources';

/**
 * view-keys.ts — the localStorage keys more than one surface reads.
 *
 * Exactly one lives here, and it is here rather than in BoardView because of
 * how the surfaces are loaded, not because a constants file was wanted: App
 * lazy-imports BoardView and ArchiveView as separate chunks, so an
 * `import { PROJECT_KEY } from '../board/BoardView'` in ArchiveView would pull
 * the whole Board module — its four columns, its sheets, its run strip — into
 * Archive's chunk and undo the split. A three-line module both can import
 * costs nothing and keeps the string stated once.
 *
 * `STATUS_KEY`, `SORT_KEY` and `SORT_DIR_KEY` deliberately stay local to
 * BoardView. They are Board-only questions: Archive carries no status filter
 * (its contents are defined by staleness and rejection, not by status — see
 * the design) and no sort control (month grouping is its ordering), so it has
 * no use for a sort direction either.
 */

/**
 * Which project the reader is looking at — shared by a source's Board and Archive on
 * purpose. "Which project's backlog is this" is a question about the corpus,
 * not about a surface, so narrowing to one project on the Board and then
 * opening Archive should not silently widen back to all of them.
 *
 * One value PER SOURCE (`projectKey`, source-sections): Files and GitHub each draw
 * only their own projects, so a single stored path would be a pick the other page
 * cannot honour and would fight it for the slot. The bare `PROJECT_KEY` is the
 * prefix only — a value stored under it by a build that had one board is never
 * read, and the first visit to each source reads as All projects.
 */
export const PROJECT_KEY = 'backlog-manager.project';

export function projectKey(source: SourceSection): string {
  return `${PROJECT_KEY}.${source}`;
}
