import { Body, Controller, Get, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';
import { isAbsolute } from 'node:path';

import { SameOriginPostGuard } from '../agents/origin.guard';
import { TickFileUnreadable } from './tick-breaker.util';
import { TickService, type TickConfigPatch } from './tick.service';
import type { TicksPayload } from '../../../shared/types';

/**
 * The tick breaker's three routes (spec `2026-10-22-tick-breaker-design.md`, "Server"). `GET /api/ticks` is read-only and unguarded like every other GET;
 * both POSTs sit behind `SameOriginPostGuard` for the reason `watchdog/config` gives — they change what an unattended tick will do next, which a cross-origin
 * page must not reach. Each answers the FRESH `GET` payload, so the board draws the server's value rather than an optimistic one.
 *
 * Every body check lives here and not in `writeTickFile`, which clamps but does not validate: `config` takes any non-empty subset of `haltAfter`, `maxPlans`
 * and `maxPrs` (#378), and a present one that is not an integer is a 400 naming it BEFORE any clamping (the file reader's "non-integer reads as the default"
 * is a rule for a hand-edited file, not an excuse to accept `"7"` from a client); a body carrying none of the three is a 400 `nothing to set`, and an unknown
 * key beside a known one is ignored. `project` must be a string holding an absolute path before it is ever looked up. Status order: a malformed request is
 * a 400, an unknown project a 404, an unreadable `tick.json` a 409 naming the file.
 */

/** The keys `POST /api/ticks/config` sets, in the order a 400 checks them. */
const CONFIG_KEYS = ['haltAfter', 'maxPlans', 'maxPrs'] as const;
@Controller('api/ticks')
export class TickController {
  constructor(private readonly ticks: TickService) {}

  @Get()
  list(): TicksPayload {
    return this.ticks.payload();
  }

  @UseGuards(SameOriginPostGuard)
  @Post('config')
  @HttpCode(200)
  config(@Body() body: unknown): TicksPayload {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpException({ error: 'bad body' }, 400);
    const patch: TickConfigPatch = {};
    for (const key of CONFIG_KEYS) {
      if (!Object.hasOwn(body, key)) continue;
      const v = (body as Record<string, unknown>)[key];
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new HttpException({ error: `${key} must be an integer` }, 400);
      patch[key] = v;
    }
    if (Object.keys(patch).length === 0) throw new HttpException({ error: 'nothing to set' }, 400);
    return this.guarded(() => this.ticks.setConfig(patch));
  }

  @UseGuards(SameOriginPostGuard)
  @Post('reset')
  @HttpCode(200)
  reset(@Body() body: unknown): TicksPayload {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpException({ error: 'bad body' }, 400);
    const { project } = body as { project?: unknown };
    if (typeof project !== 'string' || !isAbsolute(project)) throw new HttpException({ error: 'project must be an absolute path' }, 400);
    if (!this.ticks.knows(project)) throw new HttpException({ error: 'no tick history for that project' }, 404);
    return this.guarded(() => this.ticks.reset(project));
  }

  /** `TickFileUnreadable` is a state of the file a person has to repair by hand: 409, naming it. Anything else (a failed write) stays the 500 it is. */
  private guarded(run: () => TicksPayload): TicksPayload {
    try {
      return run();
    } catch (e) {
      if (e instanceof TickFileUnreadable) throw new HttpException({ error: e.message }, 409);
      throw e;
    }
  }
}
