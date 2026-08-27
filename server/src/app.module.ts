import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { ItemsModule } from './items/items.module';
import { AgentsModule } from './agents/agents.module';
import { applySecurityHeaders } from './security';
import { clientDistModules } from './static';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ItemsModule, AgentsModule, ...clientDistModules()],
  controllers: [HealthController]
})
export class AppModule implements NestModule {
  /**
   * Configured on the root module rather than app.use()'d in main.ts so every
   * app built from AppModule carries the header — the one the server boots and
   * the ones the tests build. Nest inserts the root module into the container
   * before its imports, so this middleware runs ahead of ServeStaticModule's
   * and the header lands on the served index.html, not just on /api.
   */
  configure(consumer: MiddlewareConsumer): void {
    applySecurityHeaders(consumer);
  }
}
