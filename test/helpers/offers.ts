/**
 * offers.ts — `ProjectOffers` fixtures for the suites that render a launch sheet over a picker (`launch-sheet`, `orchestrator-start-ui`). One home so the
 * two sheets are tested against the same machines.
 *
 * Every date is cut from `Date.now()` AT CALL TIME and never written as a literal: the 5 h reset on a card is `now`-relative, so an absolute stamp would
 * expire the day its assertion starts reading it as "resets now" (CLAUDE.md: a fixture date is relative to the clock the assertion runs under).
 */
import type { MachineOffer, ProjectOffers } from '../../shared/types';

function usage(fiveHour: number, week: number): NonNullable<MachineOffer['usage']> {
  const now = Date.now();
  return {
    fiveHour: { pct: fiveHour, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
    week: { pct: week, resetsAt: new Date(now + 3 * 86_400_000).toISOString() },
    projection: 'safe',
    exhaustAt: null,
    fetchedAt: new Date(now - 40_000).toISOString()
  };
}

export function homeOffer(patch: Partial<MachineOffer> = {}): MachineOffer {
  return {
    machine: 'home',
    label: 'Home',
    home: true,
    account: null,
    offered: true,
    reason: null,
    usage: usage(28, 9),
    usageAgeMs: 12_000,
    // Home's own offer carries lists too, and `lockedFor` ignores them — a home sheet is never narrowed.
    models: ['opus', 'sonnet', 'haiku', 'fable'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    ...patch
  };
}

export function proOffer(patch: Partial<MachineOffer> = {}): MachineOffer {
  return {
    machine: 'Pro',
    label: 'Pro',
    home: false,
    account: 'Max 20x',
    offered: true,
    reason: null,
    usage: usage(12, 5),
    usageAgeMs: 40_000,
    models: ['opus', 'sonnet'],
    efforts: ['low', 'high'],
    ...patch
  };
}

/** Home alone — what the server answers for a files project or a setup with no remote, so no picker draws. */
export function homeOnly(project = '/abs/alpha'): ProjectOffers {
  return { project, machines: [homeOffer()], suggestion: null };
}

/** Home and Pro, Pro suggested (and so selected when the sheet opens). */
export function proSuggested(project = '/abs/alpha'): ProjectOffers {
  return {
    project,
    machines: [homeOffer(), proOffer()],
    suggestion: { machine: 'Pro', reason: 'Prefer order: Pro comes first under 80% on both windows', basis: 'usage' }
  };
}
