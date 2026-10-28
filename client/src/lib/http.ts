/**
 * The board's two smallest fetch helpers, in one leaf module: how a refusal's `{ error }` sentence is read, and how a JSON write goes out.
 *
 * Both used to live where they were first needed — `errorOf` and `postJson` were exported from `components/jira/JiraBoardSheet.tsx` and imported by three
 * sibling components, while `failureOf` (lib/jira.ts) and `unwrap` (lib/agents.ts) each read the same `{ error }` field by hand, three readers with two
 * different rules for an empty sentence (#376). They live here now, and every reader of a refusal's sentence goes through `errorOf`.
 *
 * Imports nothing — not from `components/`, `hooks/` or another `lib/` file — so any of them can import it without growing an edge.
 */

/**
 * The `error` sentence of a refused write or read, or `fallback` when the body carries none (a proxy's HTML 502, an empty body, a non-object).
 *
 * The sentence must be a NON-EMPTY string. That is the one rule the merge changed: `failureOf` already refused `''`, while the component's copy and
 * `unwrap` accepted it — and an empty sentence renders an empty alert, which tells a person less than the status fallback does.
 */
export function errorOf(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' && error !== '' ? error : fallback;
}

/**
 * A JSON POST: the server's `SameOriginPostGuard` refuses any other content type with a 403, so every write the board makes goes out this way.
 *
 * Resolves `{ ok, status, body }` whatever the status — `body` is `null` when the answer is not JSON — so the caller decides what a refusal means; it
 * rejects only when `fetch` itself rejects (the network, not the server).
 */
export async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}
