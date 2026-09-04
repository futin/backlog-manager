import { Module } from '@nestjs/common';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { SameOriginPostGuard } from './origin.guard';
import { WatchdogService } from './watchdog.service';
import { RegistryModule } from '../registry/registry.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

/**
 * SameOriginPostGuard is listed here rather than left to `@UseGuards`'s own
 * instantiation so it resolves out of this module's container like any other
 * provider — the guard has no dependencies today, and this is what keeps
 * giving it one from being a surprise.
 *
 * The registry is the only injected dependency item lookup needs: it goes
 * through the same allowlist and scanner the items module uses, but as plain
 * function calls (they are pure utilities, not providers), so there is
 * nothing to import from ItemsModule for that.
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
 * payload reads the sweeper's state back out).
 */
@Module({
  imports: [RegistryModule, OrchestratorModule],
  controllers: [AgentsController],
  providers: [AgentsService, SameOriginPostGuard, WatchdogService]
})
export class AgentsModule {}
