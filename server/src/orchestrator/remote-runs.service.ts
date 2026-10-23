import { Injectable } from '@nestjs/common';

import { OrchestratorService } from './orchestrator.service';
import { deriveRemoteRuns } from './remote-runs.util';
import { RegistryService } from '../registry/registry.service';
import { resolveSource } from '../items/sources/resolve.util';
import { claimsFor, liveClaims, winner } from '../tracker/claim';
import { isRepo } from '../tracker/github.client';
import { intervalFor } from '../tracker/sync-config.util';
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
 * re-derives from the poller's cache, which is one of the two caches in this
 * server whose age is rendered — a second copy here would be a second age
 * nobody renders. A repo that never synced has no comments and so no remote
 * runs, which is the same "says nothing" a never-synced repo's board shows.
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
    // An `off` repo derives nothing (#17, spec §5) — the same "says nothing" a never-synced repo gets. Its comment cache is frozen, so a claim that was
    // live when sync stopped would keep drawing another machine's run as running for as long as sync stays off: bug-55's phantom, by a different road.
    for (const repo of [...projects.keys()]) if (intervalFor(repo) === 'off') projects.delete(repo);
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

  /**
   * The `host` of the live claim holding `itemId` in `project`, or `null` when nothing holds it — read off the poller's cached comments, like `list`
   * (multi-dashboard task 6). `RemoteStartingService.list`'s `claimedHost`: a remote card dispatch's "starting on <machine>" retires the moment the item is
   * held by a session on that machine's host. The holder is the claim protocol's own (`winner` of the live claims, lowest comment id), so a race loser's
   * still-standing comment never reads as the landing.
   *
   * `null` for anything that is not a tracker item id (`#<n>`, the id a GitHub item carries) or not a tracker project — a files item never has a remote
   * entry to retire, because a remote launch of one is a 400.
   */
  claimedHost(project: string, itemId: string, nowMs: number = Date.now()): string | null {
    const number = /^#(\d+)$/.exec(itemId);
    if (number === null) return null;
    const resolved = resolveSource(project, KNOWN);
    if (resolved.kind !== 'tracker' || !isRepo(resolved.marker.repo)) return null;
    const holder = winner(liveClaims(claimsFor(Number(number[1]), this.poller.comments(resolved.marker.repo)), nowMs));
    return holder?.record.host ?? null;
  }
}
