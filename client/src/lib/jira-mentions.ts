/**
 * jira-mentions.ts — the fetch/post helpers and shape guard behind `hooks/useJiraMentions.ts` (Jira mentions phase 1, Task 7).
 *
 * No React. One `JiraMentionsFailure` shape for every refusal so the page reads one thing: the sweep's two refusals (409, 429) keep the board sweep's
 * `{ message }` body (a 429 adds `retryAt`, the end of the wait, which the page words as "Jira asked to wait until HH:MM"), the other routes answer `{ error }`.
 */
import { errorOf, postJson } from './http';
import type { JiraMentionsPayload } from '../../../shared/types';

export interface JiraMentionsFailure {
  message: string;
  /** The ISO end of a 429's wait, else `null`. */
  retryAt: string | null;
  /** The HTTP status, `0` for a network failure or a malformed 200. */
  status: number;
}

/**
 * A 200 body is trusted only when it can be drawn: `configured` is the discriminator, and a configured body must carry the two arrays the page maps over.
 * A wrong shape is a failed read, for `isJiraStatusPayload`'s reason — a throw inside a render would unmount the page.
 */
export function isJiraMentionsPayload(value: unknown): value is JiraMentionsPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.configured === false) return true;
  return p.configured === true && Array.isArray(p.issues) && Array.isArray(p.dismissed);
}

/** The sentence and wait-end of a refusal body: `{ message }` (the sweep) first, then `{ error }`, then `fallback`. */
export function failureOfMentions(status: number, body: unknown, fallback: string): JiraMentionsFailure {
  const rec = typeof body === 'object' && body !== null ? (body as { message?: unknown; retryAt?: unknown }) : {};
  const message = typeof rec.message === 'string' && rec.message !== '' ? rec.message : errorOf(body, fallback);
  return { message, retryAt: typeof rec.retryAt === 'string' ? rec.retryAt : null, status };
}

/** `GET /api/jira/mentions`. Rejects with a `JiraMentionsFailure`. */
export async function fetchJiraMentions(): Promise<JiraMentionsPayload> {
  const res = await fetch('/api/jira/mentions');
  if (!res.ok) throw failureOfMentions(res.status, await res.json().catch(() => null), `Jira answered ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  if (!isJiraMentionsPayload(body)) throw { message: 'malformed /api/jira/mentions response', retryAt: null, status: 0 } satisfies JiraMentionsFailure;
  return body;
}

/** A write to one of the mentions routes; resolves the new payload, rejects with a `JiraMentionsFailure`. */
export async function postJiraMentions(path: 'sweep' | 'dismiss' | 'restore', body: object): Promise<JiraMentionsPayload> {
  const res = await postJson(`/api/jira/mentions/${path}`, body);
  if (!res.ok) throw failureOfMentions(res.status, res.body, `Jira answered ${res.status}`);
  if (!isJiraMentionsPayload(res.body)) throw { message: 'malformed response', retryAt: null, status: 0 } satisfies JiraMentionsFailure;
  return res.body;
}

export const asMentionsFailure = (e: unknown): JiraMentionsFailure =>
  typeof e === 'object' && e !== null && typeof (e as JiraMentionsFailure).message === 'string' && 'retryAt' in e
    ? (e as JiraMentionsFailure)
    : { message: 'Jira unavailable', retryAt: null, status: 0 };
