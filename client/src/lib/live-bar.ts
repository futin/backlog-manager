/**
 * The card's live band, and its one home: which bar a card wears (`liveBarFor`), the queued strip that paints in the same band when no bar does
 * (`queuedStripFor`), and the classification both the bar and the column rank read (`liveKind`).
 *
 * It left ItemCard.tsx in #376 for two reasons. A derivation inside a component can only be pinned through a render. And `liveRank` (lib/board-sort.ts)
 * restated `liveBarFor`'s stage checks by hand, under a doc comment claiming the two drew the same set of cards — untrue since #227 drew a bar for a stale
 * claim that ranks 2. Both read `liveKind` now, so they cannot disagree about which kind a card is, only about what each kind means to them.
 *
 * Pure by construction — no React, nothing from `components/` or `hooks/`.
 */
import { elapsedSince } from './item-age';
import { isInProgress, progressLabel } from './item-progress';
import { ACTIVE_RUN_STAGES } from './run-stage';
import { claimReading } from './tracker';
import { ATTENTION_RUN_STAGES } from '../../../shared/types';
import type { BacklogItem, RunQueueItem, RunStage } from '../../../shared/types';

/*
 * `ATTENTION_RUN_STAGES` — the two stages that mean the run has STOPPED and
 * will not restart until a person does something — used to be declared in
 * ItemCard.tsx, as the exact opposite claim to `ACTIVE_RUN_STAGES`' six. bug-11 moved it to
 * shared/types.ts beside `RUN_CLAIMED_STAGES`, where its own doc comment now
 * gives the reasoning; `client/src/lib/item-stale.ts` reads it to keep an
 * item a run is blocked on out of Archive, and a lib module cannot import a
 * React component.
 *
 * The card's use of it (now through `liveKind` below) is unchanged; the rendering rule it used to encode is
 * not. The two lists chose the live strip's COLOUR until task-37 — amber for a
 * blocked run, cyan for a running one — and DESIGN.md §8.3 takes that second
 * tone away: one `--fill-live` hatched fill covers both, and the stage word
 * alone carries the distinction, because this design marks state by ink and
 * never by accent (§5). What the two lists still decide is whether there is a
 * strip at all, and which word is on it.
 */

/**
 * What this card needs from a fresh run's queue entry: the stage, and the
 * first-arrival stamps to age it against. A narrow pick rather than the whole
 * `RunQueueItem` because everything else on that shape (sessionId, worktree,
 * verification output, questions) belongs to the Runs section's detail, and a
 * card that accepted it would invite reading fields the card has no room to
 * render.
 */
export type RunCardState = Pick<RunQueueItem, 'stage' | 'stageAt'>;

/** The bar's three volatile facts, in a shape a test can assert directly. */
export type LiveBar = {
  /** The word(s) the bar prints: a run stage, or `progressLabel`'s wording. */
  label: string;
  /**
   * `run` → the orchestrator is working it, unattended; `human` → a person is
   * involved, either because a hand session holds the file or because the run
   * has stopped and is waiting on one.
   *
   * It no longer picks a fill: DESIGN.md §8.3 draws one `--fill-live` strip for
   * both. It is kept because it is the precedence's own verdict in a shape a
   * test can read without a render, and because the card still marks the two
   * apart in its markup (`data-tone`) for anything that needs to tell them
   * apart without re-deriving the two stage lists.
   *
   * `stale` (#227) is the one tone the stylesheet DOES read: a tracker claim whose heartbeat is past `CLAIM_STALE_MS`. It is not a third kind of worker but
   * the absence of one, so it drops the hatch and wears the stale queued band's muted ink — the amber `executing` strip on a card nobody has touched for
   * a day is the lie #227 was filed against.
   */
  tone: 'run' | 'human' | 'stale';
  /** The stamp to age against, or null when nothing here can be aged. */
  anchor: string | null;
  /** The bar's title attribute — the one place the exact stamp is legible. */
  title: string;
};

/**
 * What kind of live work a card shows, or `null` for none — the one classification `liveBarFor` and `liveRank` (lib/board-sort.ts) both read, checked in
 * this order:
 *
 *   `attention` — a fresh run is BLOCKED on a person (`ATTENTION_RUN_STAGES`);
 *   `run`       — a fresh run is working it (`ACTIVE_RUN_STAGES`);
 *   `stale`     — a tracker claim whose heartbeat is past `CLAIM_STALE_MS` by `now` (#227): drawn, so a person sees it, but nobody is working it;
 *   `hand`      — a hand session has stamped `started:` on an open item (`isInProgress`);
 *   `null`      — none of those.
 *
 * `now === null` skips the stale rung, so a stale claim reads `hand`: the UNAGED reading the board's clock gate needs (`liveRank`'s own comment says why).
 * The stale rung also checks `holder`, which `claimReading` already implies — restated so `liveBarFor`'s read of `item.holder` need not trust that.
 */
export function liveKind(item: BacklogItem, stage: RunStage | undefined, now: number | null): 'attention' | 'run' | 'stale' | 'hand' | null {
  if (stage !== undefined && ATTENTION_RUN_STAGES.includes(stage)) return 'attention';
  if (stage !== undefined && ACTIVE_RUN_STAGES.includes(stage)) return 'run';
  if (now !== null && claimReading(item, now) === 'stale' && item.holder !== undefined) return 'stale';
  if (isInProgress(item)) return 'hand';
  return null;
}

/**
 * Which bar a card wears, or null for none. Exported and pure so the
 * precedence below is testable without a render, and so the ordering is
 * stated once in one place rather than as nested ternaries in JSX.
 *
 * The precedence, top wins — `liveKind` above decides it, and this function only words each kind:
 *   1. an attention stage    → human, labelled with the stage
 *   2. an active stage       → run, labelled with the stage
 *   3. a stale tracker claim → stale, labelled with the heartbeat's age (#227)
 *   4. `isInProgress(item)`  → human, labelled by `progressLabel` (unchanged)
 *   5. none of those         → no bar
 *
 * Run facts outrank the file's own marker (1–2 over 3) because the run payload
 * is re-polled every 5s while it is fresh, where a `started:` stamp can be
 * arbitrarily stale — a leftover hand-run stamp must not mask a live run's
 * actual stage. In practice the two rarely co-occur at all: `backlog-execute`
 * runs inside the per-item worktree and stamps the worktree's copy of the item
 * file, never the main tree's copy this board renders (task-9's own Goal
 * section has the full finding), which is exactly why a run's stage is the
 * ONLY thing that can say an orchestrated item is live.
 *
 * The two stage lists and the hand session's own words are deliberately NOT
 * merged into one list, and DESIGN.md §8.3 says so outright: `reviewing` is a
 * `RunStage` (shared/types.ts) and `grooming`/`executing`/`in progress` are
 * `progressLabel`'s own three (`client/src/lib/item-progress.ts:39-43`), off a
 * `phase:` key. They are two axes that happen to print in the same 24 px strip.
 *
 * The anchor prefers `stageAt.dispatched` over the current stage's own
 * arrival, and that is not a fallback ordering — it is the reading. `stageAt`
 * keeps FIRST arrivals only (shared/types.ts), so a `fixing` → `reviewing`
 * loop does not re-stamp either one; anchoring on the current stage would
 * still under-report a long item as "2m in reviewing" rather than "40m in the
 * orchestrator's hands", which is the analogue of `started:` and the thing a
 * reader scanning a column actually wants. `needs-answers` needs the fallback
 * because its route (pending → preflight → needs-answers) never visits
 * `dispatched` at all, and there the current stage's arrival IS the right
 * reading: how long it has been waiting on you.
 */
export function liveBarFor(item: BacklogItem, run: RunCardState | undefined, now: number): LiveBar | null {
  const stage = run?.stage;
  const kind = liveKind(item, stage, now);
  if ((kind === 'attention' || kind === 'run') && stage !== undefined) {
    const anchor = run?.stageAt.dispatched ?? run?.stageAt[stage] ?? null;
    return {
      label: stage,
      tone: kind === 'attention' ? 'human' : 'run',
      anchor,
      // The stage word is already on the bar, so the title's job is only the
      // stamp behind it — omitted entirely rather than trailing an `undefined`
      // when there is none, the same rule the elapsed reading follows.
      title: anchor === null ? stage : `${stage} since ${anchor}`
    };
  }
  /* #227: a tracker claim past its heartbeat window still carries `started`/`phase` (the mapper sets them for ANY unreleased claim, because an item shown
     as free while `claim` would have to retire somebody first is the other lie), so row 4 above would paint it `executing` forever. It is checked between
     the run's rows and the hand session's (`liveKind`'s order), and reads the heartbeat rather than `started`: how long the item has been worked is not the
     question once nobody is working it — how long it has been silent is. The age is in the label and `anchor` is null, so the card prints no second,
     ticking reading beside it. A run-held claim falls here too once its run stage is gone: the run surfaces already say crashed, and this card should agree. */
  if (kind === 'stale' && item.holder !== undefined) {
    const age = elapsedSince(item.holder.heartbeat, now);
    const host = item.holder.host === undefined || item.holder.host === '' ? '' : ` · ${item.holder.host}`;
    return {
      label: `stale · no heartbeat${age === null ? '' : ` ${age}`}${host}`,
      tone: 'stale',
      anchor: null,
      title: `claim stale — no heartbeat since ${item.holder.heartbeat}`
    };
  }
  if (kind === 'hand') {
    return {
      label: progressLabel(item),
      tone: 'human',
      anchor: item.started,
      // Literal `in progress`, not `progressLabel`'s wording: this string
      // names the stored KEY the stamp came from, which is the same key
      // whether the phase reads grooming, executing or nothing at all.
      title: `in progress since ${item.started}`
    };
  }
  return null;
}

/** What the queued strip prints, in a shape a test can assert directly — `LiveBar`'s sibling, minus the stamp, because the label carries none. */
export type QueuedStrip = {
  word: string;
  /** Mirrors `queuedReading`: `live` while a live run holds the project, `stale` when none does. The stylesheet dims the second by this attribute. */
  state: 'live' | 'stale';
  /** Only the stale strip has one: its word alone cannot say what to do about it. */
  title?: string;
};

/**
 * The `orchestrator:queued` strip, or null for none. A SIBLING of `liveBarFor` and deliberately not a fifth row of its precedence, though it paints in the
 * same 24 px band: `liveBarFor`'s set of cards is, by construction, `liveRank`'s `< 2` half (lib/board-sort.ts) plus the stale claims — the column order, the
 * Status filter's "In progress" and the board clock all at once — and a queued item is none of those. Nobody is on it; the label is a plan, never a claim (invariants.md).
 *
 * So the one precedence rule between the two lives here, in the `bar` argument: any live bar wins. That is what makes the claim beat the label. A claim
 * removes the label, but the tracker cache can hold both facts for a poll, and during that poll the card must read `executing`, not `queued`; the same goes
 * for a run that has moved the item past `pending`. `pending` itself draws no live bar (`ACTIVE_RUN_STAGES` leaves it out), so a queued item a run has not
 * reached yet keeps this strip — which is exactly what the label means.
 *
 * No elapsed reading on the right: the label has no timestamp to age, and the band stays empty there rather than inventing one.
 */
export function queuedStripFor(queued: 'live' | 'stale' | null | undefined, bar: LiveBar | null): QueuedStrip | null {
  if (bar !== null) return null;
  if (queued === 'live') return { word: 'queued', state: 'live' };
  if (queued === 'stale')
    return {
      word: 'queued · stale',
      state: 'stale',
      title: 'orchestrator:queued is set but no live run holds it — remove the label on GitHub, or stop the crashed run if it is this machine’s'
    };
  return null;
}
