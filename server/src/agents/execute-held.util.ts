import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { EXECUTE_HELD_REASON, type AgentAction } from '../../../shared/agent';
import type { BacklogItem } from '../../../shared/types';
import { runGit } from '../git-run.util';

/**
 * execute-held.util.ts — why this files item cannot be executed again because an execute already holds it, or null (#427).
 *
 * A `--finish pr` execute leaves `execute/<id>` and `.worktrees/execute-<id>` behind, and a files item stays in `open/` on the base until its PR merges. A
 * tracker item has its `in-review` label to say so; a files item has only these two names, and without this rung it reads ready to every gate, so a click on
 * Run starts a second execution of work already waiting on a reviewer. A TWIN of `executeTaken` in `skills/backlog-tick/tools/tick.mjs` and `executeHeld` in
 * `skills/backlog-orchestrate/tools/orchestrate.mjs` — a change to the names is a change to all three.
 *
 * Files items only, and a tracker item is deliberately not asked: its guard is the label, which a person clears after a closed PR without being asked to
 * delete a branch, so a leftover branch must not block the re-run. Execute only: a second groom is not a second execution. `runGit` failing or timing out, a
 * project that is not a repository among them, reads as not held — this is a guard against repeating work, and it must not refuse a dispatch over a git
 * read it could not make. Per request and memoised nowhere: a branch that was just deleted has to free the item on the next read, so this never reaches
 * `BacklogItem`.
 */
export async function executeHeldBlock(item: BacklogItem, action: AgentAction | null): Promise<string | null> {
  if (item.source !== 'files' || action !== 'execute') return null;
  if (existsSync(join(item.projectPath, '.worktrees', `execute-${item.id}`))) return EXECUTE_HELD_REASON;
  const ref = await runGit(['-C', item.projectPath, 'show-ref', '--verify', '--quiet', `refs/heads/execute/${item.id}`]);
  return ref === null ? null : EXECUTE_HELD_REASON;
}
