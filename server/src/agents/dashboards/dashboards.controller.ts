import { isAbsolute } from 'node:path';
import { Body, Controller, Get, HttpCode, HttpException, Post, Query, UseGuards } from '@nestjs/common';

import type { DashboardsView, ProjectOffers } from '../../../../shared/types';
import { SameOriginPostGuard } from '../origin.guard';
import { DashboardsFileUnreadable } from './dashboards-file.util';
import { DashboardsService } from './dashboards.service';
import { OffersService } from './offers.service';

/**
 * The machine list's settings routes (spec 2026-10-22-multi-dashboard-design.md, "Settings"). `GET /api/dashboards` is read-only and unguarded like every
 * other GET; the four POSTs sit behind `SameOriginPostGuard` because what they edit decides which machine a launch may be sent to — an entry's URL is where this
 * server will later POST a prompt that starts a Claude Code session, which a cross-origin page must never be able to point somewhere. Each answers the FRESH
 * `DashboardsView`, so the card draws the server's value rather than an optimistic one.
 *
 * The view carries each entry's URLs and never a token (`DashboardsService.view`). Body validation lives in the service next to the file rules it shares with
 * the reader; this controller owns only the status mapping, as `tick.controller.ts` does: a malformed request is a 400, an unknown entry a 404, an unreadable
 * `dashboards.json` a 409 naming the file.
 */
@Controller('api/dashboards')
export class DashboardsController {
  constructor(
    private readonly dashboards: DashboardsService,
    private readonly offersService: OffersService
  ) {}

  @Get()
  list(): DashboardsView {
    return this.dashboards.view();
  }

  /**
   * Which machines `project` can run on, and the suggestion (multi-dashboard task 4, `OffersService`). Read-only and unguarded like every GET; always a 200
   * once the query is well formed, because a machine that cannot be reached is an answer (not offered, with its reason), never an error. The path is the
   * project's registry path, compared raw like every membership check here — an unregistered path is simply a project no remote can know.
   */
  @Get('offers')
  offers(@Query('project') project: unknown): Promise<ProjectOffers> {
    if (typeof project !== 'string' || !isAbsolute(project)) throw new HttpException({ error: 'project must be an absolute path' }, 400);
    return this.offersService.offers(project);
  }

  @UseGuards(SameOriginPostGuard)
  @Post('entries')
  @HttpCode(200)
  upsert(@Body() body: unknown): DashboardsView {
    return this.guarded(() => this.dashboards.upsertEntry(body));
  }

  @UseGuards(SameOriginPostGuard)
  @Post('entries/delete')
  @HttpCode(200)
  remove(@Body() body: unknown): DashboardsView {
    return this.guarded(() => this.dashboards.deleteEntry(body));
  }

  @UseGuards(SameOriginPostGuard)
  @Post('home')
  @HttpCode(200)
  home(@Body() body: unknown): DashboardsView {
    return this.guarded(() => this.dashboards.setHome(body));
  }

  @UseGuards(SameOriginPostGuard)
  @Post('settings')
  @HttpCode(200)
  settings(@Body() body: unknown): DashboardsView {
    return this.guarded(() => this.dashboards.setSettings(body));
  }

  /** `DashboardsFileUnreadable` is a state of the file a person has to repair by hand: 409, naming it. Anything else (a failed write) stays the 500 it is. */
  private guarded(run: () => DashboardsView): DashboardsView {
    try {
      return run();
    } catch (e) {
      if (e instanceof DashboardsFileUnreadable) throw new HttpException({ error: e.message }, 409);
      throw e;
    }
  }
}
