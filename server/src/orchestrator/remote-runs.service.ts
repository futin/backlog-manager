import { Injectable } from '@nestjs/common';

import { OrchestratorService } from './orchestrator.service';
import { deriveRemoteRuns } from './remote-runs.util';
import type { ItemClaim } from './remote-starting.service';
import { RegistryService } from '../registry/registry.service';
import { resolveSource } from '../items/sources/resolve.util';
import { claimsFor } from '../tracker/claim';
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
 * re-derives from the poller's cache, which is one of the three caches in this
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
      // One repo whose derivation throws says nothing, the same "says nothing" an unsynced repo gets, and every other repo still derives (#266). The
      // claims reaching `deriveRemoteRuns` are shape-checked by `parseClaim` now, so this is the second line, not the first: before it, one forged
      // comment answered 500 on every poll of the runs route — which carries this machine's own runs too — for as long as the comment sat in the cache.
      try {
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
      } catch (err) {
        console.warn(`remote runs for ${repo} skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  /**
   * Every claim on `itemId` in `project` — live and released alike, oldest comment first — read off the poller's cached comments, like `list`
   * (multi-dashboard task 6, reworked by final-review I2). `RemoteStartingService.list`'s `claimsOn`: a remote card dispatch's "starting on <machine>"
   * retires once a claim by that machine's host newer than the launch is on the item. Released claims are included on purpose — a release edits the
   * comment rather than deleting it (`map-issue.ts` reads the newest claim "released or not" for the same reason), and a groom that claims and releases
   * between two polls is otherwise never seen to land. Not `winner`: a race loser's comment is still that host's session reaching the item, and the
   * entry only ever asks "has this launch landed", never "who holds it".
   *
   * Empty for anything that is not a tracker item id (`#<n>`, the id a GitHub item carries) or not a tracker project — a files item never has a remote
   * entry to retire, because a remote launch of one is a 400.
   */
  claimsOn(project: string, itemId: string): ItemClaim[] {
    const number = /^#(\d+)$/.exec(itemId);
    if (number === null) return [];
    const resolved = resolveSource(project, KNOWN);
    if (resolved.kind !== 'tracker' || !isRepo(resolved.marker.repo)) return [];
    return claimsFor(Number(number[1]), this.poller.comments(resolved.marker.repo)).map((c) => ({ commentId: c.commentId, host: c.record.host ?? null }));
  }

  /** The floor `RemoteStartingService.markItem` records: the highest claim comment id on the item right now, `0` when it has none. */
  claimFloor(project: string, itemId: string): number {
    return this.claimsOn(project, itemId).reduce((max, c) => Math.max(max, c.commentId), 0);
  }
}
