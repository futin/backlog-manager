import { Module } from '@nestjs/common';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { SameOriginPostGuard } from './origin.guard';
import { RegistryModule } from '../registry/registry.module';

/**
 * SameOriginPostGuard is listed here rather than left to `@UseGuards`'s own
 * instantiation so it resolves out of this module's container like any other
 * provider — the guard has no dependencies today, and this is what keeps
 * giving it one from being a surprise.
 *
 * The registry is the only injected dependency: item lookup goes through the
 * same allowlist and scanner the items module uses, but as plain function
 * calls (they are pure utilities, not providers), so there is nothing to
 * import from ItemsModule.
 */
@Module({
  imports: [RegistryModule],
  controllers: [AgentsController],
  providers: [AgentsService, SameOriginPostGuard]
})
export class AgentsModule {}
