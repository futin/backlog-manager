import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

// 4322, not guide-manager's 4321: both apps run on this machine.
const PORT = Number(process.env.PORT) || 4322;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(PORT);
  console.log(`backlog-manager listening on http://localhost:${PORT}`);
}

// A failed boot must exit non-zero rather than leave a half-started process
// with nothing listening.
bootstrap().catch((err: unknown) => {
  console.error('backlog-manager failed to start:', err);
  process.exit(1);
});
