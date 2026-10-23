import { machineLabelById } from './dashboards';
import type { BacklogItem, DashboardsView, RemoteStarting } from '../../../shared/types';

/**
 * remote-starting.ts — the board's readings of `OrchestratorRunsPayload.remoteStarting` (multi-dashboard task 10), one home for each so the card, the run
 * chip and the Runs page cannot word the same launch three ways.
 *
 * A `RemoteStarting` is the server's record that a launch was SENT to a remote dashboard and has not yet shown up in that machine's claims. It is deliberately
 * its own array and never folded into `starting` (bug-57): `runClaimBlock` and the local expiry read `starting`, and a launch on another machine blocks no
 * local Orchestrate. Every helper takes `readonly RemoteStarting[] | undefined` and treats an absent array as empty — an older server omits the field — so
 * no caller has to guard.
 */

/** What every surface prints for one entry: `Starting on <label>`, the label being `machineLabelById`'s (Home's label, a remote's name, else the raw id). */
export function startingOnText(view: DashboardsView | null, entry: Pick<RemoteStarting, 'machine'>): string {
  return `Starting on ${machineLabelById(view, entry.machine)}`;
}

/**
 * The `Starting on <machine>` reading for a card, or `null`: the dispatch entry recorded for exactly this item. Keyed by `projectPath` and `id` together, since
 * an id is only unique within a project. An orchestrate entry has no item (`itemId` is `null`) and is the chip's, never a card's.
 */
export function startingOnForItem(
  item: Pick<BacklogItem, 'projectPath' | 'id'>,
  remoteStarting: readonly RemoteStarting[] | undefined,
  view: DashboardsView | null
): string | null {
  const entry = (remoteStarting ?? []).find((e) => e.kind === 'dispatch' && e.project === item.projectPath && e.itemId === item.id);
  return entry === undefined ? null : startingOnText(view, entry);
}

/** The orchestrate launches — the entries the run chip and the Runs Live list draw. A card dispatch is the card's alone: those surfaces list runs. */
export function orchestrateStarting(remoteStarting: readonly RemoteStarting[] | undefined): RemoteStarting[] {
  return (remoteStarting ?? []).filter((e) => e.kind === 'orchestrate');
}
