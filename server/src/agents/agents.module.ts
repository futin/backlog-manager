import { Module } from '@nestjs/common';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { SameOriginPostGuard } from './origin.guard';
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
 */
@Module({
  imports: [RegistryModule, OrchestratorModule],
  controllers: [AgentsController],
  providers: [AgentsService, SameOriginPostGuard]
})
export class AgentsModule {}
