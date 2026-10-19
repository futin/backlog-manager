import { Module } from '@nestjs/common';

import { JiraClient } from './jira.client';
import { JiraController } from './jira.controller';
import { JiraWriteController } from './jira-write.controller';
import { JiraLiveService } from './live.service';
import { JiraPollerService } from './poller.service';

/**
 * The Jira seam's own module (Jira phase 1, spec §12): the poller, the client it calls through, the seven read routes (six in phase 1, `GET /prompt` in phase 5) and — since phase 2 — the three write
 * routes (`JiraWriteController`, which touches `jira.json` and the poller, never Jira itself). It mirrors `TrackerModule`
 * (`server/src/tracker/tracker.module.ts`), and for the same reasons.
 *
 * `JiraClient` is provided as a factory value rather than a decorated class: it has no Nest decorators on purpose (a test constructs one on a fake `fetch`
 * and needs no module to do it), so the factory is where the real `fetch` is bound and the one place a suite overrides to intercept every outbound call
 * this server can make to Jira. One instance for the whole process is also what makes the call counter a single reading — `takeCalls()` is how the poller
 * reports the CALLS meter, and two clients would each count half.
 *
 * Both providers are exported. The poller is the read side for everything that comes after this phase — the board's sheets (phase 3), the item modal
 * (phase 4) and the dispatch route (phase 5) all ask it, never Jira — and the client is exported for the calls later phases add, which must use the same
 * instance for the same reason.
 *
 * The dependency runs one way: `AgentsModule` will import this module (phase 5's dispatch needs the poller's issue read and its cache), and this module
 * never imports `AgentsModule`. A Jira seam that reached back into the dispatcher would make the read side depend on the thing that acts on it, and a
 * cycle between two modules that both own a timer is the one place Nest's forward references would hide a start-up ordering bug.
 *
 * `JiraLiveService` (phase 5) is the in-memory key → live-session map and is exported for the same one-way reason: `AgentsModule`'s dispatch route and reconciler
 * reserve, confirm, release and read it. It is pure memory, so providing it here adds no import in either direction; the controller composes it into `live` and
 * `session`, and the poller never sees it.
 *
 * No `RegistryModule` import, unlike the tracker's: nothing here resolves a project. `jira.json` is read straight from its own file.
 */
@Module({
  controllers: [JiraController, JiraWriteController],
  providers: [JiraPollerService, JiraLiveService, { provide: JiraClient, useFactory: () => new JiraClient() }],
  exports: [JiraPollerService, JiraClient, JiraLiveService]
})
export class JiraModule {}
