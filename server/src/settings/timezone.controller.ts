import { Body, Controller, Get, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import { SameOriginPostGuard } from '../agents/origin.guard';
import { canonicalTimeZone, readTimeZone, writeTimeZone } from './timezone-config.util';
import type { TimeZoneSetting } from '../../../shared/types';

/**
 * `GET` and `POST /api/settings/timezone` (#241) — the board's one shared time zone, read and written on the API host so every device draws the same
 * clocks and the same days. The POST is the file's one writer.
 */
@Controller('api/settings')
export class TimeZoneController {
  /** Unguarded, like every other GET: it reads one display preference and nothing else. */
  @Get('timezone')
  get(): TimeZoneSetting {
    return { timeZone: readTimeZone() };
  }

  /**
   * Guarded like every other POST on this server (content-type and origin). `@HttpCode(200)` for the reason `watchdog/config` gives: it redraws an existing
   * setting rather than creating anything. The answer is the CANONICAL id that was written, so the Settings card shows the server's value, not an optimistic
   * one — `etc/utc` comes back as `UTC`.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('timezone')
  @HttpCode(200)
  set(@Body() body: unknown): TimeZoneSetting {
    const b = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { timeZone?: unknown }) : null;
    // `null` is a value here — "unset" — so it is told apart from a missing key (`{}`), which is a malformed body like any other.
    const zone = b?.timeZone === null ? null : canonicalTimeZone(b?.timeZone);
    if (zone === null && b?.timeZone !== null) throw new HttpException({ error: 'timeZone must be an IANA time zone id or null' }, 400);
    return { timeZone: writeTimeZone(zone) };
  }
}
