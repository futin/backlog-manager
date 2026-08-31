import 'reflect-metadata';

import viteConfig from '../vite.config';
import { HealthController } from '../server/src/health/health.controller';
import { ItemsController } from '../server/src/items/items.controller';
import { AgentsController } from '../server/src/agents/agents.controller';
import { OrchestratorController } from '../server/src/orchestrator/orchestrator.controller';

/**
 * The dev proxy has exactly one entry, /api — which is only safe while every
 * server controller actually lives under /api. A controller registered
 * outside it would not 404 in dev: Vite's SPA fallback answers with
 * index.html, and the failure is a silently-wrong response instead of an
 * error. So the invariant is asserted from Nest's own route metadata, not a
 * hand-kept list. Any new controller must be added to CONTROLLERS here —
 * the length assertion is the reminder.
 */
const CONTROLLERS = [HealthController, ItemsController, AgentsController, OrchestratorController];

type ViteServer = { host?: string | boolean; proxy?: Record<string, unknown> };
const server = (viteConfig as { server?: ViteServer }).server ?? {};

describe('vite dev proxy', () => {
  const proxy = server.proxy ?? {};

  it('proxies /api', () => {
    expect(Object.keys(proxy)).toContain('/api');
  });

  it('every controller lives under /api', () => {
    expect(CONTROLLERS).toHaveLength(4);
    for (const ctor of CONTROLLERS) {
      const prefix = Reflect.getMetadata('path', ctor) as string;
      expect(prefix === 'api' || prefix.startsWith('api/')).toBe(true);
    }
  });
});

/**
 * The dev server has no auth in front of it and proxies /api straight through
 * to an API that reads every registered project's backlog off disk, so the
 * bind is the access control. `host: true` (0.0.0.0) is not covered by
 * `allowedHosts`: Vite short-circuits `if (net.isIP(hostname) === 4) return
 * true` before consulting the list, so a bare-IP Host header always passes.
 * BM_BIND is read at import time, hence the unset assertion below.
 */
describe('vite dev server bind', () => {
  it('binds loopback unless BM_BIND says otherwise', () => {
    expect(process.env.BM_BIND).toBeUndefined();
    expect(server.host).toBe('127.0.0.1');
  });
});
