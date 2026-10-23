import type { MachineUsage, Suggestion, SuggestStrategy } from '../../../../shared/types';

/**
 * The machine a launch surface pre-selects (spec 2026-10-22-multi-dashboard-design.md, "The suggestion rule"). Pure: the candidates are the OFFERED machines only
 * (an unreachable or not-registered one never reaches it), each with the usage the usage reader returned — already `null` when the figures were missing, signed
 * out, or older than the freshness limit, so staleness is decided once, there, and never here.
 *
 * A machine WITHOUT usage is never picked on usage while another has some: guessing from nothing would dress a default up as a measurement (the spec's anti-goal),
 * so it only ever wins as the default, and that is labelled `basis: 'default'` — the card says "No usage figures", not "Most headroom".
 *
 * `order` is the prefer order, machine ids; it is the tie-break for every strategy, so two machines the figures cannot separate are separated by the person's own
 * ranking and never by array position. An id missing from it sorts last and keeps candidate order among its peers.
 */

export interface SuggestCandidate {
  machine: string;
  label: string;
  usage: MachineUsage | null;
}

export interface SuggestInput {
  candidates: SuggestCandidate[];
  order: string[];
  strategy: SuggestStrategy;
  threshold: number;
  homeOffered: boolean;
}

/** *Used* is the higher of the two windows — the one that will stop work first — and headroom is 100 minus it. */
const usedOf = (u: MachineUsage): number => Math.max(u.fiveHour.pct, u.week.pct);

export function suggest(input: SuggestInput): Suggestion | null {
  const { strategy, threshold } = input;
  const rank = (id: string): number => {
    const i = input.order.indexOf(id);
    return i === -1 ? input.order.length : i;
  };
  // Array.prototype.sort is stable, so ids absent from `order` keep the order the caller listed them in.
  const ordered = [...input.candidates].sort((a, b) => rank(a.machine) - rank(b.machine));
  if (ordered.length === 0) return null;

  const withUsage = ordered.filter((c): c is SuggestCandidate & { usage: MachineUsage } => c.usage !== null);
  if (withUsage.length === 0) {
    const home = input.homeOffered ? ordered.find((c) => c.machine === 'home') : undefined;
    const pick = home ?? ordered[0];
    return { machine: pick.machine, reason: `No usage figures — ${pick.label} by default`, basis: 'default' };
  }

  // First strictly-lowest used figure: reduce keeps the earlier one on a tie, and `withUsage` is already in prefer order.
  const mostHeadroom = (): SuggestCandidate & { usage: MachineUsage } => withUsage.reduce((best, c) => (usedOf(c.usage) < usedOf(best.usage) ? c : best));
  const usage = (machine: string, reason: string): Suggestion => ({ machine, reason, basis: 'usage' });

  if (strategy === 'headroom') {
    const best = mostHeadroom();
    return usage(best.machine, `Most headroom: ${best.label} at ${Math.round(usedOf(best.usage))}% used`);
  }

  if (strategy === 'runway') {
    const safe = withUsage.find((c) => c.usage.projection === 'safe');
    if (safe) return usage(safe.machine, `Least likely to run out: ${safe.label} lasts past its weekly reset`);
    // None safe: a projection that says "runs out" still outranks "unknown" (the spec ranks unknown after every machine that has one), then prefer order.
    const pick = withUsage.find((c) => c.usage.projection === 'runs-out') ?? withUsage[0];
    return usage(pick.machine, `Least likely to run out: no machine is projected safe — ${pick.label} by prefer order`);
  }

  const under = withUsage.find((c) => c.usage.fiveHour.pct < threshold && c.usage.week.pct < threshold);
  if (under) return usage(under.machine, `Prefer order: ${under.label} comes first under ${threshold}% on both windows`);
  const best = mostHeadroom();
  return usage(best.machine, `Prefer order: none under ${threshold}% — ${best.label} has the most headroom`);
}
