import { Controller, Get, HttpException, Query } from '@nestjs/common';

import { OrchestratorService } from './orchestrator.service';
import { RemoteRunsService } from './remote-runs.service';
import { StartingRunsService } from './starting-runs.service';
import { WatchdogStateService } from './watchdog-state.service';
import type { OrchestratorArchivePayload, OrchestratorRun, OrchestratorRunsPayload } from '../../../shared/types';

/**
 * Feature-prefixed like AgentsController (`api/agents`), not flat like
 * ItemsController's bare `api` — see ItemsController's own comment for why
 * /api is non-negotiable at all: dev-mode Vite proxies exactly one prefix,
 * and test/vite-proxy.test.ts asserts no controller ever leaves it.
 */
@Controller('api/orchestrator')
export class OrchestratorController {
  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly watchdogState: WatchdogStateService,
    private readonly starting: StartingRunsService,
    private readonly remoteRuns: RemoteRunsService
  ) {}

  @Get('runs')
  runs(): OrchestratorRunsPayload {
    const payload = this.orchestrator.runs();
    // The one side effect on this otherwise read-only route —
    // OrchestratorService.runs() itself stays pure (see its own comment) —
    // deliberately placed here, AFTER the payload is fully built, rather
    // than inside the service method that builds it. This is how a board
    // that has simply had this endpoint open and polling the whole time
    // (mount, focus, its 5s live-run poll) can arm a sweeper that
    // bootstraps AFTER a run already started: without this call, the
    // sweeper would only ever learn a run exists from its own bootstrap
    // scan or from a spawn it made itself, never from one a terminal
    // session started while nobody's board had asked yet. In-memory only
    // (WatchdogStateService holds nothing on disk), and a safe no-op until
    // Task 3's sweeper ever calls setArmer() — this task ships with no
    // sweeper, so every call this endpoint makes today takes that no-op
    // path.
    this.watchdogState.observe(payload);
    // task-14's own half of that same split, in the same position and for
    // the identical reason: the PURE `list()` builds `payload.starting`, and
    // `sweep()` below is the mutation that actually deletes what that filter
    // hid. The response is decided by a pure function and the prune is
    // visibly a separate concern.
    //
    // Nothing about the response depends on the sweep — `list()` re-applies
    // every eviction rule on every call, so a map nobody ever swept leaks at
    // most one entry per project. AgentsService's own direct `runs()` calls
    // (the RUN_IN_PROGRESS lock, `resume()`) need no sweep of their own for
    // any rule a run FILE answers; the one they do lean on it for is the
    // remote-run case below, and there they err toward blocking.
    //
    // Other machines' runs (task-48), set HERE and never inside `runs()`: the
    // service is the run-state directory's reader and fills `remote: []`, so
    // its direct callers — the RUN_IN_PROGRESS lock and `resume()` — never see
    // another machine's run. That is what keeps two machines draining one
    // tracker project from blocking each other (spec §7.4).
    //
    // Read BEFORE the starting pair, since bug-51: a board-started run whose
    // driver ran on another machine appears only here, and it is as good an
    // answer to "has the run this mark was for started" as a run file. So the
    // payload's `starting` is re-filtered against both, and the sweep deletes
    // what that filter hid — which is also what frees the direct callers above,
    // since they never see a remote run themselves. One `now` for both halves,
    // so they decide at the same instant. The watchdog still reads `runs`
    // alone: a remote run has nothing for it to do.
    const remote = this.remoteRuns.list();
    const now = Date.now();
    payload.starting = this.starting.list(payload.runs, now, remote);
    this.starting.sweep(payload.runs, now, remote);
    payload.remote = remote;
    return payload;
  }

  @Get('archive')
  archive(): OrchestratorArchivePayload {
    return this.orchestrator.archive();
  }

  /**
   * One run file, verbatim (tails included), for the archive view's detail
   * pane (Task 2). `project`/`runId` ride as query params — the same
   * transport GET /api/items/body uses for its own path param, and for the
   * same reason: this is a GET, so there is no body to carry them in.
   * `project` already rides unmodified in every /archive response entry
   * (`OrchestratorRun.project`), so exposing it again in this query string
   * discloses nothing that endpoint doesn't already hand the client.
   *
   * A missing/empty param short-circuits to `null` before the service is
   * even called, rather than letting `undefined` reach `archivedRun` and
   * fail some guard there — RUN_ID_RE would reject `undefined` coerced to a
   * string anyway, but a param that was never supplied at all is exactly as
   * "not found" as one that was supplied and didn't match, so it collapses
   * to the same null → 404 here rather than growing a second failure path.
   */
  @Get('archive/run')
  archivedRun(@Query('project') project: string | undefined, @Query('runId') runId: string | undefined): OrchestratorRun {
    const run = project && runId ? this.orchestrator.archivedRun(project, runId) : null;
    if (run === null) throw new HttpException({ error: 'not found' }, 404);
    return run;
  }
}
