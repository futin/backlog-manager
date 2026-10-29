import { Module } from '@nestjs/common';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { DashboardStatusService } from './dashboard-status.service';
import { DashboardsController } from './dashboards/dashboards.controller';
import { DashboardsService } from './dashboards/dashboards.service';
import { MachinesService } from './dashboards/machines.service';
import { OffersService } from './dashboards/offers.service';
import { OrchestrateArgsService } from './orchestrate-args.service';
import { UsageService } from './dashboards/usage.service';
import { ItemsAbortController } from './items-abort.controller';
import { ItemsAbortService } from './items-abort.service';
import { JiraAgentsController } from './jira-agents.controller';
import { JiraDispatchService } from './jira-dispatch.service';
import { JiraLiveReconciler } from './jira-live.service';
import { SameOriginPostGuard } from './origin.guard';
import { WatchdogService } from './watchdog.service';
import { RegistryModule } from '../registry/registry.module';
import { ItemsModule } from '../items/items.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { TrackerModule } from '../tracker/tracker.module';
import { JiraModule } from '../jira/jira.module';

/**
 * SameOriginPostGuard is listed here rather than left to `@UseGuards`'s own
 * instantiation so it resolves out of this module's container like any other
 * provider — the guard has no dependencies today, and this is what keeps
 * giving it one from being a surprise.
 *
 * ItemsModule arrived in task-46, with the dispatch lift. `AgentsService` used
 * to find an item through the allowlist and the scanner as plain function
 * calls — a private second copy of the files adapter, which is precisely why a
 * tracker item had no dispatch — and now delegates to `ItemsService.find`,
 * which dispatches on the ref's shape over the registered adapters. The edge
 * runs agents → items and never back: nothing in `ItemsModule` knows dispatch
 * exists, so there is no cycle for Nest to refuse.
 *
 * `ItemsAbortController` and its service are here since #225 although the route is `/api/items/abort`: the abort calls the dashboard, and this module
 * and `tracker/` are the only two that call out. It reaches the item write seam through `ItemsService` and `DispatchRecordsService`, both exported by
 * `ItemsModule` — the same agents → items edge.
 *
 * OrchestratorModule is imported for the same reason RegistryModule is:
 * AgentsService.orchestrate() (POST /api/agents/orchestrate) injects its
 * OrchestratorService to read whether a fresh run already exists for a
 * project before it will ask the dashboard to spawn another one — see that
 * method's own comment for why this lock is re-checked here rather than
 * trusted to orchestrate.mjs alone. OrchestratorModule exports the service
 * for exactly this — a second consumer beyond its own controller.
 *
 * WatchdogService is listed as a provider so Nest INSTANTIATES it and calls
 * its `onApplicationBootstrap` hook, which is what arms the sweeper —
 * deleting this line would not break a single import, it would silently
 * turn the watchdog off, which is the one reason it is worth saying so here.
 * That reason predates `AgentsController` injecting it too (Task 5's two
 * routes, `GET /api/agents/watchdog` and `POST /api/agents/watchdog/config`,
 * plus the `arm()` calls after a successful `orchestrate`/`resume` spawn):
 * even a module with no controller depending on it at all would still need
 * this line, because a provider nothing constructs is a provider Nest never
 * builds. Everything past bootstrap is the sweeper's own `setTimeout` chain
 * and the armer callback it registers on WatchdogStateService (which lives
 * in OrchestratorModule, already imported above, and is where the runs
 * payload reads the sweeper's state back out). *
 * JiraModule arrived with Jira phase 5's `POST /api/agents/dispatch-jira` (`JiraAgentsController` → `JiraDispatchService`): the route reads an issue and
 * writes assign and transition through `JiraPollerService`, and reserves the key in `JiraLiveService`, both exported by that module for exactly this. It is
 * here and not in `jira/` because it calls the dashboard, which this module (and `tracker/`) is for. The edge runs agents → jira and never back —
 * `jira.module.ts` says why — so there is no cycle for Nest to refuse. `JiraLiveReconciler` is a provider for the same reason as `WatchdogService`: it is the
 * 60 s timer that clears a live-map entry whose session ended, armed by a confirmed dispatch and `OnApplicationShutdown`-cleared, so it has to be built by Nest
 * to have its shutdown hook called; `POST /api/agents/jira-stop` is `JiraDispatchService.stop`, beside the dispatch it undoes.
 *
 * `DashboardsController` / `DashboardsService` (multi-dashboard task 2) are here for the same reason `ItemsAbortController` is: the machine list they own is what
 * every launch resolves a dashboard through, and the calling-out code that will consume it lives in this module. The service reads `dashboards.json` and the
 * environment and calls nothing itself. `UsageService` (task 3) is the one place a dashboard's usage is read, cached 60 s per dashboard; it is a provider here so
 * the offers (task 4) inject it, and it is the first outbound caller in `dashboards/`.
 *
 * `DashboardStatusService` (task 4) is any dashboard's health probe and project map, moved out of `AgentsService` so that `OffersService` — which reads
 * every machine's, and which task 5 makes `AgentsService` inject — can have them without injecting `AgentsService` back: that edge would be a cycle Nest
 * cannot construct. Both inject it; `OffersService` never injects `AgentsService`, and nothing under `dashboards/` imports `agents.service.ts`.
 *
 * `MachinesService` (Settings › Dashboards page, task 3) is `GET /api/dashboards/machines`: each machine's health (`DashboardStatusService.healthOf`, health only)
 * and, for a reachable one, its usage (`UsageService`). Nothing injects it back, so it adds no edge to the graph above.
 */
@Module({
  // `TrackerModule` for the poller's `syncOffBlock` (#17) — no cycle: it imports only `RegistryModule`.
  imports: [RegistryModule, ItemsModule, OrchestratorModule, TrackerModule, JiraModule],
  controllers: [AgentsController, DashboardsController, ItemsAbortController, JiraAgentsController],
  providers: [
    AgentsService,
    DashboardStatusService,
    DashboardsService,
    ItemsAbortService,
    JiraDispatchService,
    JiraLiveReconciler,
    MachinesService,
    OffersService,
    OrchestrateArgsService,
    SameOriginPostGuard,
    UsageService,
    WatchdogService
  ]
})
export class AgentsModule {}
