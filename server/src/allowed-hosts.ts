import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/**
 * allowed-hosts.ts — the layer that asks which host a request was ADDRESSED
 * to, which is the one question DNS rebinding cannot answer.
 *
 * The origin guard next door (agents/origin.guard.ts) asks whether two headers
 * AGREE: `new URL(origin).host === req.headers.host`. A page the attacker
 * serves on evil.test, whose DNS re-resolves to 127.0.0.1 after load, satisfies
 * that with two matching lies — `Origin: http://evil.test:4322` and
 * `Host: evil.test:4322` — and its fetch is genuinely same-origin from the
 * browser's point of view, so there is no preflight to withhold and
 * `application/json` is sent for free. Both of the guard's checks clear and the
 * request lands on `POST /api/agents/dispatch`, which forwards the attacker's
 * prompt into a Claude Code session with file-write permission in another repo.
 * That is bug-22, the sole Critical of the 2026-09-06 audit.
 *
 * An allowlist is the check that attack cannot pass, for a structural reason:
 * the browser derives `Host` from the URL the attacker's own page was loaded
 * from. They choose its value, but cannot make it read `localhost` while the
 * page's origin stays `evil.test` — the authority in both headers is theirs by
 * construction. "Do these two headers agree" is a question a rebound page
 * always answers yes to; "is this a name this app answers to" is one it always
 * answers no to.
 *
 * Global, not scoped to the agents POSTs, because the exposure is not scoped
 * either: `/api/items/body` reads any registered project's backlog file
 * straight off disk and `/api/projects` hands over absolute host paths — the
 * read surface the loopback bind exists to protect, reachable by the same page.
 */

/**
 * Does `hostHeader` name a host this app answers to?
 *
 * `env` is a parameter with a `process.env` default rather than a value read at
 * import: the variable is read per request with no cache, the same posture
 * `BM_AGENTS` has, so an operator can change it without a restart and a test
 * can pass an env of its own without mutating the process.
 *
 * The **hostname only, never the port**. The port a request arrives on is the
 * port this process chose to listen on; pinning it here would plant a third
 * copy of `BM_API_PORT` / `BM_WEB_PORT` / the tailnet port for no security
 * gain, since an attacker's page must already reach our socket to matter at
 * all.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const hostname = parseHostname(hostHeader);
  if (hostname === null) return false;

  // 1. Any IP literal. An IP is not a name and therefore cannot be rebound:
  //    for a browser to send `Host: 203.0.113.5` to this socket the packet
  //    would have to route to that address, not to loopback. This rule is also
  //    why every pre-existing suite stays green untouched — supertest binds an
  //    ephemeral port and sends `Host: 127.0.0.1:<port>`.
  if (isIP(hostname) !== 0) return true;

  // 2. localhost.
  if (hostname === 'localhost') return true;

  // 3. Any tailnet name. `pnpm run tailnet` is the one documented remote path,
  //    and this deliberately mirrors vite.config.ts's `allowedHosts:
  //    ['.ts.net']` so the API and the dev server answer to the same set. A
  //    tailnet name is minted by Tailscale for a node, not by whoever
  //    registers a domain, so an attacker cannot point one at 127.0.0.1.
  //    Stricter than Vite's spelling in one direction only: the bare apex
  //    `ts.net` is Tailscale's own domain and never a node of ours.
  if (matchesSuffix(hostname, '.ts.net')) return true;

  // 4. The operator's escape hatch, for a setup this repo does not ship: a
  //    reverse proxy, an mDNS .local name, another container calling the API
  //    by service name.
  for (const raw of (env.BM_ALLOWED_HOSTS ?? '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry.startsWith('.') ? matchesSuffix(hostname, entry) : hostname === entry) return true;
  }

  return false;
}

/**
 * The header down to a comparable hostname, or `null` for anything that is not
 * one.
 *
 * `null` for an absent or empty header on purpose: HTTP/1.1 requires `Host`
 * and every browser and curl sends it, so treating an absent one as allowed
 * would reopen the whole hole to a hand-rolled client.
 */
function parseHostname(hostHeader: string | undefined): string | null {
  if (typeof hostHeader !== 'string' || hostHeader === '') return null;

  let hostname: string;
  try {
    // The Host header is an authority, not a URL. Borrowing the URL parser
    // gets port stripping and host validation for free, and a throw — which is
    // what a header full of junk produces — is a refusal.
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }

  // `new URL('http://[::1]:4322').hostname` is `'[::1]'`, brackets included,
  // and net.isIP() says no to that spelling.
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);

  hostname = hostname.toLowerCase();

  // `localhost.` is the same name as `localhost` (an explicitly-rooted FQDN).
  // Stripping the dot makes the suffix rules stricter rather than looser: with
  // it left on, `evil.ts.net.` would fail `.ts.net` — but so would the
  // legitimate `mac.tail1234.ts.net.`, and the asymmetry is not worth the
  // second spelling of every rule.
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);

  return hostname === '' ? null : hostname;
}

/**
 * A suffix match on a label boundary, never a substring: `suffix` carries its
 * own leading dot, so `evilts.net` and `ts.net.evil.test` both fail `.ts.net`.
 */
function matchesSuffix(hostname: string, suffix: string): boolean {
  return hostname.endsWith(suffix);
}

/**
 * Plain Express middleware, like securityHeaders beside it — nothing here needs
 * Nest's request pipeline.
 *
 * It answers the response itself rather than throwing an HttpException:
 * Nest's exception layer wraps controllers, guards and pipes, and a throw from
 * middleware would land in Express's own error handler as a 500 with a stack
 * page. The observable shape is the guard's — 403 and `{ error }` — which is
 * what a caller can actually see.
 */
export function allowedHostGate(req: Request, res: Response, next: NextFunction): void {
  if (!isAllowedHost(req.headers.host)) {
    res.status(403).json({ error: 'unrecognised Host header' });
    return;
  }
  next();
}
