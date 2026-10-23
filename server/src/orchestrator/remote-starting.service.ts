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
 *   1. an item entry — a claim by that machine's host is on the item whose comment id is above the entry's `floor`, live OR released (`claimsOn`). The
 *      floor is the highest claim comment id the tracker cache held for the issue when the launch was marked, so a claim already there (an earlier
 *      session's) is never read as this launch's landing. Released counts because a release is an edit, not a delete: a groom claims and releases inside
 *      one or two poll intervals, and when retirement needed the claim LIVE a sweep that missed that window left the entry to rule 3, refusing the item's
 *      natural next step (`execute` on the freshly groomed item) for the full `RUN_STALE_MS` (final-review I2). A `capture` is never marked at all: it
 *      files a NEW item and never claims the one it was launched from, so its entry could only ever age out;
 *   2. a project entry — a remote run of that project on that host started at or after `requestedAt`. "At or after" for `StartingRunsService` rule 1's
 *      reason: a run that started before this launch is not its landing;
 *   3. age past `RUN_STALE_MS`, the app's one freshness number — a launch that never claimed in that long is a broken session, diagnosed at its dashboard.
 *
 * Only `list` can apply rule 2 (it needs the remote runs, which only its caller holds), and it deletes what rules 1–3 retire, so the map is swept on every
 * runs read. `projectBlock` applies rule 3 alone: it is asked by a launch, which reads its own gates first — a live remote run is task 6's own 409 — so an
 * entry rule 2 would have retired but no read has swept yet refuses nothing those gates would not. `itemBlock` applies rule 1 as well, given the dispatch
 * route's `claimsOn`: once rule 1 retires on a RELEASED claim, an unswept entry would otherwise refuse what no claim gate does — the execute after a remote
 * groom that has already finished, clicked before the board's next runs read.
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
  /** An item entry's floor: the highest claim comment id on the issue at mark time, `0` when it had none. A project entry has none (`0`), unread. */
  floor: number;
  requestedAt: number;
}

/** One claim on an item as rule 1 reads it: the comment it lives in, and the host that wrote it (`null` when the claim recorded none). */
export interface ItemClaim {
  commentId: number;
  host: string | null;
}

export interface RemoteStartingListInput {
  nowMs: number;
  /** Every claim on `itemId` in `project`, live and released alike — read off this machine's tracker cache; empty for a non-tracker item. */
  claimsOn: (project: string, itemId: string) => readonly ItemClaim[];
  remoteRuns: Array<{ project: string; host: string | null; startedAt: string }>;
}

@Injectable()
export class RemoteStartingService {
  /** Keyed `item\0<project>\0<itemId>` or `project\0<project>\0<machine>` — one entry per key, so a repeat launch overwrites rather than accumulates. */
  private readonly entries = new Map<string, Entry>();

  /** `floor` is the highest claim comment id on the item at this moment (`RemoteRunsService.claimFloor`) — rule 1 waits for a claim above it. */
  markItem(project: string, itemId: string, machine: RemoteTarget, floor: number, nowMs: number = Date.now()): void {
    this.entries.set(itemKey(project, itemId), { kind: 'dispatch', project, machine: machine.id, host: machine.host, itemId, floor, requestedAt: nowMs });
  }

  markProject(project: string, machine: RemoteTarget, nowMs: number = Date.now()): void {
    this.entries.set(projectKey(project, machine.id), {
      kind: 'orchestrate',
      project,
      machine: machine.id,
      host: machine.host,
      itemId: null,
      floor: 0,
      requestedAt: nowMs
    });
  }

  /** The launch of `itemId` still starting on some machine, or `null`. Rule 3, and rule 1 when `claimsOn` is given — see the class comment for why. */
  itemBlock(project: string, itemId: string, nowMs: number = Date.now(), claimsOn?: RemoteStartingListInput['claimsOn']): RemoteStarting | null {
    const entry = this.entries.get(itemKey(project, itemId));
    if (entry === undefined || stale(entry, nowMs)) return null;
    return claimsOn !== undefined && landed(entry, claimsOn) ? null : toPayload(entry);
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
  if (entry.itemId !== null) return landed(entry, input.claimsOn);
  // `Date.parse` of an unreadable `startedAt` is NaN, and NaN >= anything is false: a run this reader cannot date cannot prove it is this launch's.
  return input.remoteRuns.some((run) => run.project === entry.project && run.host === entry.host && Date.parse(run.startedAt) >= entry.requestedAt);
}

/** Rule 1: a claim by the entry's host, newer than its floor, is on the item — live or released. A `null` host on either side matches nothing. */
function landed(entry: Entry, claimsOn: RemoteStartingListInput['claimsOn']): boolean {
  if (entry.itemId === null || entry.host === null) return false;
  return claimsOn(entry.project, entry.itemId).some((c) => c.commentId > entry.floor && c.host === entry.host);
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
