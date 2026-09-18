import { Injectable } from '@nestjs/common';

import { isRepo } from '../../tracker/github.client';
import { mapIssue, parseUrn } from '../../tracker/map-issue';
import { TrackerPollerService } from '../../tracker/poller.service';
import { resolveSource } from './resolve.util';
import type { SourceMarker } from './resolve.util';
import type { ItemSource, SourceSummary } from './source';
import type { BacklogItem, Registry, RegistryProject } from '../../../../shared/types';

/**
 * The second adapter behind the seam (task-45, spec §5): a project whose items
 * are GitHub issues. It is the test of task-43's claim — this class plus two
 * lines in `items.module.ts` is the whole registration, and `items.service.ts`
 * control flow did not change to accept it.
 *
 * **It makes no network calls.** Every answer here comes out of
 * `TrackerPollerService`'s in-memory cache, which is what makes `list` cheap
 * enough to call on every board render: a per-request fetch would spend the
 * hourly rate limit in a few minutes of someone watching the board. The price
 * is that the items are up to one poll interval old, and the price is PAID
 * openly — `summary` carries `polledAt` and the board renders its age (spec
 * §5.5).
 */
@Injectable()
export class GithubSource implements ItemSource {
  readonly kind = 'github' as const;

  constructor(private readonly poller: TrackerPollerService) {}

  /**
   * Every cached issue of this project's repo, mapped. Reaching this method at
   * all means `resolveSource` answered `tracker` for a `github` marker, which
   * is the cheapest honest signal that something is connected — so this is
   * also where the poller is armed (see `arm()`'s own comment for why every
   * caller of it is a signal rather than a command). A repo connected after
   * boot is therefore polled from the first board read that touches it.
   *
   * A marker with no usable `repo` is one `errors` entry and no items, the
   * same tolerant shape a malformed item file gets: the marker is on disk in
   * somebody's repo, and a board that 500s because one of five projects has a
   * typo is a worse answer than one that renders the other four.
   */
  async list(project: RegistryProject, marker: SourceMarker | null): Promise<{ items: BacklogItem[]; errors: string[] }> {
    this.poller.arm();

    const repo = marker?.repo;
    if (!isRepo(repo)) {
      return { items: [], errors: [`${project.path}: backlog/source.json names no valid "repo" (expected "owner/name")`] };
    }

    const items: BacklogItem[] = [];
    const errors: string[] = [];
    for (const issue of this.poller.issues(repo)) {
      const mapped = mapIssue(issue, repo, project);
      // `null` is a pull request, which the issues endpoint returns alongside
      // real issues and which is not an item at all — dropped silently,
      // because there is nothing wrong with the repo containing PRs.
      if (mapped === null) continue;
      items.push(mapped.item);
      errors.push(...mapped.errors);
    }
    return { items, errors };
  }

  /**
   * One issue's body, by URN, from the cache — no fetch, which is why the item
   * modal can open instantly and why it draws the poll age beside the body
   * (spec §5.5).
   *
   * Gated on the REGISTRY, exactly as the files adapter's allowlist is: a URN
   * naming a repo no registered project is connected to answers `null`, and
   * the route turns that into a 404 without saying why. The gate reads the
   * registry object it was handed rather than asking the poller, so the
   * service keeps its one registry read per request — and so that a repo which
   * is merely IN THE CACHE (connected a minute ago, disconnected since) is not
   * readable through a stale in-memory copy of who is connected.
   */
  async body(ref: string, registry: Registry): Promise<string | null> {
    const urn = parseUrn(ref);
    if (urn === null) return null;
    if (!connectedRepos(registry).has(urn.repo)) return null;
    const issue = this.poller.issue(urn.repo, urn.number);
    if (issue === undefined) return null;
    // An issue with an empty body is `''`, not `null`: the item exists and its
    // body is empty, which the modal should render as an empty body rather
    // than as a 404 claiming there is no such item.
    return issue.body ?? '';
  }

  /** The live connection state (spec §5.4), straight off the poller. A marker
   *  with no usable repo has no connection to describe, so all four fields are
   *  `null` — the same answer a files project gives, because "there is nothing
   *  connected here" is the same fact in both cases. The `errors` entry `list`
   *  produced is where the reason lives. */
  async summary(_project: RegistryProject, marker: SourceMarker | null): Promise<SourceSummary> {
    const repo = marker?.repo;
    if (!isRepo(repo)) return { repo: null, polledAt: null, access: null, detail: null };
    return this.poller.summary(repo);
  }
}

/** The repos the registry says someone is connected to, right now. Built from
 *  the registry handed in, one `resolveSource` per project — the same per
 *  request read `ItemsService` already makes, and deliberately not a cached
 *  set: connecting or disconnecting a project must take effect on the next
 *  request, like every other registry-shaped change in this server. */
function connectedRepos(registry: Registry): Set<string> {
  const out = new Set<string>();
  for (const project of registry.projects) {
    const resolved = resolveSource(project.path, KNOWN);
    if (resolved.kind !== 'tracker') continue;
    if (isRepo(resolved.marker.repo)) out.add(resolved.marker.repo);
  }
  return out;
}

const KNOWN: ReadonlySet<string> = new Set(['github']);
