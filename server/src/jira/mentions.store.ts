import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../atomic-write.util';
import { JIRA_MENTIONS_WINDOW_DAYS, JIRA_REPLY_MAX_CHARS, isJiraKey } from '../../../shared/types';
import type { JiraMentionDraft } from '../../../shared/types';
import { isSessionId } from './session-id.util';

/**
 * The mentions store (Jira › Mentions, spec Constraints "The mentions store is the server's own file"): which mention comments a person dismissed. The
 * server is its one writer, through `writeJsonAtomic`, and the shape, the load-once and the set-aside rule are `links.store.ts`'s, for the same reasons —
 * this is machine-written state whose loss costs a few re-appearing mentions, so a file that cannot be read is set aside rather than refusing every dismiss.
 *
 * **Load once, per-entry fallback.** The constructor reads the file; a missing one is empty, an unparseable one or one whose `version` is not 1 is empty with
 * one warning, and an entry without a comment id, a valid key or two parseable instants costs only itself (one warning, the file is not set aside for it).
 * A load neither prunes nor writes.
 *
 * **Set-aside at the first save after an unreadable load.** The check is made at save time against what is on disk, so a boot that never dismisses anything
 * leaves the bad file where it was; the save then renames it to `jira-mentions.json.bad-<ISO>` before writing a fresh one.
 *
 * **Prune on every save, never on load.** A dismissal exists to keep a comment out of the list, and the list only looks `JIRA_MENTIONS_WINDOW_DAYS` back, so
 * one whose COMMENT (`created`, not `dismissedAt`) is older than that can never matter again. Pruning at save keeps the file small with no timer, relative to
 * `Date.now()` at that save — plus `PRUNE_GRACE_MS`, because "older than the window" is judged at two different instants. The cache's candidates were
 * judged at CHECK time and the route proves a dismissal against them; this prune runs at SAVE time. A mention whose `created` crosses `now - 30d` between
 * the two would pass the proof, be written, and be pruned by the very save that wrote it: the route answers 200 while the ticket stays in `issues` until the
 * next successful check drops it as out of window — a Dismiss that looks ignored for up to a poll interval, longer while Jira is failing (a failed check
 * keeps the old rows). A day's grace covers a full poll interval many times over and a day of failed checks besides, and costs at most a day's dismissals
 * of extra file — nothing the list can show, since applying a dismissal to a comment no cached ticket carries is a no-op.
 *
 * **Drafts ride in the same file (plan ruling R5).** `drafts` is an OPTIONAL array of `{ key, text, sessionId, at }` beside `dismissed`, one per ticket: a
 * file without it reads as no drafts, and a bad entry (no valid key, no text or one past `JIRA_REPLY_MAX_CHARS`, a session id that is not one, an `at` that does
 * not parse) costs only itself. The version stays 1 — phase-1 code reading a phase-2 file ignores the unknown key, and a rollback loses nothing it ever knew.
 * Drafts prune on every save by `at`, on the dismissals' clock and with their grace, so a reply nobody posted does not outlive the mentions it answers.
 * Every save writes BOTH lists (a dismiss keeps the drafts, a draft keeps the dismissals), because the file is one document.
 *
 * **A write that throws changes nothing in memory**: the next list is built aside, written, and only then swapped in, so the route answering 5xx never leaves
 * the list claiming a dismissal the file does not hold. Validating ids and keys is the route's job; the store trusts its caller's shape.
 */

/** The only schema version this code reads or writes. */
export const JIRA_MENTIONS_VERSION = 1;

/** How far past the window a dismissal is kept before the prune drops it (header: the window is judged at check time, the prune at save time). */
export const PRUNE_GRACE_MS = 86_400_000;

/** One dismissed mention comment. `created` is the comment's own instant (what the prune reads), `dismissedAt` when the person dismissed it. */
export interface JiraDismissal {
  commentId: string;
  key: string;
  created: string;
  dismissedAt: string;
}

/** The file, or `BM_JIRA_MENTIONS_FILE` when set — in `settings/`, the one subtree of `~/.backlog-manager` the compose stack mounts read-write. */
export function jiraMentionsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_JIRA_MENTIONS_FILE || join(homedir(), '.backlog-manager', 'settings', 'jira-mentions.json');
}

/** One stored draft: the payload's `JiraMentionDraft` plus the ticket it belongs to (one per key). */
export interface JiraDraftEntry extends JiraMentionDraft {
  key: string;
}

type Read = { kind: 'missing' } | { kind: 'bad'; why: string } | { kind: 'ok'; dismissed: JiraDismissal[]; drafts: JiraDraftEntry[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const parses = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

function readEntry(raw: unknown, file: string, index: number): JiraDismissal | null {
  const drop = (why: string): null => {
    console.warn(`${file}: dismissal #${index} ${why} — dropped, the rest load`);
    return null;
  };
  if (!isRecord(raw)) return drop('is not an object');
  if (typeof raw.commentId !== 'string' || raw.commentId === '') return drop('has no commentId');
  if (!isJiraKey(raw.key)) return drop('has no valid key');
  if (!parses(raw.created)) return drop('has no valid created');
  if (!parses(raw.dismissedAt)) return drop('has no valid dismissedAt');
  return { commentId: raw.commentId, key: raw.key, created: raw.created, dismissedAt: raw.dismissedAt };
}

function readDraft(raw: unknown, file: string, index: number): JiraDraftEntry | null {
  const drop = (why: string): null => {
    console.warn(`${file}: draft #${index} ${why} — dropped, the rest load`);
    return null;
  };
  if (!isRecord(raw)) return drop('is not an object');
  if (!isJiraKey(raw.key)) return drop('has no valid key');
  if (typeof raw.text !== 'string' || raw.text.trim() === '' || raw.text.length > JIRA_REPLY_MAX_CHARS) return drop('has no valid text');
  if (!isSessionId(raw.sessionId)) return drop('has no valid sessionId');
  if (!parses(raw.at)) return drop('has no valid at');
  return { key: raw.key, text: raw.text, sessionId: raw.sessionId, at: raw.at };
}

function readFile(file: string): Read {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'bad', why: 'cannot be read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'bad', why: 'does not parse as JSON' };
  }
  if (!isRecord(raw)) return { kind: 'bad', why: 'is not a JSON object' };
  if (raw.version !== JIRA_MENTIONS_VERSION) return { kind: 'bad', why: `has version ${JSON.stringify(raw.version)}, not ${JIRA_MENTIONS_VERSION}` };
  if (!Array.isArray(raw.dismissed)) return { kind: 'bad', why: 'has no dismissed array' };
  const seen = new Set<string>();
  const dismissed: JiraDismissal[] = [];
  raw.dismissed.forEach((e, i) => {
    const d = readEntry(e, file, i);
    if (d === null || seen.has(d.commentId)) return; // the comment id is the identity; the first wins
    seen.add(d.commentId);
    dismissed.push(d);
  });
  const drafts: JiraDraftEntry[] = [];
  // `drafts` is optional (R5): absent is no drafts, and a value that is not an array is read the same — it costs the drafts, never the dismissals.
  if (Array.isArray(raw.drafts)) {
    const keys = new Set<string>();
    raw.drafts.forEach((e, i) => {
      const d = readDraft(e, file, i);
      if (d === null || keys.has(d.key)) return; // one draft per ticket; the first wins
      keys.add(d.key);
      drafts.push(d);
    });
  }
  return { kind: 'ok', dismissed, drafts };
}

@Injectable()
export class JiraMentionsStore {
  private list: JiraDismissal[];
  private drafts: JiraDraftEntry[];

  constructor() {
    const file = jiraMentionsFile();
    const read = readFile(file);
    if (read.kind === 'bad') console.warn(`${file}: ${read.why} — starting with no dismissals; the file is set aside at the first save`);
    this.list = read.kind === 'ok' ? read.dismissed : [];
    this.drafts = read.kind === 'ok' ? read.drafts : [];
  }

  dismissed(): readonly JiraDismissal[] {
    return this.list;
  }

  isDismissed(commentId: string): boolean {
    return this.list.some((d) => d.commentId === commentId);
  }

  /** Adds the entries, replacing any with the same comment id. Throws when the write fails, memory unchanged. */
  dismiss(entries: JiraDismissal[]): void {
    const ids = new Set(entries.map((e) => e.commentId));
    this.save([...this.list.filter((d) => !ids.has(d.commentId)), ...entries], this.drafts);
  }

  /** Drops every dismissal of the key and returns how many went; none means no write. Throws when the write fails, memory unchanged. */
  restore(key: string): number {
    const next = this.list.filter((d) => d.key !== key);
    const dropped = this.list.length - next.length;
    if (dropped > 0) this.save(next, this.drafts);
    return dropped;
  }

  /** The ticket's waiting draft, or `null`. */
  draftFor(key: string): JiraMentionDraft | null {
    const d = this.drafts.find((e) => e.key === key);
    return d === undefined ? null : { text: d.text, at: d.at, sessionId: d.sessionId };
  }

  /** Stores the draft, replacing the ticket's earlier one. Throws when the write fails, memory unchanged. */
  setDraft(key: string, draft: JiraMentionDraft): void {
    this.save(this.list, [...this.drafts.filter((e) => e.key !== key), { key, text: draft.text, sessionId: draft.sessionId, at: draft.at }]);
  }

  /** Drops the ticket's draft; false (and no write) when there was none. Throws when the write fails, memory unchanged. */
  dropDraft(key: string): boolean {
    if (!this.drafts.some((e) => e.key === key)) return false;
    this.save(this.list, this.drafts.filter((e) => e.key !== key));
    return true;
  }

  private save(next: JiraDismissal[], nextDrafts: JiraDraftEntry[]): void {
    const cutoff = Date.now() - JIRA_MENTIONS_WINDOW_DAYS * 86_400_000 - PRUNE_GRACE_MS;
    const kept = next.filter((d) => Date.parse(d.created) >= cutoff);
    const keptDrafts = nextDrafts.filter((d) => Date.parse(d.at) >= cutoff);
    const file = jiraMentionsFile();
    if (existsSync(file) && readFile(file).kind === 'bad') renameSync(file, `${file}.bad-${new Date().toISOString()}`);
    writeJsonAtomic(file, { version: JIRA_MENTIONS_VERSION, dismissed: kept, drafts: keptDrafts });
    this.list = kept;
    this.drafts = keptDrafts;
  }
}
