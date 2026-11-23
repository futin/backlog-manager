import { Module } from '@nestjs/common';

import { ReviewController } from './review.controller';
import { TimeZoneController } from './timezone.controller';

/**
 * Board-wide settings stored on the API host — two files, `settings/timezone.json` (#241) and `settings/review.json`, and their routes. NOT an outbound-calling
 * module: it calls nothing over the network and writes nothing but those files.
 */
@Module({
  controllers: [TimeZoneController, ReviewController]
})
export class SettingsModule {}
