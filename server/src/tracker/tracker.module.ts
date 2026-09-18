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
 * Exported so `ItemsModule` can inject the poller into `GithubSource`. The
 * dependency runs one way only — items depend on the tracker, never the
 * reverse — which is what keeps the adapter a plain reader over a cache.
 */
@Module({
  imports: [RegistryModule],
  controllers: [TrackerController],
  providers: [TrackerPollerService, { provide: GithubClient, useFactory: () => new GithubClient() }],
  exports: [TrackerPollerService]
})
export class TrackerModule {}
