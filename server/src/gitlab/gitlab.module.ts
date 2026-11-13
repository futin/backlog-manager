import { Module } from '@nestjs/common';

import { SameOriginPostGuard } from '../agents/origin.guard';
import { JiraLiveService } from '../jira/live.service';
import { JiraModule } from '../jira/jira.module';
import { GitlabClient } from './gitlab.client';
import { GitlabController } from './gitlab.controller';
import { GitlabPollerService } from './poller.service';

/**
 * The GitLab connection. `JiraModule` is imported only for `JiraLiveService`, whose `onReposChanged` is how a `jira.json` repos save re-aims the poller
 * without `gitlab/` importing `jira/`'s poller. The poller's 2nd and 3rd constructor parameters are not class tokens, so it is built by a factory; the client
 * is a provider so a test can swap it for one on a fake `fetch`, as `JiraClient` is.
 */
@Module({
  imports: [JiraModule],
  controllers: [GitlabController],
  providers: [
    { provide: GitlabClient, useFactory: () => new GitlabClient() },
    { provide: GitlabPollerService, useFactory: (client: GitlabClient, live: JiraLiveService) => new GitlabPollerService(client, live), inject: [GitlabClient, JiraLiveService] },
    SameOriginPostGuard
  ],
  // Review dispatch (`agents/`) reads the poller's cache through `findMr` / `reposFor` and never makes a GitLab call of its own.
  exports: [GitlabPollerService]
})
export class GitlabModule {}
