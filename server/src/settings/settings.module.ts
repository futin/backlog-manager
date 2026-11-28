import { Module } from '@nestjs/common';

import { HeadlessController } from './headless.controller';
import { ReviewController } from './review.controller';
import { TimeZoneController } from './timezone.controller';

/**
 * Board-wide settings stored on the API host — three files, `settings/timezone.json` (#241), `settings/review.json` and `settings/headless.json`, and their
 * routes. NOT an outbound-calling module: it calls nothing over the network and writes nothing but those files.
 */
@Module({
  controllers: [TimeZoneController, ReviewController, HeadlessController]
})
export class SettingsModule {}
