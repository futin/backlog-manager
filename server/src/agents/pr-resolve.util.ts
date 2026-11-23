import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PrResolveOutcome, PrResolveRequest } from '../../../shared/types';

/*
 * pr-resolve.util.ts — the pure half of the pr-resolve route: the on-disk contract the skill's tool (`skills/pr-resolve/tools/pr-resolve-lib.mjs`) writes and
 * this server only READS, and the trigger and body shapes.
 *
 * The server never imports a skill's tools (skills are self-contained, and the server never reaches into them), so five things here are this side's COPY of
 * the tool's, and a change to any of them is a change to both:
 *
 * - `prResolveHome` — `prResolveHome` in `pr-resolve-lib.mjs`;
 * - `fileKey` — `fileKey` in `pr-resolve-lib.mjs` (`parseFileKey` is its inverse, which the tool has no need of);
 * - the target grammar `parseResolveBody` checks — `TARGET` in `pr-resolve-lib.mjs`, split here into a `repo` and a JSON `number`;
 * - `PR_RESOLVE_OUTCOMES` — the list the `outcome` command of `pr-resolve.mjs` checks `--outcome` against;
 * - `PR_RESOLVE_LOCK_TTL_MS` — `LOCK_TTL_MS` in `pr-resolve-lib.mjs`.
 *
 * `test/guards/pr-resolve-twin.test.ts` is what ties the copies together: it runs the tool's `parse` command against the functions here and reads the
 * outcome list and the TTL out of the tool's source, so a copy changed on one side alone turns it red. (Suites that build their fixtures through this file's
 * own `fileKey` cannot catch a drift — both sides of their assertions are this copy.)
 */

/** The tool's home rule, read per call and never cached — the suites point it at a temp dir through the env. */
export function prResolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_PR_RESOLVE_HOME || join(homedir(), '.backlog-manager', 'pr-resolve');
}

/** `<owner>__<name>__<N>` — the tool's `fileKey`. */
export function fileKey(repo: string, number: number): string {
  return `${repo.replace('/', '__')}__${number}`;
}

const OWNER = /^[A-Za-z0-9-]+$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * A file's base name (no `.json` / `.lock`) back to its target. A GitHub owner never contains `_`, so the FIRST `__` ends the owner and the LAST one starts the
 * number even when the repo name holds `__` itself (`acme__my__lib__12` is `acme/my__lib#12`). `null` for anything that is not a key — a hand-made file in the
 * home must be skipped, never listed under a made-up repo.
 */
export function parseFileKey(base: string): { repo: string; number: number } | null {
  const first = base.indexOf('__');
  const last = base.lastIndexOf('__');
  if (first <= 0 || last <= first + 1) return null;
  const owner = base.slice(0, first);
  const name = base.slice(first + 2, last);
  const digits = base.slice(last + 2);
  if (!OWNER.test(owner) || !NAME.test(name) || !/^[1-9][0-9]*$/.test(digits)) return null;
  const number = Number(digits);
  return Number.isSafeInteger(number) ? { repo: `${owner}/${name}`, number } : null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The outcomes the tool's `outcome` command accepts, in its order — a TWIN of the list in `pr-resolve.mjs`, pinned by the twin guard. */
export const PR_RESOLVE_OUTCOMES: readonly PrResolveOutcome['outcome'][] = ['pushed', 'stopped', 'up-to-date'];

/**
 * How long the tool honours a lock before a successor may claim it — a TWIN of `LOCK_TTL_MS` in `pr-resolve-lib.mjs`, pinned by the twin guard. The server
 * reads it to judge a lock that names no session (`PrResolveService`), which has nothing but its age to go on.
 */
export const PR_RESOLVE_LOCK_TTL_MS = 3 * 60 * 60 * 1000;

/** The outcome file, or `null` for a missing, unparseable or hand-edited one — any field of the wrong type or value makes the whole file unreadable. */
export function readOutcome(file: string): PrResolveOutcome | null {
  const raw = readJson(file);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.outcome !== 'string' || !(PR_RESOLVE_OUTCOMES as readonly string[]).includes(o.outcome)) return null;
  if (typeof o.reason !== 'string' || typeof o.fromSha !== 'string' || typeof o.headSha !== 'string') return null;
  if (o.sessionId !== null && typeof o.sessionId !== 'string') return null;
  return { outcome: o.outcome as PrResolveOutcome['outcome'], reason: o.reason, fromSha: o.fromSha, headSha: o.headSha, sessionId: o.sessionId };
}

/**
 * The PR's lock file, read and never written: `null` when there is none. `at` is the lock's own timestamp in epoch ms; a lock whose `at` cannot be parsed (a
 * crash can leave half a write) is judged by the file's mtime, as the tool judges it, so it is neither immortal nor instantly stale.
 */
export function readLock(file: string): { sessionId: string | null; at: number } | null {
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const raw = readJson(file);
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const sessionId = o !== null && typeof o.sessionId === 'string' ? o.sessionId : null;
  const parsed = o !== null && typeof o.at === 'string' ? Date.parse(o.at) : Number.NaN;
  return { sessionId, at: Number.isNaN(parsed) ? mtime : parsed };
}

/**
 * A session id the route is willing to put in a prompt. It comes off a file a stranger's session could in principle have written, and the prompt is the one
 * place its text reaches a model, so only a plain token passes (a dashboard id is a UUID; the character class is wider only so a test id like `old` fits).
 */
export const RECLAIMABLE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The skill's trigger, composed here and never taken from the body. `reclaim` is a validated session id or `null`. */
export function resolveTrigger(repo: string, number: number, reclaim: string | null): string {
  return `/backlog-manager:pr-resolve ${repo}#${number}${reclaim === null ? '' : ` --reclaim ${reclaim}`}`;
}

/** The body's shape: a non-array object with `repo` as `owner/name` (the tool's own target grammar) and `number` a positive integer, nothing else read. */
export function parseResolveBody(body: unknown): PrResolveRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { repo, number } = body as Record<string, unknown>;
  if (typeof repo !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
  return { repo, number };
}
