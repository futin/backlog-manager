import { Module } from '@nestjs/common';

import { SameOriginPostGuard } from '../agents/origin.guard';
import { TimeZoneController } from './timezone.controller';

/**
 * Board-wide display settings stored on the API host (#241) — today one file, `settings/timezone.json`, and its two routes. NOT an outbound-calling module:
 * it calls nothing over the network and writes nothing but that file. `SameOriginPostGuard` is provided here on the footing `TickModule` provides it: a guard
 * named in `@UseGuards` is resolved from the injector of the module whose controller names it.
 */
@Module({
  controllers: [TimeZoneController],
  providers: [SameOriginPostGuard]
})
export class SettingsModule {}
