import { Injectable } from '@nestjs/common';

import type { MachinesStatus, MachineStatus } from '../../../../shared/types';
import { DashboardStatusService, HOME_BUDGET } from '../dashboard-status.service';
import { DashboardsService, type Machine } from './dashboards.service';
import { REMOTE_BUDGET } from './offers.service';
import { UsageService } from './usage.service';

/**
 * Every configured machine's health and usage, for the Settings › Dashboards page (spec 2026-10-23-dashboards-settings-page-design.md, "Server: one new read").
 * `GET /api/dashboards/machines` answers `read`. The offers answer the same two questions per PROJECT, in a launch sheet; this page has no project, so it asks
 * them of the machines themselves, in `machines()`' order (Home, then the file's remotes — the client's `ids` derivation puts the list in prefer order).
 *
 * Health only, never the project map. `DashboardStatusService.healthOf` reads `/api/health` and nothing else: `statusOf` and `remoteStatusOf` also read
 * `/api/configs` (up to 15 s), which a page with no project has no use for and which would make a remote's dot depend on a project it was never asked about.
 * Home's budget is its own 4 s, a remote's the 5 s every new outbound read gets (`REMOTE_BUDGET`).
 *
 * Health THEN usage within a machine, machines in parallel. Usage is read only once health says `enabled && reachable`: a dashboard that is down would spend
 * another 5 s timeout saying so, and `UsageService.read` has no `enabled` check of its own, so this gate is what keeps `BM_AGENTS` off egress-free for Home
 * too. The two reads are therefore sequential per machine — worst case one health budget plus one 5 s usage budget, about 9 s for Home and 10 s for a remote —
 * while `Promise.all` keeps one hung machine from delaying the others. `usage.read`'s `ageMs` is `usageAgeMs`, the same 60 s in-memory cache the offers share,
 * so opening Settings and opening a launch sheet cost one fetch per machine per minute between them.
 *
 * Unlike the offers, Home's usage is read when the file's source is `default` (Home alone): the offers skip it because no picker is drawn, while this page
 * draws Home's meters either way. `machines()` itself reads no file `source`, so nothing here distinguishes the cases.
 *
 * Nothing throws for a machine: `healthOf` turns a failure into `reachable: false` and `UsageService.read` never throws. No token and no URL reach the answer:
 * a `MachineStatus` is built field by field from the health answer, never by spreading a `Machine` or its `cfg` (which holds the token).
 */
@Injectable()
export class MachinesService {
  constructor(
    private readonly dashboards: DashboardsService,
    private readonly status: DashboardStatusService,
    private readonly usage: UsageService
  ) {}

  async read(nowMs: number): Promise<MachinesStatus> {
    const machines = await Promise.all(this.dashboards.machines().map((m) => this.one(m, nowMs)));
    return { machines };
  }

  private async one(m: Machine, nowMs: number): Promise<MachineStatus> {
    const budget = m.home ? HOME_BUDGET : REMOTE_BUDGET;
    const health = await this.status.healthOf(m.cfg, budget.healthMs);
    const read = health.enabled && health.reachable ? await this.usage.read(m, nowMs) : { usage: null, ageMs: null };
    const out: MachineStatus = {
      machine: m.id,
      enabled: health.enabled,
      reachable: health.reachable,
      remoteAnswer: health.remoteAnswer,
      spawnAvailable: health.spawnAvailable,
      spawnMaxPermission: health.spawnMaxPermission,
      usage: read.usage,
      usageAgeMs: read.ageMs
    };
    if (health.error !== undefined) out.error = health.error;
    return out;
  }
}
