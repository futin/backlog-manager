import { Controller, Get } from '@nestjs/common';

import { OrchestratorService } from './orchestrator.service';
import type { OrchestratorArchivePayload, OrchestratorRunsPayload } from '../../../shared/types';

/**
 * Feature-prefixed like AgentsController (`api/agents`), not flat like
 * ItemsController's bare `api` — see ItemsController's own comment for why
 * /api is non-negotiable at all: dev-mode Vite proxies exactly one prefix,
 * and test/vite-proxy.test.ts asserts no controller ever leaves it.
 */
@Controller('api/orchestrator')
export class OrchestratorController {
  constructor(private readonly orchestrator: OrchestratorService) {}

  @Get('runs')
  runs(): OrchestratorRunsPayload {
    return this.orchestrator.runs();
  }

  @Get('archive')
  archive(): OrchestratorArchivePayload {
    return this.orchestrator.archive();
  }
}
