import { Pill } from '../ui/Pill';
import { WorktreeRow } from './JiraWorktreeRow';
import type { JiraWorktree } from '../../../../shared/types';

/* The ticket's Worktrees list. Moved out of `JiraDetail.tsx` unchanged (Jira detail tabs plan, Task 4) so the Detail body and its tabs can
   draw it; DESIGN.md §8.9.2. */

/**
 * The ticket's worktrees (header, "The Worktrees list"): one `WorktreeRow` per tree — branch, path and repo through `displayPath` — and a `Remove` that
 * copies the command and runs nothing (the row's own header says how). It is disabled while `live` — the shell knows of a session on this key — and its
 * title then names the key.
 */
export function WorktreesList({ trees, issueKey, live, home }: { trees: readonly JiraWorktree[]; issueKey: string; live: boolean; home: string | null }) {
  return (
    <section className="jira-wt">
      <div className="jira-tree-head">
        <h3>Worktrees</h3>
        <Pill tone="neutral">{trees.length}</Pill>
      </div>
      <ul className="jira-wt-list">
        {trees.map((t) => (
          <WorktreeRow key={t.path} tree={t} home={home} liveKey={live ? issueKey : null} showRepo />
        ))}
      </ul>
    </section>
  );
}
