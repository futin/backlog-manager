import { Body, Controller, Get, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import { SameOriginPostGuard } from '../origin.guard';
import { parseHeadlessConfig } from '../../../shared/agent';
import { HeadlessFileUnreadable, readHeadless, writeHeadless } from './headless-config.util';
import type { HeadlessConfig, HeadlessSetting } from '../../../shared/types';

/**
 * `GET` and `POST /api/settings/headless` — the plugin allowlist an orchestrator run's per-item sessions are launched with. The POST is `headless.json`'s one
 * writer; `orchestrate.mjs headless-settings` only reads it.
 */
@Controller('api/settings')
export class HeadlessController {
  /** Unguarded, like every other GET. `source: 'unreadable'` is how a person finds out a hand-edited file is trimming nothing. */
  @Get('headless')
  get(): HeadlessSetting {
    return readHeadless();
  }

  /**
   * Guarded and `@HttpCode(200)` like `review`. A body `parseHeadlessConfig` refuses is a 400 naming the member and writes nothing; a file already there that
   * is not a valid config is a 409 naming it, also writing nothing (see `headless-config.util.ts` for why it is not overwritten). The answer is the config
   * as written, duplicates dropped.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('headless')
  @HttpCode(200)
  set(@Body() body: unknown): HeadlessConfig {
    const parsed = parseHeadlessConfig(body);
    if (!parsed.ok) throw new HttpException({ error: `invalid headless config: ${parsed.member}` }, 400);
    try {
      writeHeadless(parsed.config);
    } catch (e) {
      if (e instanceof HeadlessFileUnreadable) throw new HttpException({ error: e.message }, 409);
      throw e;
    }
    return parsed.config;
  }
}
