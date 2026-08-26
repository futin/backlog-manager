import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ItemsService } from './items.service';
import type { ItemsIndex, ProjectSummary } from '../../../shared/types';

/**
 * Everything lives under /api on purpose: dev-mode Vite proxies exactly one
 * prefix, and test/vite-proxy.test.ts asserts no controller ever leaves it —
 * a route outside /api would not 404 in dev, it would be answered by Vite's
 * SPA fallback with index.html.
 */
@Controller('api')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get('projects')
  projects(): ProjectSummary[] {
    return this.items.projects();
  }

  @Get('items')
  index(): ItemsIndex {
    return this.items.index();
  }

  /**
   * text/plain, not JSON: the payload IS the Markdown, and wrapping it would
   * make the client unwrap it. 404 covers missing param, unregistered path,
   * and non-.md alike — the caller has no business learning which.
   */
  @Get('items/body')
  body(@Query('path') path: string | undefined, @Res() res: Response): void {
    const body = path ? this.items.body(path) : null;
    if (body === null) {
      res.status(404).send('not found');
      return;
    }
    res.type('text/plain; charset=utf-8').send(body);
  }
}
