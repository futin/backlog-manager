import { Module } from '@nestjs/common';

import { GithubClient } from './github.client';
import { TrackerPollerService } from './poller.service';
import { PullsController } from './pulls.controller';
import { PullRequestsService } from './pulls.service';
import { TrackerController } from './tracker.controller';
import { RegistryModule } from '../registry/registry.module';

/**
 * The tracker seam's own module (task-45): the poller, the client it calls
 * through, and the read-only route the Sources card and GitHub › Settings draw.
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
 * budget and the Sources card would show whichever was asked last.
 *
 * The dependency runs one way only — items depend on the tracker, never the
 * reverse — which is what keeps the adapter a plain reader over a cache.
 *
 * `PullRequestsService` (the PRs page's on-demand cache) lives here because it is a GitHub caller like the poller, sharing the one client — so GraphQL's
 * rate bookkeeping is one reading too — and the poller, whose secondary sleep it reads and sets. `PullsController` (`GET /api/prs` and the three guarded
 * PR writes) is declared here beside it, so the PR surface is one module's, like the issue surface's read route.
 */
@Module({
  imports: [RegistryModule],
  controllers: [TrackerController, PullsController],
  providers: [TrackerPollerService, PullRequestsService, { provide: GithubClient, useFactory: () => new GithubClient() }],
  exports: [TrackerPollerService, PullRequestsService, GithubClient]
})
export class TrackerModule {}
