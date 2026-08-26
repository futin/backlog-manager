import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ServeStaticModule } from '@nestjs/serve-static';
import type { DynamicModule } from '@nestjs/common';

/**
 * cwd, not __dirname: the compiled file's depth differs between `nest start`
 * (dist/server/src) and ts-jest (server/src), while every way this server is
 * actually launched — pnpm scripts on the host, compose's WORKDIR /app —
 * runs from the repo root.
 */
export const CLIENT_DIST = resolve(process.cwd(), 'client', 'dist');

/**
 * The client bundle is built by a separate task and a separate toolchain.
 * Until it exists, registering ServeStaticModule would install a catch-all
 * handler with nothing behind it — every unknown route would answer with an
 * error from inside express.static instead of a plain 404. So the module is
 * registered conditionally, and the server stays useful (the API) on its own.
 */
export function clientDistModules(distDir: string = CLIENT_DIST): DynamicModule[] {
  if (!existsSync(join(distDir, 'index.html'))) {
    console.warn(`no client bundle at ${distDir} — serving the API only`);
    return [];
  }
  return [
    ServeStaticModule.forRoot({
      rootPath: distDir,
      // Express 5 path syntax (Nest 11). Without this the SPA fallback would
      // answer /api/* with index.html.
      exclude: ['/api/{*path}']
    })
  ];
}
