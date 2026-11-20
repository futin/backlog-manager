import { needsYou, type JiraSessionState } from '../../../shared/jira-sessions';
import type { JiraIssue, JiraLiveSession, JiraParentRef, JiraSessionsPayload, JiraSkillGroup } from '../../../shared/types';
import { repoBasename, type JiraLanes } from './jira';
import { runLabel, surfaceWord, type SessionLink } from './jira-sessions';
import { pollAge } from './tracker';

/**
 * jira-deck.ts — what the Board view draws from the lanes and the sessions payload: the agent deck above the lanes, and each lane card's session
 * reading (Jira sessions spec §7.1; parent-lanes spec §3.4; DESIGN.md §8.9.1). Pure, and the one home of these derivations — `JiraBoardView` memoises them
 * and the components draw what they return, so no component holds a copy of "which session a card leads with" or "which card comes first".
 *
 * **The deck is the live sessions on this board, one card each.** A session counts for a board when its key is on that board's LOADED list — at any lane
 * depth, a parent's own card as much as a child's — so a ticket two boards both hold shows its card on each of them (the controller's ruling), and a session
 * on a ticket off every loaded list shows on no board (the Sessions page is where it lives). `starting` never comes from `GET /api/jira/sessions`: a
 * reservation has no link until the dashboard answers, so a Starting card is built from the status's `live[key]` entry (`JiraStartingCard`'s and Detail's
 * approach); Lost contact IS in the payload, as the state the server derived.
 *
 * **A card with a live session stays in its lane** (parent-lanes spec §3.4). The status shelves this file used to cut — a top with a live session left
 * them for its deck card — are gone: the lane card keeps its place, says the session's state on its own state line, and the deck still lists it, so the
 * two are two views of one session rather than one card moved between them.
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

/** One card of the deck: a live session, the ticket it runs on, and the parent that ticket's lane names. */
export interface DeckEntry {
  /** Stable between polls — the session's id, or the key for a reservation, which has none yet. */
  id: string;
  state: JiraSessionState;
  group: DeckGroup;
  /** The ticket the session runs on — any issue on the loaded list, at any lane depth. */
  issue: JiraIssue;
  /**
   * `issue`'s DIRECT parent as the lanes keep it (`JiraLanes.parentOf`, parent-lanes spec §5) — on the board or off it, since an off-board parent still heads
   * a lane — and `null` for an issue with no parent or a cycle member, whose link the walk drops. A card with one names it as `↳ <KEY>`; the topmost ancestor
   * is not named, because the lane the card sits in is the direct parent's.
   */
  parent: JiraParentRef | null;
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
 *
 * `parentOf` is the same input's `laneBoard(issues).parentOf` — the caller already holds the lanes, and taking the walk's answer rather than reading
 * `issue.parent` here is what keeps a cycle member's card from naming a parent the lanes did not draw it under.
 */
export function boardAgents(
  issues: readonly JiraIssue[],
  parentOf: JiraLanes['parentOf'],
  payload: JiraSessionsPayload | null,
  live: Readonly<Record<string, JiraLiveSession>>
): DeckEntry[] {
  const on = new Map(issues.map((issue) => [issue.key, { issue, parent: parentOf.get(issue.key) ?? null }] as const));
  return liveEntries(on, payload, live);
}

/**
 * The one reading of "which sessions are live on these tickets", shared by the deck (`boardAgents`, over a board's loaded list) and Detail (`childSessions`,
 * over a ticket's Children tree), so the two can never disagree on what counts as live: a linked session that has not ended, or a `starting` reservation from
 * the status. `on` maps each ticket key to the issue and the parent its card names; a key not in it is not this caller's. Sorted in `deckOrder`.
 */
function liveEntries(
  on: ReadonlyMap<string, { issue: JiraIssue; parent: JiraParentRef | null }>,
  payload: JiraSessionsPayload | null,
  live: Readonly<Record<string, JiraLiveSession>>
): DeckEntry[] {
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
 * Detail's reading of the sessions under a ticket (DESIGN.md §8.9.2): for each of `issues` — the Children tree's rows, at any depth — that has a live
 * session, the one the deck would lead that ticket with, in `deckOrder`. One entry per issue, not per session: a Children row wears one state pill, and the
 * Agent pane's `on a child` line names the first entry and counts the rest. Each entry's `parent` is `null` — the tree already places the row under its
 * parent, and nothing here draws a `↳` crumb.
 */
export function childSessions(
  issues: readonly JiraIssue[],
  payload: JiraSessionsPayload | null,
  live: Readonly<Record<string, JiraLiveSession>>
): DeckEntry[] {
  const on = new Map(issues.map((issue) => [issue.key, { issue, parent: null }] as const));
  const seen = new Set<string>();
  return liveEntries(on, payload, live).filter((e) => !seen.has(e.issue.key) && (seen.add(e.issue.key), true));
}

/** The header's tally: how many cards want a person and how many are working — the two numbers a glance at the deck is for. */
export function deckTally(entries: readonly DeckEntry[]): { needs: number; working: number } {
  return { needs: entries.filter((e) => e.group === 'needs').length, working: entries.filter((e) => e.group === 'working').length };
}

/**
 * The crumb on a deck card (§7.1): `run · repo · surface · model`, ellipsised on the right of the head. A session on a ticket with a parent leads with
 * `↳ <parent key>` (parent-lanes spec §5) — the card shows the session's own key, and this is what says which lane of the board it sits in, on the board
 * or off it. A reservation knows only its name and repo, so the surface and the model are absent rather than guessed.
 */
export function deckCrumb(entry: DeckEntry, skills: readonly { id: string; name: string; group: JiraSkillGroup }[], opts: { lead?: boolean } = {}): string {
  // `lead: false` leaves the `↳ parent` out: the deck card draws it as a pill beside the key and keeps the crumb to the run's own words.
  const parts: (string | null)[] = [opts.lead === false || entry.parent === null ? null : `↳ ${entry.parent.key}`];
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

/** One lane card's session reading (`sessionCells`): the state line's words and age, the `+N` beside it, and the deck entry `SessionOpen` opens. */
export interface SessionCell {
  state: JiraSessionState;
  since: string;
  /** How many OTHER live sessions run on this same ticket — the state line's `+N`. Always 0 for an ended cell. */
  more: number;
  /** The live entry the card leads with — `null` for an ended cell, which draws no state line (its ended line says it). */
  lead: DeckEntry | null;
}

/**
 * Per ticket, the session its lane card leads with (parent-lanes spec §3.4). Keyed by the session's OWN issue key — a card is one ticket now, not a top
 * standing for its subtree, so a session on a child gives the parent's card nothing (the child's own card carries it). The first live entry for a key
 * leads: `agents` is `boardAgents`' answer, already in `deckOrder`, so this adds no ordering of its own and the card agrees with the deck. A key with none
 * live and an ended link reads `ended`, `since` the newest `endedAt`. A key with neither has no entry.
 */
export function sessionCells(agents: readonly DeckEntry[], links: readonly SessionLink[]): Map<string, SessionCell> {
  const out = new Map<string, SessionCell>();
  for (const e of agents) {
    const cur = out.get(e.issue.key);
    if (cur !== undefined) cur.more += 1;
    else out.set(e.issue.key, { state: e.state, since: e.since, more: 0, lead: e });
  }
  for (const l of links) {
    if (l.endedAt === null) continue;
    const cur = out.get(l.key);
    if (cur === undefined) out.set(l.key, { state: 'ended', since: l.endedAt, more: 0, lead: null });
    else if (cur.lead === null && ms(l.endedAt) > ms(cur.since)) cur.since = l.endedAt;
  }
  return out;
}

/**
 * Each ticket's ended sessions, newest end first — the card's and the on-board header's extra line (`endedLine`). Only the ticket's OWN links: a child's
 * history is in its own card and its own Detail, as its worktree is.
 */
export function endedByKey(payload: JiraSessionsPayload | null): Map<string, SessionLink[]> {
  const out = new Map<string, SessionLink[]>();
  for (const link of payload?.links ?? []) {
    if (link.endedAt === null) continue;
    const list = out.get(link.key);
    if (list === undefined) out.set(link.key, [link]);
    else list.push(link);
  }
  for (const list of out.values()) list.sort((a, b) => ms(b.endedAt ?? '') - ms(a.endedAt ?? ''));
  return out;
}

/**
 * A card's extra line (§7.1): the newest ended session as `run ended <age> ago` (spec §7.1 — whatever the link's `how`, the row says `run`) with the session
 * to Reopen, or `N sessions` when the ticket has been worked more than once — the row does not pick one of several to reopen, Detail's history lists them all.
 * `null` for a ticket that has never had one.
 */
export function endedLine(ended: readonly SessionLink[], now: number): { text: string; reopen: SessionLink | null } | null {
  if (ended.length === 0) return null;
  if (ended.length > 1) return { text: `${ended.length} sessions`, reopen: null };
  const [only] = ended;
  const age = pollAge(only.endedAt, now);
  return { text: age === null ? 'run ended' : `run ended ${age} ago`, reopen: only.sessionId === null ? null : only };
}
