import { Module } from '@nestjs/common';

import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';

/**
 * No RegistryModule import, unlike ItemsModule/AgentsModule — see
 * OrchestratorService's own class comment for why: a run's project identity
 * is self-contained in its run.json, so this module has nothing to
 * cross-reference against the registry.
 */
@Module({
  controllers: [OrchestratorController],
  providers: [OrchestratorService],
  exports: [OrchestratorService]
})
export class OrchestratorModule {}
