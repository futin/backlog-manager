import { Module } from '@nestjs/common';

import { RegistryModule } from '../registry/registry.module';
import { TickController } from './tick.controller';
import { TickService } from './tick.service';

/**
 * The tick breaker's module: `GET /api/ticks` and its two POSTs. NOT an outbound-calling module — it calls nothing over the network. It reads the tick home
 * (`~/.backlog-manager/tick/`, which `tick.mjs` alone writes) and the registry (display names only), and writes exactly one file, `settings/tick.json`.
 */
@Module({
  imports: [RegistryModule],
  controllers: [TickController],
  providers: [TickService]
})
export class TickModule {}
