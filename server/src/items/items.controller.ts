import { Controller, Get, HttpException, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ItemsService } from './items.service';
import type { UncommittedItems } from './uncommitted.util';
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
   * Which of one project's item files a board-started run would not find at
   * `main` (task-32) — the Orchestrate sheet's own on-open read, so it can
   * flag the rows the run will skip before anyone walks away from a
   * multi-hour operation.
   *
   * No guard, for the reason `AgentsController.mergeCheck`'s own comment
   * gives verbatim: `SameOriginPostGuard` answers "may this caller POST at
   * all" for routes that start something or read an arbitrary file, and this
   * route does neither. It starts nothing, reads no caller-supplied path
   * (`project` has to match a registry entry exactly before anything touches
   * disk), and discloses strictly less about the filesystem than
   * `/api/projects` already does to any same-origin reader.
   *
   * 400 for a blank or absent `project` and 404 for an unregistered one, kept
   * apart deliberately: unlike `body` above — where "which of the three
   * reasons" is genuinely none of the caller's business — the only caller
   * here is this app's own sheet, and a malformed request is its bug while a
   * 404 is the registry's answer.
   */
  @Get('items/uncommitted')
  uncommitted(@Query('project') project: string | undefined): UncommittedItems {
    const trimmed = typeof project === 'string' ? project.trim() : '';
    if (trimmed === '') throw new HttpException({ error: 'project is required' }, 400);
    return this.items.uncommitted(trimmed);
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
