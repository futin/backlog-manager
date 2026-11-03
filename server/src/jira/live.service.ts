import { Injectable } from '@nestjs/common';

import { jiraSessionName } from '../../../shared/types';
import type { DashboardRow, JiraEndReason, JiraLink, JiraLiveSession } from '../../../shared/types';
import { loadLinks, saveLinks } from './links.store';
import type { JiraLinkPair } from './links.store';

/** At most this many LIVE entries are remembered; one more evicts the oldest confirmed one (spec §3, C6). */
export const JIRA_LIVE_CAP = 100;

/** A live entry older than this is ended as `expired`: a session that long outlived whatever the reconciler could still see of it (spec §3, §5). */
export const JIRA_LIVE_TTL_MS = 8 * 3600_000;

/** C6: per ticket, the newest this many ENDED links are kept (live ones always are)… */
export const JIRA_HISTORY_PER_KEY = 20;

/** …and a ticket whose newest ended link is older than this, with nothing live, is dropped whole. */
export const JIRA_HISTORY_MAX_AGE_MS = 90 * 24 * 3600_000;

/** The suppressed and never-link lists are bounded too, oldest first — they only ever grow otherwise, and a pair that old will not come back. */
export const JIRA_PAIR_LIST_CAP = 1000;

/** What `confirm` is given beyond the ids: the launch's own facts, for the link it turns the reservation into. */
export type JiraConfirmMeta = Pick<JiraLink, 'action' | 'name' | 'branch' | 'surface' | 'model' | 'effort' | 'snapshot'>;

/** A Run reserved on a key whose dashboard has not answered yet. Memory only, never written — a restart drops it and the key is free again (spec §5). */
interface Starting {
  repo: string;
  /** `Date.now()` at `reserve`, in ms. */
  startedAt: number;
}

/** A Jira page whose last read is this recent counts as open: the reconciler then ticks every 15 s instead of every 60 s (spec §6). Inclusive at the edge. */
export const JIRA_PAGE_OPEN_MS = 30_000;

const same = (a: JiraLinkPair, key: string, sessionId: string): boolean => a.key === key && a.sessionId === sessionId;

/**
 * Which Jira tickets have a session linked to them — live and ended (Jira sessions, spec §5; it grew out of phase 5's memory-only live map). The state is the
 * link store's file (`links.store.ts`, `~/.backlog-manager/jira-links.json`) held in memory: it is loaded once at construction and every change but a
 * `starting` reservation writes the whole file again. A write that fails is logged and costs nothing else — the memory is the truth for this run of the server,
 * and a launch must never fail because a history file could not be saved. Keeping it free of `agents/` and of the poller means `jira/` gains no new
 * dependency: `AgentsModule` already imports `JiraModule`, so the dispatch reserves, confirms or releases through this provider, the reconciler reads
 * `confirmed()` and ends entries, and the controller composes `live` / `session` from `snapshot()`. The poller never sees it.
 *
 * The one-run gate is unchanged and `run`-only. A Run is `starting` from `reserve` until `confirm` hands it the dashboard's session id; `reserve` is a
 * synchronous check-and-set, so two concurrent dispatches for the same key cannot both pass it, and it ignores `branch` and `manual` links, which the user
 * started outside this board. `get`, `snapshot`, `confirmed` and `hasConfirmed` read the `run` entries alone, for the same reason: their readers (the gate, Stop's
 * starting check, the run chip) are about the Run on the key, and a detected branch link showing through them would block a Run or offer a Stop that is not
 * the board's to give. `release` undoes a reserve whose spawn failed and refuses to touch a confirmed entry — a late failure path must never drop a session
 * that did start.
 *
 * The dashboard rows the reconciler last read live here too, in memory only (`setRows`, `rowFor`, `reachable`), with the time a Jira page was last read
 * (`notePageRead`, `pageOpen`), which sets the reconciler's pace. None of it is persisted: it is a cache of the dashboard's state, never a link.
 *
 * An entry that ENDS stays as history (`end`, with a reason), and stays ended: a late `confirm` for a pair that has ended does not revive it. Only `reattach`
 * does, from the dashboard's own row (spec C5), and it re-opens the pair's own entry rather than adding one. `unlink` removes a `branch`/`manual` link and
 * remembers the pair so detection never re-adds it (C9); it refuses a `run` link, because dropping one would free the one-run gate under a live session.
 * Retention is C6's and runs on every save: per ticket the live entries and the 20 newest ended ones, and a ticket idle for 90 days with nothing live goes.
 *
 * Time is `Date.now()`, never `new Date()`, like the poller (`poller.service.ts`), so a suite that sets the system time moves expiry and eviction with it.
 * The 8-hour backstop is applied lazily at the top of every call rather than by a timer: there is nothing to arm, and no call can observe an expired entry.
 *
 * Eviction at the cap is oldest-first by `startedAt` but NEVER takes a `starting` entry (plan ruling R6): a starting key has a spawn in flight that will
 * `confirm` or `release` it, and evicting it would let a second dispatch pass the gate while the first is still launching. When every entry is starting,
 * `reserve` returns false instead — the caller reads that as "busy", the same as a duplicate. An evicted entry is not deleted: it ends as `expired`, so it
 * keeps its line in the history like any other session that outlived what the reconciler could see.
 */
@Injectable()
export class JiraLiveService {
  private readonly starting = new Map<string, Starting>();
  private entries: JiraLink[];
  private suppressed: JiraLinkPair[];
  private neverLink: JiraLinkPair[];
  private rows = new Map<string, DashboardRow>();
  private rowsAtMs: number | null = null;
  private up = true;
  private pageReadAt: number | null = null;

  constructor() {
    const state = loadLinks();
    this.entries = state.links;
    this.suppressed = state.suppressed;
    this.neverLink = state.neverLink;
  }

  /** Claims `key` for a Run in `repo`. False when a live `run` entry already holds it, or the store is full of starting entries. */
  reserve(key: string, repo: string): boolean {
    this.expire();
    if (this.starting.has(key) || this.liveRun(key).length > 0) return false;
    if (this.liveCount() >= JIRA_LIVE_CAP && !this.evictOldestConfirmed()) return false;
    this.starting.set(key, { repo, startedAt: Date.now() });
    return true;
  }

  /**
   * The dashboard answered: the reservation on `key` becomes a `run` link with `sessionId`. A key that was released or expired in the meantime stays gone —
   * nothing is resurrected — and so does a pair that has already ended: it keeps its end.
   */
  confirm(key: string, sessionId: string, meta: JiraConfirmMeta): void {
    this.expire();
    const reserved = this.starting.get(key);
    if (reserved === undefined) return;
    this.starting.delete(key);
    const existing = this.find(key, sessionId);
    if (existing !== undefined) {
      // The board's own Run met the same session already linked by detection or by hand: it becomes the Run (one entry, the Run's meta merged in, its
      // reservation consumed above), so the one-run gate sees it. Anything else — an ended pair — keeps its end.
      if (existing.endedAt === null && existing.how !== 'run') {
        existing.how = 'run';
        existing.action = meta.action;
        existing.name = meta.name;
        existing.repo = reserved.repo;
        existing.branch = meta.branch;
        existing.surface = meta.surface;
        existing.model = meta.model;
        existing.effort = meta.effort;
        existing.snapshot = { ...meta.snapshot };
        this.persist();
      }
      return;
    }
    this.entries.push({
      key,
      sessionId,
      how: 'run',
      action: meta.action,
      name: meta.name,
      repo: reserved.repo,
      branch: meta.branch,
      surface: meta.surface,
      model: meta.model,
      effort: meta.effort,
      snapshot: { ...meta.snapshot },
      startedAt: new Date(reserved.startedAt).toISOString(),
      endedAt: null,
      endReason: null,
      quietSince: null,
      reattachedAt: null
    });
    this.persist();
  }

  /** Drops a `starting` Run — the spawn failed. A confirmed one, and any `branch`/`manual` link, is left alone. */
  release(key: string): void {
    this.starting.delete(key);
  }

  /** The key's live `run` entry, `starting` included; a live `branch`/`manual` link never shows through. */
  get(key: string): { sessionId: string | null; repo: string; startedAt: string } | null {
    this.expire();
    const reserved = this.starting.get(key);
    if (reserved !== undefined) return { sessionId: null, repo: reserved.repo, startedAt: new Date(reserved.startedAt).toISOString() };
    const run = this.liveRun(key).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    return run === undefined ? null : { sessionId: run.sessionId, repo: run.repo, startedAt: run.startedAt };
  }

  /** The `live` field of `GET /api/jira`: every live `run` entry, `starting` included, `branch`/`manual` links not (their readers arrive with the List). */
  snapshot(): Record<string, JiraLiveSession> {
    this.expire();
    const out: Record<string, JiraLiveSession> = {};
    for (const l of this.entries) {
      if (l.how === 'run' && l.endedAt === null) {
        out[l.key] = { name: l.name, sessionId: l.sessionId, startedAt: l.startedAt, repo: l.repo, starting: false };
      }
    }
    for (const [key, s] of this.starting) {
      out[key] = { name: jiraSessionName(key), sessionId: null, startedAt: new Date(s.startedAt).toISOString(), repo: s.repo, starting: true };
    }
    return out;
  }

  /** The live `run` entries that hold a session id — what the reconciler asks the dashboard about. A starting entry has nothing to ask for. */
  confirmed(): { key: string; sessionId: string; startedAt: string }[] {
    this.expire();
    return this.entries
      .filter((l) => l.how === 'run' && l.endedAt === null)
      .map((l) => ({ key: l.key, sessionId: l.sessionId as string, startedAt: l.startedAt }));
  }

  /** Whether any live `run` entry holds a session id. */
  hasConfirmed(): boolean {
    this.expire();
    return this.entries.some((l) => l.how === 'run' && l.endedAt === null);
  }

  /** Every link, live and ended, as copies: a caller cannot move the store by editing what it got. */
  links(): JiraLink[] {
    this.expire();
    return this.entries.map(copy);
  }

  /** The live links, any `how`. */
  liveLinks(): JiraLink[] {
    this.expire();
    return this.entries.filter((l) => l.endedAt === null).map(copy);
  }

  /** Whether any link is live (a `starting` reservation has nothing to reconcile and does not count) — what keeps the reconciler armed. */
  hasLive(): boolean {
    this.expire();
    return this.entries.some((l) => l.endedAt === null);
  }

  /** Ends the live pair with `reason` and keeps it as history. False when that pair is not live (absent, or already ended — an ended entry keeps its first end). */
  end(key: string, sessionId: string, reason: JiraEndReason, now: number = Date.now()): boolean {
    this.expire();
    const link = this.find(key, sessionId);
    if (link === undefined || link.endedAt !== null) return false;
    this.endLink(link, reason, now);
    this.persist();
    return true;
  }

  /** C5: the pair's own entry is live again — `endedAt`, the reason and `quietSince` cleared, nothing added. False when the store has no such pair. */
  reattach(key: string, sessionId: string, now: number = Date.now()): boolean {
    this.expire();
    const link = this.find(key, sessionId);
    if (link === undefined) return false;
    link.endedAt = null;
    link.endReason = null;
    link.quietSince = null;
    link.reattachedAt = new Date(now).toISOString();
    this.persist();
    return true;
  }

  /**
   * Adds a detected (`branch`) or hand-made (`manual`) link, live. `suppressed` when a person unlinked this pair, `exists` when the pair is already in the
   * store, live or ended — a pair that ended comes back through `reattach`, never through here. A `run` link is made only by `reserve` + `confirm`, which is
   * the one-run gate; adding one here would walk round it.
   */
  addLink(link: Omit<JiraLink, 'endedAt' | 'endReason' | 'quietSince' | 'reattachedAt'>): 'added' | 'exists' | 'suppressed' {
    if (link.how === 'run' || link.sessionId === null) throw new Error('addLink takes a branch or manual link with a session id');
    this.expire();
    if (this.isSuppressed(link.key, link.sessionId)) return 'suppressed';
    if (this.find(link.key, link.sessionId) !== undefined) return 'exists';
    if (this.liveCount() >= JIRA_LIVE_CAP) this.evictOldestConfirmed();
    this.entries.push({ ...copy({ ...link, endedAt: null, endReason: null, quietSince: null, reattachedAt: null }) });
    this.persist();
    return 'added';
  }

  /** Removes a `branch`/`manual` link and remembers the pair so detection never re-adds it (C9). `run` refuses — only Stop ends one — and `missing` is no such pair. */
  unlink(key: string, sessionId: string): 'removed' | 'missing' | 'run' {
    this.expire();
    const link = this.find(key, sessionId);
    if (link === undefined) return 'missing';
    if (link.how === 'run') return 'run';
    this.entries = this.entries.filter((l) => l !== link);
    this.remember(this.suppressed, key, sessionId);
    this.persist();
    return 'removed';
  }

  isSuppressed(key: string, sessionId: string): boolean {
    return this.suppressed.some((p) => same(p, key, sessionId));
  }

  /** Lifts a suppression — an explicit `/jira link` of the pair is the person changing their mind. */
  unsuppress(key: string, sessionId: string): void {
    const before = this.suppressed.length;
    this.suppressed = this.suppressed.filter((p) => !same(p, key, sessionId));
    if (this.suppressed.length !== before) this.persist();
  }

  /** Jira answered 404 for `key`: detection never asks about this pair again. */
  markNeverLink(key: string, sessionId: string): void {
    if (this.isNeverLink(key, sessionId)) return;
    this.remember(this.neverLink, key, sessionId);
    this.persist();
  }

  isNeverLink(key: string, sessionId: string): boolean {
    return this.neverLink.some((p) => same(p, key, sessionId));
  }

  /**
   * The first tick that saw the pair neither `working` nor `question`. Keeps an earlier value — the 120 s clock runs from the FIRST quiet tick, and every later
   * tick of the same quiet spell must not restart it — so only the first call after a `clearQuiet` writes, and a steady tick costs no file write.
   */
  markQuiet(key: string, sessionId: string, at: string): void {
    const link = this.find(key, sessionId);
    if (link === undefined || link.endedAt !== null || link.quietSince !== null) return;
    link.quietSince = at;
    this.persist();
  }

  /** A tick saw the pair active again. A no-op, and no write, when it was not quiet. */
  clearQuiet(key: string, sessionId: string): void {
    const link = this.find(key, sessionId);
    if (link === undefined || link.quietSince === null) return;
    link.quietSince = null;
    this.persist();
  }

  /**
   * The rows of the reconciler's latest good read of the dashboard, and when it was made. Memory only — they are a cache of someone else's state, rebuilt by the
   * next tick, and a restart starts with none. `markUnreachable` is the other outcome of a tick: the dashboard did not answer, so the rows kept are old and the
   * board says so, but nothing about any link changes.
   */
  setRows(rows: DashboardRow[], at: number): void {
    this.rows = new Map(rows.map((r) => [r.id, r]));
    this.rowsAtMs = at;
    this.up = true;
  }

  /** ISO time of the latest good read, or null before there has been one. */
  rowsAt(): string | null {
    return this.rowsAtMs === null ? null : new Date(this.rowsAtMs).toISOString();
  }

  /** The dashboard's row for `sessionId` from the latest good read, or undefined (absent from it, or no read yet). */
  rowFor(sessionId: string): DashboardRow | undefined {
    return this.rows.get(sessionId);
  }

  /** The latest tick could not read the dashboard. The previous rows stay, so a page can still show them, flagged stale. */
  markUnreachable(_at: number): void {
    this.up = false;
  }

  /** False only after a tick that could not read the dashboard, until the next good one; true before any tick has run — nothing has failed yet. */
  reachable(): boolean {
    return this.up;
  }

  /** A Jira page was read at `now` (`GET /api/jira/sessions?open=1` is its caller), so the reconciler can tell a page is open. */
  notePageRead(now: number): void {
    this.pageReadAt = now;
  }

  /** A page read within the last 30 s. */
  pageOpen(now: number): boolean {
    return this.pageReadAt !== null && now - this.pageReadAt <= JIRA_PAGE_OPEN_MS;
  }

  private find(key: string, sessionId: string): JiraLink | undefined {
    return this.entries.find((l) => l.key === key && l.sessionId === sessionId);
  }

  private liveRun(key: string): JiraLink[] {
    return this.entries.filter((l) => l.key === key && l.how === 'run' && l.endedAt === null);
  }

  private liveCount(): number {
    return this.starting.size + this.entries.filter((l) => l.endedAt === null).length;
  }

  private endLink(link: JiraLink, reason: JiraEndReason, now: number): void {
    link.endedAt = new Date(now).toISOString();
    link.endReason = reason;
    link.quietSince = null;
  }

  private remember(list: JiraLinkPair[], key: string, sessionId: string): void {
    list.push({ key, sessionId });
    if (list.length > JIRA_PAIR_LIST_CAP) list.splice(0, list.length - JIRA_PAIR_LIST_CAP);
  }

  /**
   * The 8-hour backstop: a live entry strictly older than the TTL ends as `expired` (an exactly-8-hour-old one is still live, one millisecond more is not), and
   * a `starting` one is dropped — it never reached the file, and its spawn will find the key free.
   */
  private expire(): void {
    const now = Date.now();
    const cutoff = now - JIRA_LIVE_TTL_MS;
    for (const [key, s] of this.starting) if (s.startedAt < cutoff) this.starting.delete(key);
    let changed = false;
    for (const l of this.entries) {
      // The clock restarts at a re-attach: an entry the dashboard shows working again has just proved it is not the stale thing the backstop is for.
      const since = Math.max(Date.parse(l.startedAt), l.reattachedAt === null ? 0 : Date.parse(l.reattachedAt));
      if (l.endedAt === null && since < cutoff) {
        this.endLink(l, 'expired', now);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Ends the confirmed live entry with the smallest `startedAt` as `expired` (the earlier-inserted wins a tie); false when there is none. */
  private evictOldestConfirmed(): boolean {
    let oldest: JiraLink | undefined;
    for (const l of this.entries) {
      if (l.endedAt === null && (oldest === undefined || Date.parse(l.startedAt) < Date.parse(oldest.startedAt))) oldest = l;
    }
    if (oldest === undefined) return false;
    this.endLink(oldest, 'expired', Date.now());
    this.persist(); // the end is a change like any other: a restart must not bring the evicted entry back live
    return true;
  }

  /** C6, in memory first so the file and the next read agree: per key every live entry and the 20 newest ended; a key idle 90 days with nothing live is dropped. */
  private retain(): void {
    const cutoff = Date.now() - JIRA_HISTORY_MAX_AGE_MS;
    const byKey = new Map<string, JiraLink[]>();
    for (const l of this.entries) byKey.set(l.key, [...(byKey.get(l.key) ?? []), l]);
    const keep = new Set<JiraLink>();
    for (const group of byKey.values()) {
      const live = group.filter((l) => l.endedAt === null);
      const ended = group.filter((l) => l.endedAt !== null).sort((a, b) => Date.parse(b.endedAt as string) - Date.parse(a.endedAt as string));
      for (const l of live) keep.add(l);
      if (live.length === 0 && ended.length > 0 && Date.parse(ended[0].endedAt as string) < cutoff) continue;
      for (const l of ended.slice(0, JIRA_HISTORY_PER_KEY)) keep.add(l);
    }
    this.entries = this.entries.filter((l) => keep.has(l));
  }

  private persist(): void {
    this.retain();
    try {
      saveLinks({ links: this.entries, suppressed: this.suppressed, neverLink: this.neverLink });
    } catch (err) {
      console.warn(`jira links not saved: ${(err as Error).message}`);
    }
  }
}

function copy(l: JiraLink): JiraLink {
  return { ...l, action: l.action !== null && typeof l.action === 'object' ? { ...l.action } : l.action, snapshot: { ...l.snapshot } };
}
