import 'reflect-metadata';

import viteConfig from '../vite.config';
import { HealthController } from '../server/src/health/health.controller';
import { ItemsController } from '../server/src/items/items.controller';

/**
 * The dev proxy has exactly one entry, /api — which is only safe while every
 * server controller actually lives under /api. A controller registered
 * outside it would not 404 in dev: Vite's SPA fallback answers with
 * index.html, and the failure is a silently-wrong response instead of an
 * error. So the invariant is asserted from Nest's own route metadata, not a
 * hand-kept list. Any new controller must be added to CONTROLLERS here —
 * the length assertion is the reminder.
 */
const CONTROLLERS = [HealthController, ItemsController];

describe('vite dev proxy', () => {
  const proxy = (viteConfig as { server?: { proxy?: Record<string, unknown> } }).server?.proxy ?? {};

  it('proxies /api', () => {
    expect(Object.keys(proxy)).toContain('/api');
  });

  it('every controller lives under /api', () => {
    expect(CONTROLLERS).toHaveLength(2);
    for (const ctor of CONTROLLERS) {
      const prefix = Reflect.getMetadata('path', ctor) as string;
      expect(prefix === 'api' || prefix.startsWith('api/')).toBe(true);
    }
  });
});
