import { Controller, Get } from '@nestjs/common';

import type { ReleasesResponse } from '../../../shared/types';
import { ReleasesService } from './releases.service';

/**
 * `GET /api/releases` — read-only, git only, no outbound call, so not one of the outbound-calling modules. Always 200: every failure is a shape
 * (`releases.service.ts` has the per-read table), because the chip it feeds is a convenience and must never put an error on the board.
 */
@Controller('api/releases')
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  list(): Promise<ReleasesResponse> {
    return this.releases.read();
  }
}
