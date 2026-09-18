import { Controller, Get } from '@nestjs/common';

import { originRepo } from './origin.util';
import { TrackerPollerService } from './poller.service';
import { isRepo } from './github.client';
import { resolveSource } from '../items/sources/resolve.util';
import { RegistryService } from '../registry/registry.service';
import type { TrackerProjectRow, TrackersPayload } from '../../../shared/types';

/**
 * `GET /api/trackers` — the Shared Settings page's Trackers card (task-45,
 * spec §5.6). Read-only, and the whole route surface this phase adds: nothing
 * POSTs here, there is no connections file, and connecting a project is
 * `backlog.mjs connect` writing a marker someone then commits.
 *
 * Under `/api` like every other route (CLAUDE.md), and unguarded for
 * `ItemsController.uncommitted`'s stated reason: `SameOriginPostGuard` answers
 * "may this caller POST at all", and this route starts nothing and reads no
 * caller-supplied path. It discloses strictly less than `/api/projects`
 * already does to the same reader — plus one login and a rate-limit count,
 * and **never the token**.
 *
 * Every read is per request and cached nowhere: the registry, each project's
 * marker, and each files project's `origin`. The one thing that IS cached —
 * the poll state — is cached in the poller, whose age this card renders.
 */
@Controller('api')
export class TrackerController {
  constructor(
    private readonly registry: RegistryService,
    private readonly poller: TrackerPollerService
  ) {}

  @Get('trackers')
  trackers(): TrackersPayload {
    const platform = this.poller.platform();
    const projects: TrackerProjectRow[] = [];

    for (const project of this.registry.load().projects) {
      const resolved = resolveSource(project.path, KNOWN);
      const row: TrackerProjectRow = {
        name: project.name,
        path: project.path,
        source: null,
        repo: null,
        polledAt: null,
        access: null,
        detail: null,
        connect: null
      };

      if (resolved.kind === 'tracker' && isRepo(resolved.marker.repo)) {
        row.source = 'github';
        Object.assign(row, this.poller.summary(resolved.marker.repo));
      } else if (resolved.kind === 'tracker' || resolved.kind === 'unsupported') {
        // A marker that is present and cannot be honoured — malformed, or a
        // `github` marker with no usable `repo`. `unsupported` here matches
        // exactly what `/api/projects` says about the same project, rather
        // than inventing a second vocabulary for the same state.
        row.source = 'unsupported';
      } else if (resolved.kind === 'files') {
        row.source = 'files';
        const origin = originRepo(project.path);
        // The suggestion, and only for a project that could actually take it:
        // a files project whose origin is on GitHub. Read per request (see
        // `origin.util.ts` for why it joins no memo).
        if (origin !== null) row.connect = `backlog.mjs connect github ${origin}`;
      }
      // `missing` stays all-nulls: a project with no `backlog/` at all has no
      // source to report and nothing to connect until someone runs `init` or
      // `connect`, which the board already reports in its own words.

      projects.push(row);
    }

    return {
      platforms: [
        {
          kind: 'github',
          hasToken: platform.token,
          login: platform.login,
          limit: platform.rate.limit,
          remaining: platform.rate.remaining,
          reset: platform.rate.reset
        }
      ],
      projects
    };
  }
}

/** The kinds this card can describe — the same single-adapter set the poller
 *  resolves with. */
const KNOWN: ReadonlySet<string> = new Set(['github']);
