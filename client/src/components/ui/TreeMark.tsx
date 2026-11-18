import type { JiraWorktree } from '../../../../shared/types';

/**
 * TreeMark — a ticket's worktrees (Jira repo/branch spec §5.5; .claude/DESIGN.md §8.9.1): the branch of its one tree, or `N worktrees`, every path in the
 * title. The card and an on-board lane header both draw it from `ticketWorktrees`' answer for their OWN key, computed once by the page; a ticket with none
 * draws nothing — and so does one whose read failed, which is why this takes the trees and never requests them: it has no error state to draw. A tree on a
 * detached HEAD has no branch (`JiraWorktree.branch` is `null`), so its one chip reads the tree directory's name instead of drawing empty.
 */
export function TreeMark({ trees }: { trees: readonly Pick<JiraWorktree, 'path' | 'branch'>[] }) {
  if (trees.length === 0) return null;
  return (
    <span className="ui-tree" title={trees.map((t) => t.path).join('\n')}>
      {trees.length === 1 ? (trees[0].branch ?? dirName(trees[0].path)) : `${trees.length} worktrees`}
    </span>
  );
}

/** The last segment of a path, a trailing slash ignored; the path itself when it has none. */
function dirName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}
