import { Injectable } from '@nestjs/common';

import { jiraSessionName } from '../../../shared/types';
import type { JiraLiveSession } from '../../../shared/types';

/** At most this many keys are remembered; one more evicts the oldest confirmed entry (spec §3). */
export const JIRA_LIVE_CAP = 100;

/** An entry older than this counts as absent: a session that long outlived whatever the reconciler could still see of it (spec §3). */
export const JIRA_LIVE_TTL_MS = 8 * 3600_000;

interface Entry {
  /** `null` while `starting`: the key is reserved but the dashboard has not answered with a session id yet. */
  sessionId: string | null;
  repo: string;
  /** `Date.now()` at `reserve`, in ms — the age and the eviction order both read it. */
  startedAt: number;
}

/**
 * Which Jira keys have a Run session going (Jira phase 5; spec §3 "live map", §4 `live` and `session`). Memory only and no I/O, on purpose: a restart forgets
 * every entry, Stop clears one early, and the 8-hour expiry is the backstop for a session nobody stopped. Keeping it free of `agents/` and of the poller means
 * `jira/` gains no new dependency — `AgentsModule` already imports `JiraModule`, so the dispatch route reserves, confirms or releases through this provider,
 * the reconciler reads `confirmed()`, and the controller composes `live` / `session` from `snapshot()`. The poller never sees it.
 *
 * An entry is `starting` from `reserve` until `confirm` hands it the dashboard's session id. `reserve` is the one-run-per-ticket gate: it is a synchronous
 * check-and-set, so two concurrent dispatches for the same key cannot both pass it. `release` undoes a reserve whose spawn failed and refuses to touch a
 * confirmed entry — a late failure path must never drop a session that did start. `clear` is the unconditional removal (Stop, or the reconciler finding the
 * session gone).
 *
 * Time is `Date.now()`, never `new Date()`, like the poller (`poller.service.ts`), so a suite that sets the system time moves expiry and eviction with it.
 * Expired entries are dropped lazily at the top of every call rather than by a timer: there is nothing to arm, and no call can observe an expired entry.
 *
 * Eviction at the cap is oldest-first by `startedAt` but NEVER takes a `starting` entry (plan ruling R6): a starting key has a spawn in flight that will
 * `confirm` or `release` it, and evicting it would let a second dispatch pass the gate while the first is still launching. When every entry is starting,
 * `reserve` returns false instead — the caller reads that as "busy", the same as a duplicate.
 */
@Injectable()
export class JiraLiveService {
  private readonly entries = new Map<string, Entry>();

  /** Claims `key` for a run in `repo`. False when a live entry already holds it, or the map is full of starting entries. */
  reserve(key: string, repo: string): boolean {
    this.expire();
    if (this.entries.has(key)) return false;
    if (this.entries.size >= JIRA_LIVE_CAP && !this.evictOldestConfirmed()) return false;
    this.entries.set(key, { sessionId: null, repo, startedAt: Date.now() });
    return true;
  }

  /** The dashboard answered: `key` now has a session. A key that was cleared or expired in the meantime stays gone — nothing is resurrected. */
  confirm(key: string, sessionId: string): void {
    this.expire();
    const entry = this.entries.get(key);
    if (entry !== undefined) entry.sessionId = sessionId;
  }

  /** Drops a `starting` entry — the spawn failed. A confirmed one is left alone. */
  release(key: string): void {
    if (this.entries.get(key)?.sessionId === null) this.entries.delete(key);
  }

  /** Drops the entry whatever its state — Stop, or the reconciler finding the session gone. */
  clear(key: string): void {
    this.entries.delete(key);
  }

  get(key: string): { sessionId: string | null; repo: string; startedAt: string } | null {
    this.expire();
    const entry = this.entries.get(key);
    return entry === undefined ? null : { sessionId: entry.sessionId, repo: entry.repo, startedAt: new Date(entry.startedAt).toISOString() };
  }

  /** The `live` field of `GET /api/jira`: every non-expired key, `starting` included. */
  snapshot(): Record<string, JiraLiveSession> {
    this.expire();
    const out: Record<string, JiraLiveSession> = {};
    for (const [key, e] of this.entries) {
      out[key] = { name: jiraSessionName(key), startedAt: new Date(e.startedAt).toISOString(), repo: e.repo, starting: e.sessionId === null };
    }
    return out;
  }

  /** The entries that hold a session id — what the reconciler asks the dashboard about. A starting entry has nothing to ask for. */
  confirmed(): { key: string; sessionId: string; startedAt: string }[] {
    this.expire();
    const out: { key: string; sessionId: string; startedAt: string }[] = [];
    for (const [key, e] of this.entries) {
      if (e.sessionId !== null) out.push({ key, sessionId: e.sessionId, startedAt: new Date(e.startedAt).toISOString() });
    }
    return out;
  }

  /** Whether any entry holds a session id — the reconciler is armed only while this is true. */
  hasConfirmed(): boolean {
    this.expire();
    for (const e of this.entries.values()) if (e.sessionId !== null) return true;
    return false;
  }

  private expire(): void {
    const cutoff = Date.now() - JIRA_LIVE_TTL_MS;
    // Strictly older than the TTL: an entry exactly 8 h old is still live, one millisecond more is not.
    for (const [key, e] of this.entries) if (e.startedAt < cutoff) this.entries.delete(key);
  }

  /** Removes the confirmed entry with the smallest `startedAt` (the earlier-inserted wins a tie); false when there is none. */
  private evictOldestConfirmed(): boolean {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [key, e] of this.entries) {
      if (e.sessionId !== null && e.startedAt < at) {
        oldest = key;
        at = e.startedAt;
      }
    }
    if (oldest === null) return false;
    this.entries.delete(oldest);
    return true;
  }
}
