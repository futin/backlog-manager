import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../atomic-write.util';
import { JIRA_MENTIONS_WINDOW_DAYS, isJiraKey } from '../../../shared/types';

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
 * `Date.now()` at that save.
 *
 * **A write that throws changes nothing in memory**: the next list is built aside, written, and only then swapped in, so the route answering 5xx never leaves
 * the list claiming a dismissal the file does not hold. Validating ids and keys is the route's job; the store trusts its caller's shape.
 */

/** The only schema version this code reads or writes. */
export const JIRA_MENTIONS_VERSION = 1;

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

type Read = { kind: 'missing' } | { kind: 'bad'; why: string } | { kind: 'ok'; dismissed: JiraDismissal[] };

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
  return { kind: 'ok', dismissed };
}

@Injectable()
export class JiraMentionsStore {
  private list: JiraDismissal[];

  constructor() {
    const file = jiraMentionsFile();
    const read = readFile(file);
    if (read.kind === 'bad') console.warn(`${file}: ${read.why} — starting with no dismissals; the file is set aside at the first save`);
    this.list = read.kind === 'ok' ? read.dismissed : [];
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
    this.save([...this.list.filter((d) => !ids.has(d.commentId)), ...entries]);
  }

  /** Drops every dismissal of the key and returns how many went; none means no write. Throws when the write fails, memory unchanged. */
  restore(key: string): number {
    const next = this.list.filter((d) => d.key !== key);
    const dropped = this.list.length - next.length;
    if (dropped > 0) this.save(next);
    return dropped;
  }

  private save(next: JiraDismissal[]): void {
    const cutoff = Date.now() - JIRA_MENTIONS_WINDOW_DAYS * 86_400_000;
    const kept = next.filter((d) => Date.parse(d.created) >= cutoff);
    const file = jiraMentionsFile();
    if (existsSync(file) && readFile(file).kind === 'bad') renameSync(file, `${file}.bad-${new Date().toISOString()}`);
    writeJsonAtomic(file, { version: JIRA_MENTIONS_VERSION, dismissed: kept });
    this.list = kept;
  }
}
