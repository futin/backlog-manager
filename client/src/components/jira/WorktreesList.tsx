import { useState } from 'react';

import { Chevron } from '../ui/Chevron';
import { Fold } from '../ui/Fold';
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

/**
 * The ticket's Worktrees as a fold (Jira detail tabs spec §4.6; mock `Main.html`'s Worktrees fold; DESIGN.md §8.9.6): closed by default, `Worktrees N` on
 * its summary, the same `WorktreeRow`s once open. It sits at the bottom of the Delivery tab — a worktree is where the delivery's branch is checked out — or
 * of the Ticket tab on a ticket with no Delivery tab, so it is never lost with the tab. Its open state is its own and resets with the ticket (the body keys
 * it by key); the fold is closed because the list is a cleanup chore, not a reading, and it must not push the target rows down.
 */
export function WorktreesFold({ trees, issueKey, live, home }: { trees: readonly JiraWorktree[]; issueKey: string; live: boolean; home: string | null }) {
  const [open, setOpen] = useState(false);
  const head = (
    <>
      <Chevron dir={open ? 'down' : 'right'} />
      <span className="jira-wt-fold-label">Worktrees</span> <span className="jira-tab-count">{trees.length}</span>
    </>
  );
  return (
    <Fold className="jira-wt-fold" open={open} onToggle={() => setOpen((o) => !o)} head={head}>
      <ul className="jira-wt-list">
        {trees.map((t) => (
          <WorktreeRow key={t.path} tree={t} home={home} liveKey={live ? issueKey : null} showRepo />
        ))}
      </ul>
    </Fold>
  );
}
