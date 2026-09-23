import { Controller, Get, HttpException, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ItemsService } from './items.service';
import type { UncommittedItems } from './uncommitted.util';
import type { ClaimResult, ItemsIndex, ProjectSummary } from '../../../shared/types';

/**
 * Everything lives under /api on purpose: dev-mode Vite proxies exactly one
 * prefix, and test/vite-proxy.test.ts asserts no controller ever leaves it —
 * a route outside /api would not 404 in dev, it would be answered by Vite's
 * SPA fallback with index.html.
 */
@Controller('api')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  // Asynchronous since task-43: the item-source seam is async throughout,
  // because a tracker adapter reads a cache a poller fills. Paths, status
  // codes and content types are unchanged — Nest awaits a returned promise
  // and serialises the value exactly as before.
  @Get('projects')
  async projects(): Promise<ProjectSummary[]> {
    return this.items.projects();
  }

  @Get('items')
  async index(): Promise<ItemsIndex> {
    return this.items.index();
  }

  /**
   * Which of one project's item files differ from `main` (task-32) — the
   * Orchestrate sheet's own on-open read, so it can flag the rows whose bytes
   * on disk are not the bytes a run will act on, before anyone walks away
   * from a multi-hour operation.
   *
   * No consequence stated here on purpose. The predicate is broader than any
   * one gate verdict — absent from `main` is skipped, present-but-stale is
   * gated and EXECUTED on `main`'s bytes — and CLAUDE.md's invariant requires
   * that any surface stating a consequence split it. A docstring on the
   * transport is the wrong place to restate a two-branch rule that will drift
   * from the one copy of it, so this points at `uncommitted.util.ts`'s header
   * and docs/subsystems/invariants.md's "One question, two fates" instead. (Review
   * round 2: this comment was the rule's own first counter-example, shipped
   * in the commit that wrote the rule.)
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
   * Who holds one item, or `null` — the eighth item route (task-46) and the
   * only READ among the claim protocol's.
   *
   * A GET, and therefore in THIS controller rather than beside the eight
   * writes: it starts nothing, reads no caller-supplied path (`project` has to
   * match a registry entry exactly), and discloses strictly less than
   * `/api/items` already does to any same-origin reader. That is the same
   * reasoning `uncommitted` above carries for being unguarded.
   *
   * It answers from the poller's cache, and makes ONE fresh read when the cache
   * has no claim for that issue — see `ItemWriter.readClaim` for why a miss
   * cannot be reported as "unclaimed". So it is not free, but it is bounded: at
   * most one request, and none at all in the common case.
   *
   * It exists because `backlog.mjs start` and `backlog.mjs stop` are two
   * PROCESSES: `claim` answers the comment id that identifies the claim, and
   * the `stop` that has to `release` it — minutes later, from a different
   * invocation — has no other way to rediscover it. Without this the CLI could
   * take an item and never give it back.
   *
   * 400 for a blank parameter and 404 for an unregistered or non-tracker
   * project, kept apart for the reason `uncommitted` gives: a malformed request
   * is the caller's bug, and a 404 is the registry's answer.
   */
  @Get('items/claim')
  async claim(@Query('project') project: string | undefined, @Query('id') id: string | undefined): Promise<ClaimResult | null> {
    const trimmedProject = typeof project === 'string' ? project.trim() : '';
    const trimmedId = typeof id === 'string' ? id.trim() : '';
    if (trimmedProject === '') throw new HttpException({ error: 'project is required' }, 400);
    if (trimmedId === '') throw new HttpException({ error: 'id is required' }, 400);
    return this.items.readClaim(trimmedProject, trimmedId);
  }

  /**
   * text/plain, not JSON: the payload IS the Markdown, and wrapping it would
   * make the client unwrap it. 404 covers missing param, unregistered path,
   * and non-.md alike — the caller has no business learning which.
   */
  @Get('items/body')
  async body(@Query('path') path: string | undefined, @Res() res: Response): Promise<void> {
    const body = path ? await this.items.body(path) : null;
    if (body === null) {
      res.status(404).send('not found');
      return;
    }
    res.type('text/plain; charset=utf-8').send(body);
  }
}
