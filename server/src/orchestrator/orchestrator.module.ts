import { Module } from '@nestjs/common';

import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';
import { WatchdogStateService } from './watchdog-state.service';

/**
 * No RegistryModule import, unlike ItemsModule/AgentsModule — see
 * OrchestratorService's own class comment for why: a run's project identity
 * is self-contained in its run.json, so this module has nothing to
 * cross-reference against the registry.
 *
 * `WatchdogStateService` is provided and exported alongside
 * `OrchestratorService`, for the same reason and the same shape as that
 * export: `OrchestratorService.runs()` and `OrchestratorController.runs()`
 * both need the SAME singleton instance (one to annotate from, one to
 * observe into), and the future sweeper (`agents/watchdog.service.ts`, Task
 * 3) needs to reach that identical instance from `AgentsModule` — which
 * already imports `OrchestratorModule` for `OrchestratorService` itself, so
 * exporting this alongside it costs nothing and opens no new dependency
 * direction (watchdog-state.service.ts's own class comment).
 */
@Module({
  controllers: [OrchestratorController],
  providers: [OrchestratorService, WatchdogStateService],
  exports: [OrchestratorService, WatchdogStateService]
})
export class OrchestratorModule {}
