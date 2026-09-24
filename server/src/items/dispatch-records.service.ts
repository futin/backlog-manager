import { Injectable } from '@nestjs/common';

import type { AgentAction } from '../../../shared/agent';

/**
 * dispatch-records.service.ts — which session ids THIS server spawned through `POST /api/agents/dispatch` (#225), held in memory and nowhere else.
 *
 * ## Why this exists
 *
 * A board-dispatched groom or execute session claims its issue the moment it starts, and releases it only by running its own closing `stop`. Stop that
 * session from the dashboard, or let it die, and the claim stays live with its heartbeat ticking toward stale — and before this record existed nothing on
 * the board could let it go: `dispatch` got a `sessionId` back from the spawn and forgot it. This is that id remembered, so `POST /api/items/abort` can say
 * "the board started the session that holds this claim" without asking anyone, and so the item payload can mark the holder as one this board can stop.
 *
 * ## Why in memory, and why here
 *
 * In memory because the fact it records is only true for as long as this process has been up: a restart loses the record, and the abort route then falls
 * back to its stricter no-record case — same host, and the dashboard says the session is not running — which is the right answer for a session nobody can
 * vouch for any more. Written to disk it would outlive the knowledge it stands for. The same trade `StartingRunsService` makes for a board-started run.
 *
 * In `ItemsModule` rather than `AgentsModule` because both sides read it and the module edge runs agents → items only: `AgentsService.dispatch` writes it,
 * and `GithubSource.list` reads it to set `BacklogItem.holder.dispatched`. Held on the agents side, the items side would have to import agents back, which is
 * the cycle Nest cannot construct.
 *
 * Only `dispatch` records. An orchestrate, resume or stop spawn starts a DRIVER, whose claims carry `run` and which the abort route refuses outright — a run
 * owns its items for the whole item, and releasing one under it is `backlog-orchestrate`'s own business.
 */

export interface DispatchRecord {
  projectPath: string;
  /** `BacklogItem.path` — the URN for a tracker item, the file path otherwise. */
  itemPath: string;
  action: AgentAction;
  /** Epoch ms of the spawn. */
  at: number;
}

/** A day: longer than any one groom or execute session runs, and short enough that a server left up for weeks does not keep every id it ever spawned. */
export const DISPATCH_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

/** A ceiling as well as the age, so a burst of dispatches cannot grow the map without bound between prunes. Oldest go first. */
export const DISPATCH_RECORD_CAP = 200;

@Injectable()
export class DispatchRecordsService {
  /** Insertion-ordered, which is what makes "drop the oldest" a walk from the front. */
  private readonly records = new Map<string, DispatchRecord>();

  record(sessionId: string, record: DispatchRecord): void {
    this.records.delete(sessionId);
    this.records.set(sessionId, record);
    this.prune(record.at);
  }

  get(sessionId: string, now = Date.now()): DispatchRecord | null {
    this.prune(now);
    return this.records.get(sessionId) ?? null;
  }

  /** Called once the abort's release has LANDED, never before: a release GitHub refused leaves the session's claim live, and the retry still needs to find it
   *  was ours. */
  forget(sessionId: string): void {
    this.records.delete(sessionId);
  }

  private prune(now: number): void {
    for (const [id, r] of this.records) {
      if (now - r.at > DISPATCH_RECORD_TTL_MS || this.records.size > DISPATCH_RECORD_CAP) this.records.delete(id);
      else break;
    }
  }
}
