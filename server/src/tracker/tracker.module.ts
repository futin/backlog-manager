import { Module } from '@nestjs/common';

import { GithubClient } from './github.client';
import { TrackerPollerService } from './poller.service';
import { TrackerController } from './tracker.controller';
import { RegistryModule } from '../registry/registry.module';

/**
 * The tracker seam's own module (task-45): the poller, the client it calls
 * through, and the read-only route the Trackers card draws.
 *
 * `GithubClient` is provided as a value rather than a decorated class — it has
 * no Nest decorators on purpose (see its header: a test constructs one with a
 * fake `fetch` and needs no module to do it), so the factory is where the real
 * `fetch` is bound and the one place a suite overrides to intercept every
 * outbound call this server can make.
 *
 * Both are exported so `ItemsModule` can inject them into `GithubSource`: the
 * poller for every read (the cache IS the read side) and, since task-46, the
 * client for every write. ONE client instance across the process is what makes
 * the rate-limit headers a single reading — two would each report half the
 * budget and the Trackers card would show whichever was asked last.
 *
 * The dependency runs one way only — items depend on the tracker, never the
 * reverse — which is what keeps the adapter a plain reader over a cache.
 */
@Module({
  imports: [RegistryModule],
  controllers: [TrackerController],
  providers: [TrackerPollerService, { provide: GithubClient, useFactory: () => new GithubClient() }],
  exports: [TrackerPollerService, GithubClient]
})
export class TrackerModule {}
