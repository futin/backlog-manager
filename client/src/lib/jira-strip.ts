import { deliveryLook, targetRowId, type DeliveryTarget, type DeliveryTone } from './delivery';
import { repoBasename } from './jira';
import type { SessionLink } from './jira-sessions';
import { pollAge } from './tracker';
import { needsYou, STATE_LABEL, type JiraSessionState } from '../../../shared/jira-sessions';
import type { JiraLiveSession } from '../../../shared/types';

/**
 * The Detail body's summary strip, as data (Jira detail tabs spec §1.2; DESIGN.md §8.9.2). The strip is the anti-goal's answer — "a tab that hides an alarm"
 * — so what it says about delivery and about the agent must be the same on every tab and in both frames, and that is easiest to hold when the choice of
 * which pills to draw, in which order and with which words, is one pure function per cell rather than a reading spread through a component. Pure and
 * clock-free except where a caller hands `now` in; every word and tone still comes from where it always did (`deliveryLook`, `STATE_LABEL`, `pollAge`).
 */

/** One Delivery pill: `key` is the target's row id in the Delivery tab (`<project>\u0000<target>`), which a click opens. */
export interface StripPill {
  key: string;
  label: string;
  tone: DeliveryTone;
}

/** The strip draws at most this many target pills; the rest fold into one `+N`. */
const MAX_PILLS = 3;

/** Worst first: a failing pipeline (red), then work to do (amber), then everything else, which keeps `leadOrder` among itself. */
function toneRank(tone: DeliveryTone): number {
  return tone === 'red' ? 0 : tone === 'amber' ? 1 : 2;
}

/**
 * The Delivery cell's pills (spec §1.2): one per target, `<target> · <word>` in `deliveryLook`'s word and tone — the card's and the List's reading of the
 * same MR, so the strip cannot call a pipeline something they do not — led by the repo basename (`pay-api → develop · …`, the Delivery pane's own
 * `<repo> → <target>` shape) only when the targets span more than one project, since one project's name on every pill says nothing.
 *
 * Ordered worst tone first — red, amber, then the rest in the order `deliveryTargets` gave them (`leadOrder`) — because the strip shows at most three, and a
 * red target folded behind a green one would be the alarm the strip exists not to hide. `Array.prototype.sort` is stable, so equal ranks keep `leadOrder`.
 * Past three, `more` counts the folded targets and wears the tone of the first of them in this same order: the worst thing folded, which is what a reader
 * deciding whether to open the tab needs to see.
 */
export function stripDelivery(
  targets: readonly DeliveryTarget[],
  multiProject: boolean,
  now: number
): { pills: StripPill[]; more: { count: number; tone: DeliveryTone } | null } {
  const all = targets
    .map((t): StripPill => {
      const where = multiProject ? `${repoBasename(t.project)} → ${t.target}` : t.target;
      const look = deliveryLook(t.lead, now);
      return { key: targetRowId(t), label: `${where} · ${look.word}`, tone: look.tone };
    })
    .sort((a, b) => toneRank(a.tone) - toneRank(b.tone));
  const folded = all.slice(MAX_PILLS);
  return { pills: all.slice(0, MAX_PILLS), more: folded.length === 0 ? null : { count: folded.length, tone: folded[0].tone } };
}

/** The Agent cell's lead live session: its state (for the dot's tone) and the pill's text, `<STATE_LABEL[state]> · <age>`. */
export interface StripAgentLead {
  state: JiraSessionState;
  text: string;
}

export type StripAgent = { lead: StripAgentLead; more: number } | { idle: string };

/** Attention order (spec §1.2): a session waiting on the reader, then one working, then a `starting` reservation, then any other live state. */
function attentionRank(state: JiraSessionState): number {
  if (needsYou(state)) return 0;
  if (state === 'working') return 1;
  if (state === 'starting') return 2;
  return 3;
}

/**
 * The Agent cell (spec §1.2): the LEAD live session as one pill, then `+N` for the others; with none live, `idle · N ended`, or `no sessions` on a ticket
 * that never had one.
 *
 * The live rows are the ones the agent band reads today: the sessions payload's live links for the key, plus the shell's `starting` reservation, which the
 * payload never carries (`JiraDetail`'s header). The lead is the session that most wants the reader — any of the four waiting states (`needsYou`: the
 * dashboard's `question` and the three remote waits) before `working` before `starting` before the rest — and the newest start within a state, so a session
 * waiting on an answer is never hidden behind a newer working one. Its age is the session card's `LiveStrip` reading: `pollAge` of the link's `stateSince`
 * (how long THIS server has seen it in that state), or of the reservation's `startedAt`, which is all a reservation has.
 */
export function stripAgent(live: { links: readonly SessionLink[]; starting: JiraLiveSession | null }, ended: number, now: number): StripAgent {
  const rows: { state: JiraSessionState; since: string; startedAt: string }[] = [
    ...(live.starting === null ? [] : [{ state: 'starting' as const, since: live.starting.startedAt, startedAt: live.starting.startedAt }]),
    ...live.links.map((l) => ({ state: l.state, since: l.stateSince, startedAt: l.startedAt }))
  ];
  if (rows.length === 0) return { idle: ended > 0 ? `idle · ${ended} ended` : 'no sessions' };
  const at = (iso: string): number => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
  };
  const [lead] = [...rows].sort((a, b) => attentionRank(a.state) - attentionRank(b.state) || at(b.startedAt) - at(a.startedAt));
  const age = pollAge(lead.since, now);
  return { lead: { state: lead.state, text: age === null ? STATE_LABEL[lead.state] : `${STATE_LABEL[lead.state]} · ${age}` }, more: rows.length - 1 };
}
