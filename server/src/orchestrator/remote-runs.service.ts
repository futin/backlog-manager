import { Injectable } from '@nestjs/common';

import { OrchestratorService } from './orchestrator.service';
import { deriveRemoteRuns } from './remote-runs.util';
import { RegistryService } from '../registry/registry.service';
import { resolveSource } from '../items/sources/resolve.util';
import { isRepo } from '../tracker/github.client';
import { TrackerPollerService } from '../tracker/poller.service';
import type { RemoteRun } from '../../../shared/types';

/** The adapters `resolveSource` may answer `tracker` for here — the same set
 *  the poller's `connectedRepos` passes, restated because it is a one-member
 *  literal and an export for it would be an import across two modules for a
 *  word. */
const KNOWN: ReadonlySet<string> = new Set(['github']);

/**
 * remote-runs.service.ts — `OrchestratorRunsPayload.remote` (task-48).
 *
 * The Nest half of `remote-runs.util.ts`: for each registered project that
 * resolves to a GitHub tracker, derive that repo's runs from the POLLER'S
 * CACHED comments, and concatenate.
 *
 * Makes no network request and keeps no cache of its own. Every call
 * re-derives from the poller's cache, which is the one cache in this server
 * whose age is rendered — a second copy here would be a second age nobody
 * renders. A repo that never synced has no comments and so no remote runs,
 * which is the same "says nothing" a never-synced repo's board shows.
 *
 * `OrchestratorService` is not taught any of this. It stays the run-state
 * directory's one reader, and what it contributes is the set of run ids this
 * machine holds a file for, which is what a derived run is dropped against.
 */
@Injectable()
export class RemoteRunsService {
  constructor(
    private readonly registry: RegistryService,
    private readonly poller: TrackerPollerService,
    private readonly orchestrator: OrchestratorService
  ) {}

  list(nowMs: number = Date.now()): RemoteRun[] {
    // repo → THIS machine's registry path for it, first registration wins. A
    // claim carries no path; the other machine's would mean nothing here.
    const projects = new Map<string, string>();
    for (const project of this.registry.load().projects) {
      const resolved = resolveSource(project.path, KNOWN);
      if (resolved.kind !== 'tracker') continue;
      const repo = resolved.marker.repo;
      if (isRepo(repo) && !projects.has(repo)) projects.set(repo, project.path);
    }
    if (projects.size === 0) return [];

    const localRunIds = this.orchestrator.localRunIds();
    const out: RemoteRun[] = [];
    for (const [repo, project] of projects) {
      out.push(
        ...deriveRemoteRuns({
          repo,
          project,
          comments: this.poller.comments(repo),
          issueTitle: (n) => this.poller.issue(repo, n)?.title ?? null,
          localRunIds,
          nowMs
        })
      );
    }
    return out;
  }
}
