import { Module } from '@nestjs/common';

import { createBacklogHub } from './hub-widgets';
import { HubController } from './hub.controller';
import { BACKLOG_HUB } from './hub.tokens';
import { ItemsModule } from '../items/items.module';
import { ItemsService } from '../items/items.service';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { OrchestratorService } from '../orchestrator/orchestrator.service';

/**
 * The Lookout hub widgets (#249). Read-only: it imports the two modules whose reads it needs and nothing that writes.
 *
 * `OrchestratorService.runs()`, the PURE read — never `OrchestratorController.runs()`, which also observes the payload into the watchdog (arming it) and
 * sweeps starting entries. A hub polling every 15 s must not become another arming path: going through the controller would make Lookout's poll a hidden
 * observer of the watchdog and the starting-run records, on a machine whose board nobody has open.
 */
@Module({
  imports: [ItemsModule, OrchestratorModule],
  controllers: [HubController],
  providers: [
    {
      provide: BACKLOG_HUB,
      useFactory: (items: ItemsService, orchestrator: OrchestratorService) =>
        createBacklogHub({ projects: () => items.projects(), runs: () => orchestrator.runs() }),
      inject: [ItemsService, OrchestratorService]
    }
  ]
})
export class HubModule {}
