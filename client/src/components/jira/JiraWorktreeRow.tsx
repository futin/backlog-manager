import { useEffect, useRef, useState } from 'react';

import { displayPath, removeCommand } from '../../lib/jira';
import type { JiraWorktree } from '../../../../shared/types';
import { keysInBranch } from '../../../../shared/jira-branch';
import { Chip } from '../ui/Chip';
import { Pill } from '../ui/Pill';

const REMOVE_TITLE =
  'Copies the command. Sessions the board did not start — Copy prompt, a terminal — cannot be seen: make sure none is using this tree.';

/**
 * One worktree row (Jira repo/branch, spec §5.5; DESIGN.md §8.9.2 for the issue modal's Worktrees list, §8.9.3 for Setup's per-repo one) — its two
 * composers draw the same row, so it lives once. The branch (`detached` for a tree on no branch), the path through `displayPath`, the repository when
 * `showRepo` (the modal's rows span repositories; Setup's sit under the repository's own row, where saying it again is noise), and a `Remove` that COPIES
 * `removeCommand` and runs nothing — the board never writes git. The button reads `Copied` for 2 s; with no clipboard API, or a refused write, the command
 * itself is drawn under the row so it can be selected by hand. Setup passes `projectKey` (restyle spec §4.4): the row then also says its state — a `session live`
 * pill while `liveKey` names a session on it, else `idle` — and, when the branch carries a ticket of that project, the ticket's key as a pill. The modal's
 * rows pass none and keep their plain look. It is disabled while `liveKey` names a session the shell knows of on this tree, and its title
 * then names that key; otherwise the title says the board cannot see sessions it did not start.
 */
export function WorktreeRow({
  tree,
  home,
  liveKey,
  showRepo,
  projectKey
}: {
  tree: JiraWorktree;
  home: string | null;
  liveKey: string | null;
  showRepo: boolean;
  projectKey?: string;
}) {
  const command = removeCommand(tree);
  const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
  const [copied, setCopied] = useState(false);
  const [refused, setRefused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  const copy = (): void => {
    if (!canCopy) {
      setRefused(true);
      return;
    }
    navigator.clipboard.writeText(command).then(
      () => {
        setRefused(false);
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => setRefused(true)
    );
  };
  const branch = tree.branch ?? 'detached';
  const ticket = projectKey === undefined || tree.branch === null ? undefined : keysInBranch(tree.branch, [projectKey])[0];
  return (
    <li className="jira-wt-row">
      <span className="jira-wt-branch">{branch}</span>
      <span className={projectKey === undefined ? 'jira-wt-path' : 'jira-wt-path jira-setup-code'} title={tree.path}>
        {displayPath(tree.path, home)}
      </span>
      {showRepo && (
        <span className="jira-wt-repo" title={tree.repo}>
          {displayPath(tree.repo, home)}
        </span>
      )}
      {projectKey !== undefined && <Pill tone={liveKey !== null ? 'live' : 'neutral'}>{liveKey !== null ? 'session live' : 'idle'}</Pill>}
      {ticket !== undefined && <Pill>{ticket}</Pill>}
      <Chip
        size={28}
        disabled={liveKey !== null}
        title={liveKey !== null ? `a session is running on ${liveKey}` : REMOVE_TITLE}
        aria-label={`Remove worktree ${branch}`}
        onClick={copy}
      >
        {copied ? 'Copied' : 'Remove'}
      </Chip>
      {refused && <code className="jira-wt-cmd">{command}</code>}
    </li>
  );
}
