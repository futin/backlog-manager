import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { ItemsAbortService } from './items-abort.service';
import { SameOriginPostGuard } from './origin.guard';
import { required } from '../items/items-write.controller';
import type { ItemAbortResult } from '../../../shared/types';

/**
 * items-abort.controller.ts — the ninth item write route, `POST /api/items/abort` (#225), and the only one outside `items-write.controller.ts`: it calls the
 * dashboard, and `ItemsModule` never does (see `ItemsAbortService` for the why and for the two cases). Guarded exactly like the other eight, and listed
 * with them in `test/agents-origin-guard.test.ts`.
 *
 * The body is two fields, rebuilt by name — never spread — so nothing a caller sends can reach the release's `authority`.
 */
@Controller('api/items')
@UseGuards(SameOriginPostGuard)
export class ItemsAbortController {
  constructor(private readonly abortService: ItemsAbortService) {}

  @Post('abort')
  async abort(@Body() body: Record<string, unknown> | undefined): Promise<ItemAbortResult> {
    const raw = body ?? {};
    const project = required(raw.project, 'project');
    const id = required(raw.id, 'id');
    return this.abortService.abort(project, id);
  }
}
