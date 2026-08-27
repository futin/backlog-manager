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
