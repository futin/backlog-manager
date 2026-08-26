import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

// 4322, not guide-manager's 4321: both apps run on this machine.
const PORT = Number(process.env.PORT) || 4322;

/**
 * Loopback unless told otherwise. Nothing in this stack has auth in front of
 * it and /api/items/body reads every registered project's backlog files
 * straight off disk, so the bind IS the access control — `app.listen(PORT)`
 * alone binds the wildcard and hands that to anything on the LAN.
 *
 * BM_BIND widens it deliberately. docker-compose.yml sets it to 0.0.0.0 in
 * both services because inside a container the *publish* (`127.0.0.1:4322:4322`)
 * is what constrains reach; a container-loopback bind would just make the
 * published port unreachable.
 */
const BIND = process.env.BM_BIND ?? '127.0.0.1';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(PORT, BIND);
  // The interface, not a hardcoded `localhost` — the log line is how you find
  // out a BM_BIND override actually took effect.
  console.log(`backlog-manager listening on http://${BIND}:${PORT}`);
}

// A failed boot must exit non-zero rather than leave a half-started process
// with nothing listening.
bootstrap().catch((err: unknown) => {
  console.error('backlog-manager failed to start:', err);
  process.exit(1);
});
