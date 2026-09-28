import { Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';

import { OrchestratorService } from './orchestrator.service';
import { SameOriginPostGuard } from '../agents/origin.guard';
import { resolveSource } from '../items/sources/resolve.util';
import type { SourceSummary } from '../items/sources/source';
import { RegistryService } from '../registry/registry.service';
import { isRepo } from '../tracker/github.client';
import { TrackerPollerService } from '../tracker/poller.service';
import { writeSyncInterval } from '../tracker/sync-config.util';
import { isSyncInterval } from '../../../shared/types';

/**
 * `POST /api/trackers/sync` — set one repo's sync interval on this machine (#17, spec §6). The one write path onto `settings/tracker-sync.json`, which
 * `writeSyncInterval` owns; this handler validates, refuses, writes and re-arms, and never touches the file itself.
 *
 * **Why it lives in `OrchestratorModule` and not beside `GET /api/trackers`** (plan amendment 3): the 409 below needs `OrchestratorService` (the run files)
 * and `StartingRunsService` (the in-memory starting entries), and both are provided here. `TrackerModule` is imported BY this module, so hosting the route
 * there would need those two back — orchestrator → tracker → orchestrator, a module cycle. The path stays `/api/trackers/…` because the route is about the
 * tracker; which module owns the class is plumbing.
 *
 * **Why `off` is refused under a live run** (spec §6, amendment 1): a run's driver claims, releases and writes through this server, and every one of those
 * refuses while a repo is `off` (`TrackerPollerService.syncOffBlock`) — so switching a repo off under a running drain would park it at its next write, and
 * under a PAUSED one would park its resume. A run file reading `running` or `paused` for any registered project on the repo, or a starting entry for one,
 * therefore answers 409. Any other interval during a run is allowed: slowing a live run's sync costs latency, and that is the user's call to make.
 *
 * Guarded like every agents POST (`SameOriginPostGuard`, content type and origin): it calls nothing outbound, but it changes what this server will write
 * and refuse, which a cross-origin page must not be able to reach.
 */
@Controller('api/trackers')
export class TrackerSyncController {
  constructor(
    private readonly registry: RegistryService,
    private readonly poller: TrackerPollerService,
    private readonly orchestrator: OrchestratorService
  ) {}

  /**
   * `@HttpCode(200)` for the reason `watchdog/config` gives: this redraws an existing setting rather than creating anything. The answer is the repo's
   * `summary()` — the same fields a Trackers row carries — so the card can show the server's value rather than an optimistic one.
   *
   * The checks run in the table's order, each its own status: a malformed request is a 400 before anything is looked up, an unconnected repo a 404 before
   * any run is read, and the 409 only for `off`.
   */
  @UseGuards(SameOriginPostGuard)
  @Post('sync')
  @HttpCode(200)
  sync(@Body() body: unknown): SourceSummary {
    const b = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { repo?: unknown; interval?: unknown }) : null;
    if (b === null || typeof b.repo !== 'string' || !isRepo(b.repo)) throw new HttpException({ error: 'repo must be owner/name' }, 400);
    const repo = b.repo;
    const interval = b.interval;
    if (!isSyncInterval(interval)) throw new HttpException({ error: 'interval must be one of 15s, 1m, 5m, off' }, 400);
    if (!this.poller.connectedRepos().includes(repo)) throw new HttpException({ error: `no registered project is connected to ${repo}` }, 404);

    if (interval === 'off') {
      const blocker = this.liveRunOn(repo);
      if (blocker !== null) throw new HttpException({ error: blocker }, 409);
    }

    writeSyncInterval(repo, interval);
    // Re-arm: a no-op when a chain is alive, a restart when every repo had been `off` and the chain had disarmed, and a disarm when this write turned the
    // last live repo off (`arm()` clears the timer when `shouldPoll` is false).
    this.poller.arm();
    return this.poller.summary(repo);
  }

  /** The refusal naming the first run that holds `repo` open, or `null`. Registry order, so the answer is stable; one `runs()` read for both halves. */
  private liveRunOn(repo: string): string | null {
    const onRepo = this.registry.load().projects.filter((p) => {
      const resolved = resolveSource(p.path, KNOWN);
      return resolved.kind === 'tracker' && resolved.marker.repo === repo;
    });
    const { runs, starting } = this.orchestrator.runs();
    for (const project of onRepo) {
      const run = runs.find((r) => r.project === project.path && (r.status === 'running' || r.status === 'paused'));
      if (run !== undefined) return `sync cannot be turned off while a run is ${run.status} in ${project.name} (run ${run.runId})`;
      if (starting.some((s) => s.project === project.path)) return `sync cannot be turned off while a run is starting in ${project.name}`;
    }
    return null;
  }
}

/** The kinds this route can describe — the same single-adapter set the poller resolves with. */
const KNOWN: ReadonlySet<string> = new Set(['github']);
