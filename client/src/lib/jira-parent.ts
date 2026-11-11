import { STATE_LABEL } from '../../../shared/jira-sessions';
import type { JiraIssue, JiraSessionsPayload } from '../../../shared/types';
import { fetchJiraDetail, repoBasename } from './jira';
import { ticketSessions, type SessionLink } from './jira-sessions';

/**
 * jira-parent — a sub-task's parent, read and described (spec `2026-11-11-jira-run-on-parent-design.md` §4.1–§4.3, §7; DESIGN.md §8.9.1 and §8.9.2).
 *
 * **Why the parent is read at all.** The user's team assigns sub-tasks, but the parent story owns the branch, and that parent is usually on none of their
 * boards. A sub-task carries only `{ key, summary }` of its parent, while the Detail's walk and the launch sheet both want a whole `JiraIssue` — its type,
 * its project (whose repos decide the gate) and its summary (the branch default's slug). So the parent is read through the one route that gives that,
 * `GET /api/jira/issue/:key`, on demand.
 *
 * **Why the read is shared.** Up to four surfaces ask for the same parent in one open — the Detail's head crumb, its `Parent` fact, its parent-live line and
 * its `Run ▾` — and a board of sub-tasks under one story can put the same parent behind every card's menu. One read per parent key, module-wide: a pending
 * read is JOINED rather than repeated (so a double click, or the link then the menu, is one request), and a landed one is kept while at least one mounted
 * surface holds that key (`retainParent` / `releaseParent`, a count by mount) and dropped when the last lets go — "while the Detail or menu that asked is
 * open" (spec §7), nothing persisted, so a reopen after everything closed reads fresh.
 *
 * **Why a failure is never cached.** A failed read is the network's or Jira's state at that instant, and the person's next click is exactly a retry. Keeping
 * the rejection would turn one blip into a dead link until the Detail closed; so the pending entry is removed the moment it fails, and the next `askParent`
 * reads again. Showing the failure is per surface (`hooks/useParentRead.ts`): this store holds only the read, never who has seen it fail.
 *
 * This file stays React-free, like the rest of `lib/`; the hook that mounts a surface on it is `hooks/useParentRead.ts`.
 */

interface ParentEntry {
  /** Mounted surfaces holding this key. */
  refs: number;
  /** The read in flight, joined by every ask until it settles. */
  pending: Promise<JiraIssue> | null;
  /** The landed issue, kept while `refs > 0`. */
  issue: JiraIssue | null;
}

const entries = new Map<string, ParentEntry>();

function entryOf(key: string): ParentEntry {
  let e = entries.get(key);
  if (e === undefined) {
    e = { refs: 0, pending: null, issue: null };
    entries.set(key, e);
  }
  return e;
}

/** Drop an entry nobody holds and nothing is reading — the only way a landed parent leaves the store. */
function sweep(key: string): void {
  const e = entries.get(key);
  if (e !== undefined && e.refs <= 0 && e.pending === null) entries.delete(key);
}

/** A surface mounting on `key`. Pair every call with one `releaseParent(key)`. */
export function retainParent(key: string): void {
  entryOf(key).refs += 1;
}

/** A surface letting go of `key`: the landed issue goes once the last holder does. A read still in flight finishes and is then dropped (`askParent`). */
export function releaseParent(key: string): void {
  const e = entries.get(key);
  if (e === undefined) return;
  e.refs -= 1;
  sweep(key);
}

/**
 * The parent issue: the landed one if held, the read in flight if there is one, else a new read. Rejects with `fetchJiraDetail`'s sentence on a failure,
 * and the failure is not kept — the next call reads again.
 */
export function askParent(key: string): Promise<JiraIssue> {
  const e = entryOf(key);
  if (e.issue !== null) return Promise.resolve(e.issue);
  if (e.pending !== null) return e.pending;
  const read = fetchJiraDetail(key).then(
    (issue) => {
      e.pending = null;
      // Held only while someone still holds the key; a read that lands after every surface closed is answered to its askers and then forgotten.
      if (e.refs > 0) e.issue = issue;
      sweep(key);
      return issue;
    },
    (err: unknown) => {
      e.pending = null;
      sweep(key);
      throw err;
    }
  );
  e.pending = read;
  return read;
}

/**
 * The parent-live line's content (spec §4.3): for a SUB-TASK with a parent — the toggle's condition, so a story under an epic gets none — the parent's live
 * sessions from the payload, newest start first (`ticketSessions`' order): the newest leads, the rest are a count. `null` when the issue is not a sub-task,
 * has no parent, or the parent has no live session. Ended history is not drawn (spec §7). No read: the payload already carries every key's links, which is
 * why this line draws even for a parent on no board.
 */
export function parentLiveLine(issue: JiraIssue, payload: JiraSessionsPayload | null): { lead: SessionLink; more: number } | null {
  if (!issue.type.subtask || issue.parent === null) return null;
  const { live } = ticketSessions(issue.parent.key, payload);
  if (live.length === 0) return null;
  return { lead: live[0], more: live.length - 1 };
}

/** `Parent P-1 · Working · microservice →` — the line's words: the parent's key, the lead session's state label and its repo's last segment (spec §4.3). */
export function parentLineText(parentKey: string, lead: SessionLink): string {
  return `Parent ${parentKey} · ${STATE_LABEL[lead.state]} · ${repoBasename(lead.repo)} →`;
}
