import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { HealthController } from './health/health.controller';
import { ItemsModule } from './items/items.module';
import { clientDistModules } from './static';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ItemsModule, ...clientDistModules()],
  controllers: [HealthController]
})
export class AppModule {}
