import { Module } from '@nestjs/common';

import { SameOriginPostGuard } from '../agents/origin.guard';
import { ReviewController } from './review.controller';
import { TimeZoneController } from './timezone.controller';

/**
 * Board-wide settings stored on the API host — two files, `settings/timezone.json` (#241) and `settings/review.json`, and their routes. NOT an outbound-calling
 * module: it calls nothing over the network and writes nothing but those files. `SameOriginPostGuard` is provided here on the footing `TickModule` provides
 * it: a guard named in `@UseGuards` is resolved from the injector of the module whose controller names it.
 */
@Module({
  controllers: [TimeZoneController, ReviewController],
  providers: [SameOriginPostGuard]
})
export class SettingsModule {}
