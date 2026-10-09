import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { HubHandler } from 'lookout-widgets';

import { BACKLOG_HUB } from './hub.tokens';

/**
 * The Lookout widget catalog (#249): `GET /api/hub/widgets` and everything below it, handed whole to the `lookout-widgets` handler, which owns the
 * contract's routing. Under `/api` like every route (test/vite-proxy.test.ts), and behind the Host allowlist like every route — Lookout polls
 * `http://<machine>.ts.net:<port>/api/hub/widgets` server-side, and `.ts.net` is already allowed, so the allowlist needs no change.
 *
 * Two paths, not one: Nest 11 runs Express 5 / path-to-regexp v8, where a wildcard must be NAMED (`*path` — an unnamed `*` throws at boot) and matches one
 * or more segments, so the bare catalog path needs its own `''` entry.
 *
 * No content-type/origin guard on a POST, unlike every other POST in this server: no widget declares an action, so there is no write path here to guard —
 * every POST falls to the package's own 404 (hub-widgets.ts's header has the reasoning). The day an action is declared, this controller needs the guard.
 */
@Controller('api/hub/widgets')
export class HubController {
  constructor(@Inject(BACKLOG_HUB) private readonly hub: HubHandler) {}

  @All(['', '*path'])
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    // The raw, still-percent-encoded pathname: the package decodes ids itself, and a pre-decoded `%2F` would read as a path separator.
    const url = new URL(req.originalUrl, 'http://x');
    try {
      const reply = await this.hub.handle({ method: req.method, path: url.pathname, query: url.searchParams, body: req.body });
      if (reply === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(reply.status).json(reply.json);
    } catch (err) {
      // The package documents that `handle` never rejects. Guarded anyway: a hub tile is not worth an unhandled rejection in the board's server.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`hub: ${req.method} ${url.pathname} threw (${message})`);
      res.status(500).json({ error: message });
    }
  }
}
