import { Body, Controller, Get, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import { SameOriginPostGuard } from '../agents/origin.guard';
import { parseReviewConfig } from '../../../shared/agent';
import { readReview, writeReview } from './review-config.util';
import type { ReviewConfig, ReviewSetting } from '../../../shared/types';

/**
 * `GET` and `POST /api/settings/review` — which model and effort review a diff, stored on the API host so every device and every unattended run reads one
 * answer. The POST is `review.json`'s one writer on this side; `review.mjs` only reads it.
 */
@Controller('api/settings')
export class ReviewController {
  /** Unguarded, like every other GET. `fileError` is how a person finds out a hand-edited file is being ignored. */
  @Get('review')
  get(): ReviewSetting {
    return readReview();
  }

  /**
   * Guarded like every other POST here, `@HttpCode(200)` for the reason `timezone` gives: it replaces an existing setting. A body `parseReviewConfig`
   * refuses is a 400 naming the member and writes nothing — a number sent as a string is refused, not coerced, so the file never holds what the skill's
   * twin would reject. The answer is the config as written.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('review')
  @HttpCode(200)
  set(@Body() body: unknown): ReviewConfig {
    const parsed = parseReviewConfig(body);
    if (!parsed.ok) throw new HttpException({ error: `invalid review config: ${parsed.member}` }, 400);
    writeReview(parsed.config);
    return parsed.config;
  }
}
