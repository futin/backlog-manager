import { Controller, Get, HttpException, Query } from '@nestjs/common';

import { OrchestratorService } from './orchestrator.service';
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
    private readonly watchdogState: WatchdogStateService
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
