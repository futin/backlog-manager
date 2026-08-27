import { Module } from '@nestjs/common';

import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { RegistryModule } from '../registry/registry.module';

/**
 * The registry is the only injected dependency: item lookup goes through the
 * same allowlist and scanner the items module uses, but as plain function
 * calls (they are pure utilities, not providers), so there is nothing to
 * import from ItemsModule.
 */
@Module({
  imports: [RegistryModule],
  controllers: [AgentsController],
  providers: [AgentsService]
})
export class AgentsModule {}
