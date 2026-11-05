import { needsYou, type JiraSessionState } from '../../../shared/jira-sessions';
import type { JiraIssue, JiraLiveSession, JiraSessionsPayload } from '../../../shared/types';
import { JIRA_COLUMNS, cardFold, columnOf, repoBasename, sortTops, type JiraColumnSlug, type JiraFold } from './jira';
import { runLabel, surfaceWord, type SessionLink } from './jira-sessions';
import { pollAge } from './tracker';

/**
 * jira-deck.ts — what the Board view draws from the fold, the filters and the sessions payload: the agent deck above, the status shelves under it (Jira
 * sessions spec §7.1, C8; DESIGN.md §8.9.1). Pure, and the one home of these derivations — `JiraBoardView` memoises the two functions and the components draw
 * what they return, so no component holds a copy of "which tops leave the shelves" or "which card comes first".
 *
 * **The deck is the live sessions on this board, one card each.** A session counts for a board when its key is on that board's LOADED list — a top or anything
 * folded under one — so a ticket two boards both hold shows its card on each of them (the controller's ruling), and a session on a ticket off every loaded
 * list shows on no board (the Sessions page is where it lives). `starting` never comes from `GET /api/jira/sessions`: a reservation has no link until the dashboard
 * answers, so a Starting card is built from the status's `live[key]` entry (`JiraStartingCard`'s and Detail's approach); Lost contact IS in the payload, as the
 * state the server derived.
 *
 * **A top with a live session leaves the shelves** — on itself or on anything folded under it, because the fold's card is the top and the session's card
 * now represents it. That is decided from EVERY live session, before the filters: a filtered-out session's top is filtered out of the shelves by the same
 * filter, so exclusion and filtering are independent and neither can resurrect a row the other removed.
 */

/** The deck's four groups in the order they are drawn (§7.1): the states that want a person, then Working, then Quiet, then Starting and Lost contact. */
export type DeckGroup = 'needs' | 'working' | 'quiet' | 'other';

const GROUP_RANK: Record<DeckGroup, number> = { needs: 0, working: 1, quiet: 2, other: 3 };

export function deckGroup(state: JiraSessionState): DeckGroup {
  if (needsYou(state)) return 'needs';
  if (state === 'working') return 'working';
  if (state === 'quiet') return 'quiet';
  return 'other';
}

/** One card of the deck: a live session, the ticket it runs on, and the top issue that ticket is drawn under. */
export interface DeckEntry {
  /** Stable between polls — the session's id, or the key for a reservation, which has none yet. */
  id: string;
  state: JiraSessionState;
  group: DeckGroup;
  /** The ticket the session runs on — the top itself, or an issue folded under it. */
  issue: JiraIssue;
  /** The top issue `issue` folds into (`issue` itself when it is a top). A card whose `issue` is not its `top` names the top in its crumb. */
  top: JiraIssue;
  /** `null` while the Run is only a reservation (`starting`). */
  link: SessionLink | null;
  /** The reservation's own record when `link` is `null` — it carries the name and repo the card can say. */
  starting: JiraLiveSession | null;
  startedAt: string;
  /** When this server first saw the session in this state — the strip's age. */
  since: string;
}

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The live sessions' order, for the deck AND the List's Live group (§7.2 says the List "sorts like the deck"): group first, then newest start first, then id so
 * two equal instants never swap between polls. Exported rather than copied so the two views cannot drift apart on which session comes first.
 */
export function deckOrder(a: { group: DeckGroup; startedAt: string; id: string }, b: { group: DeckGroup; startedAt: string; id: string }): number {
  return GROUP_RANK[a.group] - GROUP_RANK[b.group] || ms(b.startedAt) - ms(a.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Every live session whose ticket is on the loaded list, ordered for the deck: group first (Needs you, Working, Quiet, Starting/Lost), then newest start
 * first within the group, then by id so two equal instants never swap between polls. An ended link is not live; a reservation whose key is off the list is
 * not this board's.
 */
export function boardAgents(fold: JiraFold, payload: JiraSessionsPayload | null, live: Readonly<Record<string, JiraLiveSession>>): DeckEntry[] {
  const on = new Map<string, { issue: JiraIssue; top: JiraIssue }>();
  for (const top of fold.tops) {
    on.set(top.key, { issue: top, top });
    for (const under of fold.under.get(top.key) ?? []) on.set(under.key, { issue: under, top });
  }
  const out: DeckEntry[] = [];
  for (const link of payload?.links ?? []) {
    const hit = on.get(link.key);
    if (hit === undefined || link.sessionId === null || link.endedAt !== null || link.state === 'ended') continue;
    out.push({
      // The pair, not the session: one session can be linked to several tickets (`/jira link` twice, a branch carrying two keys), and two cards on one
      // board must not share a React key or a sort tiebreak. `starting:<KEY>` below cannot collide with `<KEY>:<id>` — a Jira key is never `starting`.
      id: `${link.key}:${link.sessionId}`,
      state: link.state,
      group: deckGroup(link.state),
      ...hit,
      link,
      starting: null,
      startedAt: link.startedAt,
      since: link.stateSince
    });
  }
  for (const [key, session] of Object.entries(live)) {
    const hit = on.get(key);
    if (hit === undefined || !session.starting) continue;
    out.push({
      id: `starting:${key}`,
      state: 'starting',
      group: 'other',
      ...hit,
      link: null,
      starting: session,
      startedAt: session.startedAt,
      since: session.startedAt
    });
  }
  return out.sort(deckOrder);
}

/**
 * The List's Session cell: per top, the state of the FIRST entry `boardAgents` returned for it. Those entries are already in `deckOrder` (group, newest
 * start, id), so the cell names the session the deck leads that card with and this adds no ordering of its own — a card with `needs you` on a child and
 * `working` on itself reads `needs you` in both places. A top with no live session has no key.
 */
export function topSessionState(agents: readonly DeckEntry[]): Map<string, JiraSessionState> {
  const out = new Map<string, JiraSessionState>();
  for (const e of agents) if (!out.has(e.top.key)) out.set(e.top.key, e.state);
  return out;
}

/** The word beside the dot in the List's Session cell. `ended` is never reached — `boardAgents` drops ended links — and reads as nothing if it were. */
export function issueCellWord(state: JiraSessionState): string {
  if (needsYou(state)) return 'needs you';
  if (state === 'working') return 'working';
  if (state === 'quiet') return 'quiet';
  if (state === 'lost') return 'lost contact';
  if (state === 'starting') return 'starting';
  return '';
}

/** The header's tally: how many cards want a person and how many are working — the two numbers a glance at the deck is for. */
export function deckTally(entries: readonly DeckEntry[]): { needs: number; working: number } {
  return { needs: entries.filter((e) => e.group === 'needs').length, working: entries.filter((e) => e.group === 'working').length };
}

/**
 * The crumb on a deck card (§7.1): `run · repo · surface · model`, ellipsised on the right of the head. A session on a ticket folded under a top leads with
 * `↳ <top key>` — the card shows the session's own key, and this is what says which card of the board it hangs under. A reservation knows only its name and
 * repo, so the surface and the model are absent rather than guessed.
 */
export function deckCrumb(entry: DeckEntry, skills: readonly { id: string; name: string }[]): string {
  const parts: (string | null)[] = [entry.issue.key === entry.top.key ? null : `↳ ${entry.top.key}`];
  const { link, starting } = entry;
  if (link !== null) {
    const row = link.row;
    const model = [row?.model ?? link.model, row?.effort ?? link.effort].find((p) => p !== null && p !== undefined && p !== '');
    parts.push(runLabel(link, skills), repoBasename(link.repo), surfaceWord(link, row), model ?? null);
  } else if (starting !== null) {
    parts.push(starting.name, repoBasename(starting.repo));
  }
  return parts.filter((p): p is string => p !== null && p !== '').join(' · ');
}

/** C8: a shelf's first rows before `+ N more`. Done is collapsed harder — it is the shelf nobody is waiting on. */
export const SHELF_LIMIT: Readonly<Record<JiraColumnSlug, number>> = { todo: 8, doing: 8, done: 3 };

/** One row of a shelf: a top issue and what its card says about it, plus the ticket's ended sessions (newest first) for the extra line. */
export interface ShelfCard {
  issue: JiraIssue;
  fold: ReturnType<typeof cardFold>;
  matches: string[];
  ended: SessionLink[];
}

export interface Shelf {
  slug: JiraColumnSlug;
  label: string;
  /** Every row the shelf holds — the count pill's number; the cut is `SHELF_LIMIT`'s, made by the component so a shelf can be opened. */
  cards: ShelfCard[];
}

/**
 * The three shelves: the tops the filters show (`shown`, `foldMatches`' answer), minus every top that has a live session (`agents`, UNFILTERED — see the
 * header), each in its own status category and ordered by `sortTops`. `ended` is each row's OWN ticket's ended sessions, newest end first — a folded issue's
 * history is in its own Detail, as its worktree is.
 */
export function boardShelves(fold: JiraFold, shown: ReadonlyMap<string, string[]>, agents: readonly DeckEntry[], payload: JiraSessionsPayload | null): Shelf[] {
  const away = new Set(agents.map((e) => e.top.key));
  const endedBy = new Map<string, SessionLink[]>();
  for (const link of payload?.links ?? []) {
    if (link.endedAt === null) continue;
    const list = endedBy.get(link.key);
    if (list === undefined) endedBy.set(link.key, [link]);
    else list.push(link);
  }
  for (const list of endedBy.values()) list.sort((a, b) => ms(b.endedAt ?? '') - ms(a.endedAt ?? ''));
  const kept = fold.tops.filter((i) => shown.has(i.key) && !away.has(i.key));
  return JIRA_COLUMNS.map((col) => ({
    slug: col.slug,
    label: col.label,
    cards: sortTops(
      kept.filter((i) => columnOf(i) === col.slug),
      fold.under
    ).map((issue) => ({ issue, fold: cardFold(issue.key, fold), matches: shown.get(issue.key) ?? [], ended: endedBy.get(issue.key) ?? [] }))
  }));
}

/**
 * A shelf row's extra line (§7.1): the newest ended session as `run ended <age> ago` (spec §7.1 — whatever the link's `how`, the row says `run`) with the session to Reopen, or `N sessions` when the ticket has been
 * worked more than once — the row does not pick one of several to reopen, Detail's history lists them all. `null` for a ticket that has never had one.
 */
export function endedLine(ended: readonly SessionLink[], now: number): { text: string; reopen: SessionLink | null } | null {
  if (ended.length === 0) return null;
  if (ended.length > 1) return { text: `${ended.length} sessions`, reopen: null };
  const [only] = ended;
  const age = pollAge(only.endedAt, now);
  return { text: age === null ? 'run ended' : `run ended ${age} ago`, reopen: only.sessionId === null ? null : only };
}
