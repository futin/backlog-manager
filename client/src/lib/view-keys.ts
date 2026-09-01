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
 * `STATUS_KEY` and `SORT_KEY` deliberately stay local to BoardView. They are
 * Board-only questions: Archive carries no status filter (its contents are
 * defined by staleness and rejection, not by status — see the design) and no
 * sort control (month grouping is its ordering).
 */

/**
 * Which project the reader is looking at — shared by Board and Archive on
 * purpose. "Which project's backlog is this" is a question about the corpus,
 * not about a surface, so narrowing to one project on the Board and then
 * opening Archive should not silently widen back to all of them.
 */
export const PROJECT_KEY = 'backlog-manager.project';
