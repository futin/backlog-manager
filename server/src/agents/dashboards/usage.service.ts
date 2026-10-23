import { Injectable } from '@nestjs/common';

import type { MachineUsage } from '../../../../shared/types';
import { authHeaders, type AgentsConfig } from '../config.util';
import type { Machine } from './dashboards.service';

/** Per outbound request, not per `read`: the account and profile fetches run side by side, so a hung dashboard costs one timeout, not two. */
export const USAGE_TIMEOUT_MS = 5_000;
/** An answer younger than this is served from memory; the offers route asks on every sheet open, and a dashboard's gauge does not move that fast. */
export const USAGE_TTL_MS = 60_000;
/** Past this a figure is a guess about a window that has moved on: it reads as no usage, its age still shown (spec: "older than the cache's freshness limit"). */
export const USAGE_FRESH_MS = 10 * 60_000;

interface Answer {
  /** `null` is an ANSWER too — signed out, `SHOW_USAGE` off, a window with no figure — and it ages and expires like a number does. */
  usage: MachineUsage | null;
  atMs: number;
}

/**
 * Every dashboard's usage, read server to server (the browser never talks to a dashboard) from the two routes the dashboard already has — `GET /api/account` for
 * the 5 h and weekly utilization and `GET /api/usage/profile` for the weekly projection — so `claude-agents-dashboard` changes nowhere. Cached per dashboard
 * `url` for 60 s with one pair of requests in flight per key: Task 4's offers call `read` for every machine on every sheet open, and two sheets opened together
 * must not double the load on a dashboard that is already the slow one.
 *
 * `read` NEVER throws. A new outbound read is data on failure (global constraints): a refetch that fails keeps the previous answer, which keeps ageing, so one
 * dropped request does not blank a card; and once that answer passes the freshness limit it reads as `usage: null` with its age. Only an answer that was never
 * obtained is `ageMs: null`. A failed refetch is NOT remembered as an attempt — the next `read` past the TTL tries again — because a back-off would make a
 * dashboard that comes back wait out the timer to be believed.
 *
 * The timeout is a plain `setTimeout` raced against the fetch, with an `AbortController` to release the socket, rather than `AbortSignal.timeout` (what
 * `AgentsService.get` uses): that one runs on an internal timer jest's fake clock cannot advance, and the hang case in the tests must be provable without
 * waiting five real seconds.
 */
@Injectable()
export class UsageService {
  private readonly answers = new Map<string, Answer>();
  private readonly inFlight = new Map<string, Promise<void>>();

  async read(m: Machine, nowMs: number): Promise<{ usage: MachineUsage | null; ageMs: number | null }> {
    const key = m.cfg.url;
    const held = this.answers.get(key);
    if (held === undefined || nowMs - held.atMs > USAGE_TTL_MS) await this.refresh(key, m.cfg, nowMs);
    const answer = this.answers.get(key);
    if (answer === undefined) return { usage: null, ageMs: null };
    // Clamped at 0: a read that joined an in-flight fetch can carry an earlier `nowMs` than the answer it receives.
    const ageMs = Math.max(0, nowMs - answer.atMs);
    return { usage: ageMs > USAGE_FRESH_MS ? null : answer.usage, ageMs };
  }

  private refresh(key: string, cfg: AgentsConfig, nowMs: number): Promise<void> {
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.fetchPair(cfg, nowMs)
      .then((answer) => {
        if (answer) this.answers.set(key, answer);
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /** `null` is "no answer" (the account route failed); the profile failing only costs the projection. */
  private async fetchPair(cfg: AgentsConfig, nowMs: number): Promise<Answer | null> {
    const [account, profile] = await Promise.allSettled([getJson(cfg, '/api/account'), getJson(cfg, '/api/usage/profile')]);
    if (account.status === 'rejected') return null;
    return { usage: readUsage(account.value, profile.status === 'fulfilled' ? profile.value : null, nowMs), atMs: nowMs };
  }
}

async function getJson(cfg: AgentsConfig, path: string): Promise<unknown> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`${path} timed out after ${USAGE_TIMEOUT_MS / 1000} s`));
    }, USAGE_TIMEOUT_MS);
  });
  const request = (async () => {
    const res = await fetch(`${cfg.url}${path}`, { headers: authHeaders(cfg), signal: abort.signal });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as unknown;
  })();
  // `race` subscribes to both, so the loser's later rejection (the abort) is handled and never surfaces as an unhandled rejection.
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/** A window counts only with a numeric utilization; above 100 clamps (the dashboard can report over-limit), below 0 is nonsense and clamps too. */
function readWindow(v: unknown): { pct: number; resetsAt: string | null } | null {
  if (!isRecord(v) || typeof v.utilization !== 'number' || !Number.isFinite(v.utilization)) return null;
  return { pct: Math.min(100, Math.max(0, v.utilization)), resetsAt: isoOrNull(v.resetsAt) };
}

function readUsage(account: unknown, profile: unknown, nowMs: number): MachineUsage | null {
  if (!isRecord(account) || account.usageStatus !== 'ok' || !isRecord(account.usage)) return null;
  const fiveHour = readWindow(account.usage.fiveHour);
  const week = readWindow(account.usage.sevenDay);
  if (!fiveHour || !week) return null;
  const { projection, exhaustAt } = readProjection(profile, nowMs);
  return { fiveHour, week, projection, exhaustAt, fetchedAt: new Date(nowMs).toISOString() };
}

/**
 * The weekly projection, from the profile's own `resetsAt` (the reset its `exhaustAt` walk ran against) — never the account's, so the two times compared were
 * produced together. A past reset reads `unknown` BEFORE anything else: the walk returns `exhaustAt: null` for a reset that has already gone by, which must not
 * read as "does not run out". Likewise a `walkAbsent` reason, a missing reset and a failed profile fetch are all `unknown`, never `safe`.
 */
function readProjection(profile: unknown, nowMs: number): { projection: MachineUsage['projection']; exhaustAt: string | null } {
  if (!isRecord(profile)) return { projection: 'unknown', exhaustAt: null };
  const resetsAt = isoOrNull(profile.resetsAt);
  const exhaustAt = isoOrNull(profile.exhaustAt);
  if (resetsAt === null || Date.parse(resetsAt) <= nowMs) return { projection: 'unknown', exhaustAt };
  if (exhaustAt !== null) return { projection: Date.parse(exhaustAt) < Date.parse(resetsAt) ? 'runs-out' : 'safe', exhaustAt };
  return { projection: profile.walkAbsent === null || profile.walkAbsent === undefined ? 'safe' : 'unknown', exhaustAt: null };
}
