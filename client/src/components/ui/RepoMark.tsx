import { Glyph } from './Glyphs';

/**
 * RepoMark — the repository a Jira project maps to, as the branch glyph and the one path's basename, or `N repos` with every path in the title
 * (.claude/DESIGN.md §8.9.1). The card's marker row and an on-board lane header both draw it, from the status's own mapping for the issue's project, so the
 * two cannot name a repo differently. An unmapped project draws nothing: `Run ▾` already says `no repo` in its own dashed chip.
 */
export function RepoMark({ paths }: { paths: readonly string[] }) {
  if (paths.length === 0) return null;
  return (
    <span className="ui-repo" title={paths.join('\n')}>
      <Glyph name="branch" size={14} />
      <span>{paths.length === 1 ? (paths[0].replace(/\/+$/, '').split('/').pop() ?? paths[0]) : `${paths.length} repos`}</span>
    </span>
  );
}
