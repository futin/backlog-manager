import { needsYouCount, openPrCount } from './pr-layouts';
import type { Section } from './sections';
import type { PullRequestsPayload } from '../../../shared/types';

/**
 * The rail's pending counts — `.claude/DESIGN.md` §8.0 "The counts", `docs/superpowers/specs/2026-11-16-rail-pending-counts-design.md`.
 *
 * Each sub-page row in a rail tree may carry a live count of what waits on that page — never a "since you last looked" number — and the section's top row
 * draws the sum, so a closed tree still says something waits inside. This module is the one home of which page carries which number, its tone and its exact
 * accessible name; `SideRail` only draws what it returns. Adding a count to another page is one more entry here, with no rail markup to touch.
 *
 * It is pure, so every number, tone and label is pinned without rendering a rail (`test/ui/rail-counts-lib.test.ts`). For the same reason `onOpen` is an
 * INPUT, never built here: the Jira pill's click writes the Jira page and list-filter stores and closes the phone menu, all state the rail owns, and a
 * handler built here would have to import those stores and stop being pure.
 */

/** `warn` (amber) when the count includes something waiting on the reader; `neutral` (grey) when it is only a quantity. */
export type RailTone = 'warn' | 'neutral';

export interface RailCount {
  n: number;
  tone: RailTone;
  /** The full accessible name, in words — the pill draws only `n`, so this is what a screen reader hears and a hover shows. */
  label: string;
  /** Present only for a count whose pill is a real button (Jira › Sessions and Mentions); without it the pill lets a click through to its row. */
  onOpen?: () => void;
}

/** One section's entries, keyed by that section's own page key (`prs`, `runs`, `sessions`). Absent key = nothing pending on that page. */
export type RailSectionCounts = Partial<Record<string, RailCount>>;
export type RailCounts = Partial<Record<Section, RailSectionCounts>>;

export interface RailCountsInput {
  /** The shell's one PRs answer (`PullRequestsContext`); `null` before it lands, while no GitHub project is registered, or with no token. */
  prs: PullRequestsPayload | null;
  /** `liveRunCount` — running and paused runs, local and remote, machine-wide whatever the History page's filters say. */
  liveRuns: number;
  /** `useJiraNeedsYou` — sessions that need the reader across every linked ticket, holding its last value while the dashboard is unreachable. */
  jiraNeedsYou: number;
  /** What the Jira Sessions pill's click does; supplied by `SideRail`, which owns the stores it writes. */
  openJiraNeedsYou?: () => void;
  /** Tickets holding a mention that still waits on the reader (`status.mentions.count`, null before the first check read as 0). Not sessions: a ticket counts once. */
  jiraMentions: number;
  /** What the Jira Mentions pill's click does; supplied by `SideRail`, for the reason `openJiraNeedsYou` is. */
  openJiraMentions?: () => void;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Every non-zero count, by section and page. A zero draws no pill, so it gets no entry, and a section with no entry is absent. */
export function railCounts(input: RailCountsInput): RailCounts {
  const out: RailCounts = {};
  const open = openPrCount(input.prs);
  if (open > 0) {
    // The number widened from needs-you to every open PR (the user wants "how many open PRs do I have"), so the tone carries the old signal: amber while any
    // of them needs the reader, and the name says how many.
    const needs = needsYouCount(input.prs);
    const base = plural(open, 'open PR', 'open PRs');
    out.github = {
      prs: { n: open, tone: needs > 0 ? 'warn' : 'neutral', label: needs > 0 ? `${base}, ${needs} ${needs === 1 ? 'needs' : 'need'} you` : base }
    };
  }
  if (input.liveRuns > 0) out.runs = { runs: { n: input.liveRuns, tone: 'neutral', label: plural(input.liveRuns, 'live run', 'live runs') } };
  if (input.jiraNeedsYou > 0) {
    const n = input.jiraNeedsYou;
    const sessions: RailCount = { n, tone: 'warn', label: n === 1 ? '1 session needs you' : `${n} sessions need you` };
    if (input.openJiraNeedsYou) sessions.onOpen = input.openJiraNeedsYou;
    out.jira = { sessions };
  }
  if (input.jiraMentions > 0) {
    const n = input.jiraMentions;
    const mentions: RailCount = { n, tone: 'warn', label: n === 1 ? '1 ticket mentions you' : `${n} tickets mention you` };
    if (input.openJiraMentions) mentions.onOpen = input.openJiraMentions;
    out.jira = { ...out.jira, mentions };
  }
  return out;
}

/**
 * The top row's pill: the sum of the section's entries, amber if any entry is, named by the entries' labels in tree order joined by `; `. `order` is the
 * tree's page list, and an entry for a page not in it is ignored — the top row never counts a page the tree does not draw. The open handler carries over
 * only when exactly one entry is present: with two, a click on the sum could mean either page, so the pill stays plain and the click reaches the row.
 * `null` when nothing is pending.
 */
export function sectionTotal(entries: RailSectionCounts | undefined, order: readonly string[]): RailCount | null {
  if (!entries) return null;
  const present = order.map((k) => entries[k]).filter((e): e is RailCount => e !== undefined && e.n > 0);
  if (present.length === 0) return null;
  const total: RailCount = {
    n: present.reduce((s, e) => s + e.n, 0),
    tone: present.some((e) => e.tone === 'warn') ? 'warn' : 'neutral',
    label: present.map((e) => e.label).join('; ')
  };
  if (present.length === 1 && present[0].onOpen) total.onOpen = present[0].onOpen;
  return total;
}
