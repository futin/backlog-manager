/**
 * config.util.ts — the three environment variables this feature has.
 *
 * Read per call rather than captured at construction, for the same reason
 * RegistryService re-reads its file per request: a test overriding
 * process.env between cases must see the override, and there is nothing here
 * worth caching.
 */
export interface AgentsConfig {
  /** BM_AGENTS is on. Everything else in this feature is gated on it. */
  enabled: boolean;
  /**
   * The dashboard's *API* origin — its PORT (4173 by default), not its Vite
   * port. Env-only, never client-supplied: there is deliberately no request
   * shape in which a browser names the host this server will call.
   */
  url: string;
  /** Sent as `Authorization: Bearer …` when set. Never leaves this process. */
  token: string;
}

/** The dashboard's own default PORT, on loopback. */
const DEFAULT_URL = 'http://127.0.0.1:4173';

/**
 * Only `on`, `1` and `true` enable. A misspelled value means off — the same
 * strictness the dashboard applies to its own `remoteControl === true`, and
 * for the same reason: the failure mode of a typo must be "feature stays off",
 * never "feature quietly on".
 */
export function readAgentsConfig(env: NodeJS.ProcessEnv = process.env): AgentsConfig {
  const flag = (env.BM_AGENTS ?? '').trim().toLowerCase();
  const url = (env.BM_AGENTS_URL ?? '').trim();
  return {
    enabled: flag === 'on' || flag === '1' || flag === 'true',
    // Trailing slashes stripped here so every call site can write
    // `${url}/api/health` without producing `//api/health`.
    url: (url || DEFAULT_URL).replace(/\/+$/, ''),
    token: (env.BM_AGENTS_TOKEN ?? '').trim()
  };
}

/*
 * The three helpers below are every outbound call's to a dashboard, and they live HERE — beside the config they read — rather than in agents.service.ts,
 * where they began, because the multi-dashboard readers (`dashboard-status.service.ts`, `dashboards/usage.service.ts`, `dashboards/remote-board.util.ts`)
 * need them and `AgentsService` will inject those readers: a reader importing `agents.service` while `agents.service` imports the reader is a module cycle,
 * and under CommonJS a cycle hands Nest an `undefined` constructor parameter type at class-definition time. `agents.service.ts` re-exports all three, so
 * every importer that predates the move is untouched.
 */

/** `Authorization: Bearer …` when a token is set, nothing otherwise — the one place a token becomes a header, and it never becomes anything else. */
export function authHeaders(cfg: AgentsConfig): Record<string, string> {
  return cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * What to tell a reader about an outbound call to the dashboard that did not
 * come back at all — `message()`'s counterpart for the *rejection* shapes,
 * which say nothing useful on their own.
 *
 * Both shapes were measured on Node 22 for bug-26, and both are why relaying
 * the raw message is not enough:
 *
 * - a connection failure is a `TypeError` whose own message is the flat
 *   literal `fetch failed`. Everything that identifies it — `ECONNREFUSED`,
 *   the address — lives on `.cause` and nowhere else.
 * - the `AbortSignal.timeout` path is a `DOMException` reading `The operation
 *   was aborted due to timeout`, which names neither the call that timed out
 *   nor the budget it blew. A reader cannot tell a 4s health probe from a 10s
 *   spawn from that sentence, and the budget is the one number that tells
 *   them whether to retry or go looking at the dashboard.
 *
 * `what` names the call so the two are distinguishable; `timeoutMs` is that
 * call's own budget, passed in rather than looked up here because this
 * function has no way to know which of the three constants applied.
 *
 * The abort branch is duck-typed on `.name` rather than `instanceof
 * DOMException` for the reason `resumeErrorMessage` (watchdog.service.ts)
 * already records for its own probe: jest's node environment can put a realm
 * boundary between where an object was constructed and where it is tested,
 * and `instanceof` silently reads false across one. `AbortError` is accepted
 * beside `TimeoutError` because a caller-side abort arrives as the former and
 * means the same thing to a reader — nothing came back in time.
 *
 * The fall-through to `message(e)` is load-bearing rather than a default:
 * `status()`'s own failures already report a readable string (a plain
 * `Error('connect ECONNREFUSED …')` from `get()`, whose wording a test pins),
 * and anything that is not a fetch rejection at all — a bug in our own code —
 * must still read as itself rather than be dressed up as an upstream fault.
 */
export function dashboardError(e: unknown, what: string, timeoutMs: number): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `${what} timed out after ${timeoutMs}ms`;
  }
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (cause !== null && typeof cause === 'object') {
    const { code, message: detail } = cause as { code?: unknown; message?: unknown };
    const named = typeof code === 'string' ? code : typeof detail === 'string' ? detail : null;
    if (named !== null) return `${what} failed: ${named}`;
  }
  return message(e);
}
