import type { MiddlewareConsumer } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * sha256 of the pre-paint theme script inlined in client/index.html, base64,
 * over the exact bytes between its <script> tags.
 *
 * A hash rather than 'unsafe-inline' (which would defeat the whole policy) and
 * rather than a nonce (which needs the server to rewrite the HTML on every
 * request — ServeStaticModule streams the file untouched, and that streaming
 * is the point). Vite copies the classic inline script into client/dist
 * verbatim, so one constant covers both the source and the built page.
 *
 * test/csp.test.ts recomputes this from client/index.html: editing that script
 * without updating this constant is a red test, not a silently blocked script
 * and a theme flash nobody notices until they change themes.
 */
export const THEME_SCRIPT_SHA256 = 'sha256-wZHQJ85rj3ae+nJZWhUQ1vAodctY1gHVM02A+GiCCQU=';

/**
 * The drawer renders item Markdown, and its sanitizer was the only thing
 * standing between a crafted item file and script execution. This is the
 * second layer, and the one that does not depend on that sanitizer being
 * exhaustive.
 *
 * Shipped as a response header from Nest rather than a <meta> tag in
 * client/index.html on purpose: a <meta> policy applies to the dev server too,
 * where Vite injects an inline React-refresh preamble that a strict script-src
 * would block — it would break `pnpm run dev:web`, the mode the README
 * recommends. Dev binds loopback only (see main.ts), so the served build is
 * where a CSP earns its keep.
 *
 * style-src keeps 'unsafe-inline' because the pre-paint script sets
 * --font-scale as an inline style and React writes inline styles too;
 * connect-src 'self' keeps a compromised page from exfiltrating what it read
 * off /api/items/body.
 */
export const CSP_POLICY = [
  "default-src 'self'",
  `script-src 'self' '${THEME_SCRIPT_SHA256}'`,
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ');

/** Plain Express middleware — nothing here needs Nest's request pipeline. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CSP_POLICY);
  next();
}

/**
 * `{*splat}`, not `*`: Express 5 (Nest 11) parses routes with path-to-regexp
 * v8, which rejects a bare wildcard. Exported so AppModule and the test that
 * pins the ordering against ServeStaticModule share one route matcher rather
 * than drifting apart.
 */
export function applySecurityHeaders(consumer: MiddlewareConsumer): void {
  consumer.apply(securityHeaders).forRoutes('{*splat}');
}
