import { Injectable } from '@nestjs/common';

import { RUN_STALE_MS } from '../../../shared/types';
import type { RemoteStarting } from '../../../shared/types';

/**
 * remote-starting.service.ts — the in-memory record of "this server sent a launch to a REMOTE machine's dashboard, and nothing on the tracker shows it yet"
 * (multi-dashboard spec, "Starting on <machine> between a remote launch and its first claim"). The remote counterpart of `StartingRunsService` beside it, and
 * deliberately a separate map rather than a second kind of entry in that one: the local `starting` array is read by `runClaimBlock` and by the local expiry
 * rules (bug-21, bug-57), and a remote launch must never block this machine's own Orchestrate — so a remote entry riding in `starting` would be exactly the
 * block the spec forbids. It rides beside it, in its own payload field (task 6), the way `remote` rides beside `runs`.
 *
 * In memory only and never on disk, for `StartingRunsService`'s reason: an entry records a request THIS process made, a fact no file can answer, and a restart
 * forgetting it costs only the "starting" badge for the remainder of a launch — the claim the remote session writes is the durable trace.
 *
 * Two keys, one per launch kind, because the two block different things:
 *
 *   - a card dispatch is keyed by (project, item) — `itemBlock` — and blocks a second launch of THAT ITEM to ANY machine, home included: until the remote
 *     session's first claim lands, nothing on the tracker says the item is taken, so the claim checks every other gate reads would wave a second session
 *     through onto the same issue;
 *   - a remote orchestrate is keyed by (project, machine) — `projectBlock` — and blocks a second remote orchestrate of that project to THAT machine only. Two
 *     machines may drain one tracker project at once (the claim protocol keeps their items disjoint), so it never blocks another machine, and never home.
 *
 * Every entry carries the `host` the machine's claims will carry (`Machine.host`, the remote's `BM_MACHINE_NAME`), copied in at mark time: that is the only
 * way `list` can tell "the claim this launch was waiting for has appeared" from "somebody else's claim has", and the machine list is re-read per request, so
 * looking it up again at sweep time could answer for an entry edited away since.
 *
 * An entry dies on the first of:
 *   1. an item entry — the item is claimed by a session on that machine's host (`claimedHost`). A `capture` claims nothing (it files a NEW item), so for
 *      one only rule 3 applies;
 *   2. a project entry — a remote run of that project on that host started at or after `requestedAt`. "At or after" for `StartingRunsService` rule 1's
 *      reason: a run that started before this launch is not its landing;
 *   3. age past `RUN_STALE_MS`, the app's one freshness number — a launch that never claimed in that long is a broken session, diagnosed at its dashboard.
 *
 * Only `list` can apply rules 1 and 2 (they need the tracker cache and the remote runs, which only its caller holds), and it deletes what they retire, so the
 * map is swept on every runs read. `itemBlock` / `projectBlock` apply rule 3 alone: they are asked by a launch, which reads its own claim gates first —
 * `itemClaimBlock` already refuses an item a live claim holds, and a live remote run is task 6's own 409 — so an entry rules 1–2 would have retired but no
 * read has swept yet refuses nothing those gates would not.
 */

/** Who a launch went to: the machine id the entry is shown under, and the claim `host` that retires it. A structural `Machine` (agents/dashboards), so this
 *  module needs no import from agents/ — the edge runs agents → orchestrator only. */
export interface RemoteTarget {
  id: string;
  host: string | null;
}

interface Entry {
  kind: RemoteStarting['kind'];
  project: string;
  machine: string;
  host: string | null;
  itemId: string | null;
  requestedAt: number;
}

export interface RemoteStartingListInput {
  nowMs: number;
  /** The `host` of the live claim on `itemId` in `project`, or `null` when nothing claims it — read off this machine's tracker cache. */
  claimedHost: (project: string, itemId: string) => string | null;
  remoteRuns: Array<{ project: string; host: string | null; startedAt: string }>;
}

@Injectable()
export class RemoteStartingService {
  /** Keyed `item\0<project>\0<itemId>` or `project\0<project>\0<machine>` — one entry per key, so a repeat launch overwrites rather than accumulates. */
  private readonly entries = new Map<string, Entry>();

  markItem(project: string, itemId: string, machine: RemoteTarget, nowMs: number = Date.now()): void {
    this.entries.set(itemKey(project, itemId), { kind: 'dispatch', project, machine: machine.id, host: machine.host, itemId, requestedAt: nowMs });
  }

  markProject(project: string, machine: RemoteTarget, nowMs: number = Date.now()): void {
    this.entries.set(projectKey(project, machine.id), {
      kind: 'orchestrate',
      project,
      machine: machine.id,
      host: machine.host,
      itemId: null,
      requestedAt: nowMs
    });
  }

  /** The launch of `itemId` still starting on some machine, or `null`. Rule 3 only — see the class comment for why that is enough at a launch. */
  itemBlock(project: string, itemId: string, nowMs: number = Date.now()): RemoteStarting | null {
    const entry = this.entries.get(itemKey(project, itemId));
    return entry === undefined || stale(entry, nowMs) ? null : toPayload(entry);
  }

  /** The remote orchestrate of `project` still starting on `machine`, or `null`. Rule 3 only, as `itemBlock`. */
  projectBlock(project: string, machine: string, nowMs: number = Date.now()): RemoteStarting | null {
    const entry = this.entries.get(projectKey(project, machine));
    return entry === undefined || stale(entry, nowMs) ? null : toPayload(entry);
  }

  /**
   * The live entries, oldest first — and the sweep: every entry rules 1–3 retire is deleted here. Unlike `StartingRunsService` this is not split into a pure
   * `list` and a mutating `sweep`, because its one caller (the runs controller, task 6) holds the inputs at the moment it asks, and nothing reads this map
   * from inside a pure read the way `OrchestratorService.runs()` reads that one.
   */
  list(input: RemoteStartingListInput): RemoteStarting[] {
    const live: RemoteStarting[] = [];
    for (const [key, entry] of this.entries) {
      if (retired(entry, input)) {
        this.entries.delete(key);
        continue;
      }
      live.push(toPayload(entry));
    }
    return live;
  }
}

function itemKey(project: string, itemId: string): string {
  return `item\0${project}\0${itemId}`;
}

function projectKey(project: string, machine: string): string {
  return `project\0${project}\0${machine}`;
}

function stale(entry: Entry, nowMs: number): boolean {
  return nowMs - entry.requestedAt > RUN_STALE_MS;
}

/**
 * Rules 1–3. A `null` host (a remote entry always has one — the settings reader requires it — so this is defence, not a case) matches no claim and no run:
 * an entry that cannot recognise its own landing waits out rule 3 rather than being retired by somebody else's.
 */
function retired(entry: Entry, input: RemoteStartingListInput): boolean {
  if (stale(entry, input.nowMs)) return true;
  if (entry.host === null) return false;
  if (entry.itemId !== null) return input.claimedHost(entry.project, entry.itemId) === entry.host;
  // `Date.parse` of an unreadable `startedAt` is NaN, and NaN >= anything is false: a run this reader cannot date cannot prove it is this launch's.
  return input.remoteRuns.some((run) => run.project === entry.project && run.host === entry.host && Date.parse(run.startedAt) >= entry.requestedAt);
}

function toPayload(entry: Entry): RemoteStarting {
  return {
    kind: entry.kind,
    project: entry.project,
    machine: entry.machine,
    itemId: entry.itemId,
    requestedAt: new Date(entry.requestedAt).toISOString()
  };
}
