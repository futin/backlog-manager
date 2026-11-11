import { useCallback, useEffect, useRef, useState } from 'react';

import { askParent, releaseParent, retainParent } from '../lib/jira-parent';
import type { JiraIssue } from '../../../shared/types';

/** One surface's view of the shared parent read (spec §4.1, §4.2). `failed` carries `fetchJiraDetail`'s sentence. */
export type ParentRead = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; issue: JiraIssue } | { state: 'failed'; error: string };

const IDLE: ParentRead = { state: 'idle' };

/**
 * useParentRead — a surface's hold on a sub-task's parent read (DESIGN.md §8.9.1 for the Run menu's toggle, §8.9.2 for the Detail's link and parent-live
 * line). The READ is shared module-wide, one per parent key (`lib/jira-parent.ts` says why, and why a failure is never cached); what is per surface is the
 * `read` this hook returns, so a failure shows only where it was asked for (spec §4.2: the menu's note never pre-fills from the Detail's failed link, and
 * the Detail's alert line never shows a menu's failure).
 *
 * - **Nothing on mount.** Mounting only RETAINS the key, which keeps a landed parent held while this surface is up; `ask()` is the only thing that reads, so a
 *   board of sub-task cards fans out no requests (spec §4.2). That is why the menu's hook lives in its open panel, not in the always-drawn chip: closing the
 *   menu releases the key, and a reopen after everything let go reads fresh (spec §7).
 * - **A key change resets.** `JiraView` renders `JiraDetail` without a React `key`, so a walk reuses one instance across issues: the stored `read` is stamped
 *   with the key it belongs to, and a different `parentKey` reads `idle` until it is asked for. A read that lands for the old key is dropped by the same
 *   stamp, and the hold moves with the key through the effect's cleanup.
 * - **`ask()` resolves the issue, or `null`** (no parent key, or a failed read), so a caller acts on the answer without racing its own state.
 */
export function useParentRead(parentKey: string | null): { read: ParentRead; ask: () => Promise<JiraIssue | null> } {
  const [held, setHeld] = useState<{ key: string | null; read: ParentRead }>({ key: parentKey, read: IDLE });
  // The key this instance holds right now, for an answer that lands after a swap or an unmount; `null` once unmounted.
  const current = useRef<string | null>(parentKey);
  current.current = parentKey;

  // Re-stamped in the effect body as well as the render, so StrictMode's mount → unmount → mount in dev does not leave it `null` with no render to fix it.
  useEffect(() => {
    current.current = parentKey;
    if (parentKey !== null) retainParent(parentKey);
    return () => {
      current.current = null;
      if (parentKey !== null) releaseParent(parentKey);
    };
  }, [parentKey]);

  const ask = useCallback(async (): Promise<JiraIssue | null> => {
    const key = parentKey;
    if (key === null) return null;
    setHeld({ key, read: { state: 'loading' } });
    try {
      const issue = await askParent(key);
      if (current.current === key) setHeld({ key, read: { state: 'ready', issue } });
      return issue;
    } catch (err) {
      if (current.current === key) setHeld({ key, read: { state: 'failed', error: err instanceof Error ? err.message : String(err) } });
      return null;
    }
  }, [parentKey]);

  return { read: held.key === parentKey ? held.read : IDLE, ask };
}
