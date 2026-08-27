import { HttpException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * origin.guard.ts — the only thing standing between a page the developer did
 * not write and a spawned Claude Code session.
 *
 * Until this branch every route in this app was a read-only GET, so "loopback
 * is the access control" (see the BM_BIND invariant) was the whole story. It no
 * longer is: `POST /api/agents/dispatch` starts a session with file-write
 * permission in another repo, and a bind is no defence against a request the
 * developer's OWN browser is tricked into making — the browser is already
 * inside the loopback boundary, so any tab can reach 127.0.0.1:4322 no matter
 * how narrowly this process binds.
 *
 * Nest registers `express.urlencoded` unconditionally on every app
 * (`@nestjs/platform-express/adapters/express-adapter.js`,
 * `registerParserMiddleware`), and `application/x-www-form-urlencoded` is one
 * of the three content types a cross-origin HTML form may post with **no CORS
 * preflight at all**. So without this guard, any page in that browser could
 * auto-submit a hidden form at this API and get a 201 plus a live session
 * carrying an attacker-written prompt. Nothing about that request looks
 * unusual to the server: it arrives on loopback, from the developer's browser,
 * and the body parses.
 *
 * Two independent checks, because each closes a path the other does not:
 *
 *  - **Content type must be `application/json`.** A form cannot send that
 *    without triggering a preflight, and there is deliberately no
 *    `enableCors()` anywhere under `server/src` to answer one — so the browser
 *    itself refuses to make the call. This is the check that actually stops
 *    the form-POST mechanism above.
 *  - **A present `Origin` must be ours.** `fetch()` from another origin can
 *    send `content-type: application/json`, but only after a preflight, so in
 *    a browser the first check already covers it. What it does not cover is
 *    `Origin: null` — what a sandboxed iframe, a `data:` document or a
 *    redirected form sends — which is a value no same-origin request ever
 *    carries. Rejecting a mismatched origin closes that, and costs nothing:
 *    the board's own calls are same-origin by construction
 *    (`connect-src 'self'`).
 *
 * Absent `Origin` is allowed on purpose. curl, a shell script, and the tests
 * send no origin at all, and requiring one would break every non-browser
 * caller while adding nothing — a browser that can be made to omit `Origin` on
 * a POST is a browser bug, not a posture this app can plan around.
 *
 * GET /api/agents/status is deliberately NOT guarded: it is read-only, and
 * every other GET in this app is open by the same posture.
 */
@Injectable()
export class SameOriginPostGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // Only the media type — a `; charset=utf-8` parameter is ordinary and must
    // not turn a legitimate request into a 403.
    const contentType = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      throw new HttpException({ error: 'this endpoint accepts application/json only' }, 403);
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && !sameOrigin(origin, req.headers.host)) {
      throw new HttpException({ error: 'cross-origin requests are refused' }, 403);
    }

    return true;
  }
}

/**
 * Does `origin` name the host this request was addressed to?
 *
 * Host-and-port only, not the scheme, and that is deliberate. `req.protocol`
 * is `http` for this process in every deployment it actually has — the served
 * build and `pnpm run dev` both speak plain HTTP on loopback — but a
 * `tailscale serve` in front of it (the documented way to reach the board from
 * a phone) terminates TLS and sends `https://…` in `Origin` while the request
 * arriving here is still HTTP. Comparing schemes would 403 that setup for no
 * security gain: a page served over http from this exact host:port is not an
 * attacker we are defending against, since it IS this app.
 *
 * The dev proxy stays inside this too: `vite.config.ts` sets no
 * `changeOrigin`, so a request through :5177 arrives with `Host: localhost:5177`
 * and `Origin: http://localhost:5177` — a match.
 *
 * `Origin: null` throws in the URL parser and therefore fails the check, which
 * is exactly the point of having it.
 */
function sameOrigin(origin: string, host: string | undefined): boolean {
  if (host === undefined || host === '') return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
