import { Module } from '@nestjs/common';

import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorService } from './orchestrator.service';
import { RemoteRunsService } from './remote-runs.service';
import { StartingRunsService } from './starting-runs.service';
import { WatchdogStateService } from './watchdog-state.service';
import { RegistryModule } from '../registry/registry.module';
import { TrackerModule } from '../tracker/tracker.module';

/**
 * `OrchestratorService` still reads no registry — see its own class comment
 * for why: a run's project identity is self-contained in its run.json. The
 * `RegistryModule` import below is `RemoteRunsService`'s (task-48), which maps
 * a tracker repo's claims onto THIS machine's registry path for that repo,
 * because a claim carries no path at all.
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
  // `TrackerModule` for the poller's cached comments, which `RemoteRunsService`
  // derives other machines' runs from (task-48). No cycle: `TrackerModule`
  // imports only `RegistryModule`.
  imports: [RegistryModule, TrackerModule],
  controllers: [OrchestratorController],
  providers: [OrchestratorService, RemoteRunsService, StartingRunsService, WatchdogStateService],
  exports: [OrchestratorService, StartingRunsService, WatchdogStateService]
})
export class OrchestratorModule {}
