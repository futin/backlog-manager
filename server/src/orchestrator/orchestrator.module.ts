import { Module } from '@nestjs/common';

import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';
import { StartingRunsService } from './starting-runs.service';
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
 *
 * `StartingRunsService` (task-14) is provided and exported for exactly that
 * same shape, one layer of callers wider: `OrchestratorService.runs()` calls
 * its pure `list()`, `OrchestratorController.runs()` calls its mutating
 * `sweep()`, and `AgentsController.orchestrate()` calls `mark()` after a
 * successful spawn — three call sites in two modules that must all reach the
 * SAME singleton, which is only true because this module exports it and
 * `AgentsModule` already imports this one.
 */
@Module({
  controllers: [OrchestratorController],
  providers: [OrchestratorService, StartingRunsService, WatchdogStateService],
  exports: [OrchestratorService, StartingRunsService, WatchdogStateService]
})
export class OrchestratorModule {}
