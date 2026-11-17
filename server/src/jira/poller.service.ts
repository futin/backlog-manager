import { homedir } from 'node:os';

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import {
  JIRA_MENTIONS_POLL_MS,
  JIRA_MENTIONS_WINDOW_DAYS,
  JIRA_THREAD_MAX,
  SYNC_INTERVALS,
  isJiraKey,
  type JiraAccess,
  type JiraBoard,
  type JiraBoardFailure,
  type JiraBoardIssuesPayload,
  type JiraIssue,
  type JiraIssueDetail,
  type JiraIssueWriteResult,
  type JiraJqlCheckResult,
  type JiraMention,
  type JiraMentionsPayload,
  type JiraMentionsSummary,
  type JiraProjectRef,
  type JiraStatusPayload,
  type JiraThreadPayload,
  type JiraTransition
} from '../../../shared/types';
import { adfToMarkdown, replyDoc } from './adf';
import { readJiraConfig, type JiraConfig } from './config.util';
import { jiraEnv } from './env.util';
import { JIRA_RATE_LIMIT_DEFAULT_MS, accessOf } from './errors.util';
import { JiraBootState } from './identity';
import { JiraClient, jqlString, type JiraAuth, type JiraResponse } from './jira.client';
import { JIRA_ISSUE_FIELDS, categoryOf, mapJiraIssue, pickSprintField, type MapContext } from './map-issue';
import { applyDismissals, rawComments, runMentionsCheck, type JiraMentionCacheIssue } from './mentions-check.util';
import { JiraMentionsStore } from './mentions.store';
import { authorOf, judgeComments, mentionsUser } from './mentions.util';

/**
 * poller.service.ts — the Jira ticker, the per-board caches, and the handful of fresh reads the routes make (Jira phase 1; spec §3 `poller.service.ts` and
 * `identity.ts`, §5's read routes, §8's error mapping). The shape is `tracker/poller.service.ts`'s, deliberately: one `setTimeout` chain whose next link is
 * made only after the current sweep's awaits finish, an in-flight promise that `tick()` hands back instead of starting a second sweep, `unref` on the timer,
 * and `stopped` on shutdown. Every route answers from the cache this file fills, or from ONE fresh read this file performs — nothing else in the server
 * talks to Jira, so the 429 window and the 401 reset below have one place to be true.
 *
 * ## The arming rule (Jira › Mentions spec "Poller arming")
 *
 * The chain runs while the site is configured (all three env vars) and is not `unsupported` — whatever the boards say. It used to need a syncing board, an
 * `off` board still owed its cold sweep, or an unanswered boot; mentions widened that, because they are owed every `JIRA_MENTIONS_POLL_MS` for as long as
 * the site is configured, so a site with no boards, or with every board `off`, still keeps a chain alive to check them. `unsupported` (P5) is a site that
 * is not Jira Cloud, which no retry can change, so it disarms and stays disarmed until restart. The rule is judged at the END of every sweep, after its
 * awaits — the tracker poller's reasoning: `arm()` returns early while a sweep is in flight, trusting that sweep to schedule its successor. Due-ness is
 * judged on `jira.json` as read at the top of the sweep: a board added mid-tick is swept from the next tick, never half-way through this one.
 *
 * ## The mentions step (Jira › Mentions spec "How a check works", "Failure handling")
 *
 * One check rides each tick it is due on — at once after boot, then `JIRA_MENTIONS_POLL_MS` after the last ATTEMPT (a failing Jira is asked again on the
 * cadence, not on every 15 s tick) — AFTER the board loop, so its calls land in `sweepCalls` and the CALLS meter shows them. It is not starved by the
 * boards: a board's whole-board failure ends the board loop, not the tick, and the step still runs unless a 429 window is open or the boot is unanswered
 * (a 401 reset `me`, which the JQL needs) — the gate every call obeys. A 401 or 429 on its calls is the site's (`boardFailed`); any other failure is the
 * mentions cache's own `detail`, rows and `polledAt` kept, `access` untouched, because a mentions search failing says little about the boards and the next
 * board sweep is the better judge of the site. The calls and judgement are `mentions-check.util.ts`'s; the state and every verdict are here.
 *
 * ## The mentions routes (Jira › Mentions spec "Routes and shapes", "Sync now, two ways")
 *
 * The payload and the status summary are DERIVED on read: the cache keeps every candidate, and `applyDismissals` filters a copy against the store each
 * time, so a Dismiss that lands while a check is out cannot be undone by that check's swap. The manual check (`mentionsSweepNow`) does NOT go through
 * `tick()` — boards are not swept, and its calls are a route's, never the CALLS meter's: between ticks the next tick's opening `takeCalls()` discards them
 * like any fresh read's, and while a tick IS in flight (the client's counter is one number for the process) its `refuse` hook counts each call it sends
 * into `pressCalls`, which that tick subtracts from its own figure — counted at the hook because the hook is asked synchronously right before the call,
 * so no tick can open or close between the two. It shares exactly three
 * things with the tick-borne check: the in-flight join (`checkMentions`), the `SWEEP_FLOOR_MS` floor (measured from `mentionsEndAt`, whichever caller ran
 * the check), and the cadence (starting a check stamps the attempt, so a press puts the next background check 3 minutes after it). Its failures get the
 * check's own verdicts (`runMentions`: 401/429 to the site, anything else to the mentions `detail`); it then `wake()`s the chain, as `routeFailed` does, so
 * a 401's boot retry has a link coming — the widened arming already keeps one for any site it accepts a press on, and the wake makes that explicit.
 *
 * ## Why `off` still gets one cold sweep
 *
 * `off` means "do not poll", not "show nothing": a board whose list was never fetched would render empty, which reads as "nothing on this board" — a lie.
 * One sweep per process gives it a real list with an honest `polledAt` age beside it. A cold sweep that failed whole-board (Jira unreachable) has not
 * replaced anything, so the board is still owed and `due()` keeps answering yes for it; one that got far enough to replace the list has succeeded, per-entry
 * `failures` included, because those are part of the answer, not a reason to ask again.
 *
 * ## Why the Done window applies at map time
 *
 * `mapJiraIssue` drops a `done` issue older than the window as it is mapped (that is `map-issue.ts`'s rule and its constant). The poller hands it `now`
 * for the sweep and `null` for every fresh read: the board is "what is live", so an expired child must never reach the cache, the payload or the client —
 * but the modal and the roots picker ask about a SPECIFIC issue and must get it however old it is. Dropping at map time also means the walk still sees the
 * dropped key: the next `parent in` round names every key Jira returned, mapped or not, so a closed story's open subtask stays on the board.
 *
 * ## Why a sweep failure keeps the last good list
 *
 * A whole-board failure (transport, a 5xx, a 401, a 429) says nothing about the issues — only that this sweep could not see them. Replacing the cache with
 * an empty list would make every card vanish for the length of an outage and flash back afterwards; keeping the list, with its `polledAt` unmoved, lets the
 * board say what it last knew and how old that is, while `access` and `detail` say why it is not newer. Such a failure also ends the sweep for that tick: the
 * next board would meet the same outage, and each extra call against a failing site is one more against its rate limit. A per-entry failure (a 400, 403 or
 * 404 on one root or one query) is different — Jira answered, and the answer is about that entry — so it becomes a `failures` row and the rest proceeds.
 *
 * ## Why the 429 window refuses reads up front
 *
 * After a 429, every call made before `Retry-After` runs out is a call Jira has already said it will refuse, and making it is how a client earns a longer
 * window. So the window is stored once (`JiraBootState.retryAt`, from whichever caller met the 429 — a sweep or a route) and every caller checks it before
 * sending: the sweep makes NO call inside it, and a route's read is refused with a synthesised 429 carrying the STORED instant (P1), so two reads a second
 * apart answer the same `retryAt` rather than one that slides forward with the clock.
 *
 * Checking before sending is not enough on its own, because calls already in flight when the window opens still land inside it. So `openWindow` is the one
 * home of the rule that the stored end never moves while it is in force: a second 429 inside it (two route reads that passed the gate together, a boot call
 * that was already out) restamps `last429At` and nothing else; a synthesised refusal (`synthetic`, remembered in `SYNTHETIC`) opens nothing at all, because
 * Jira never sent it; the boot asks nothing more once a window is in force, and a boot or sweep 5xx or transport failure that lands inside one does not
 * overwrite `rate-limited` — a sweep 401 still records `unauthorized`, because a 401 is evidence about the credentials, not the window. When the window ends,
 * the verdict it covered comes back (`beforeWindow`) unless the boot has since answered in full — a 401 that was in force when the 429 arrived is still the
 * truth about the credentials, and `ok` would hide it.
 *
 * Every instant here — `polledAt`, `last429At`, the window, the back-off — comes from `Date.now()`, never `new Date()`, so a suite that mocks `Date.now`
 * controls the only clock this file reads.
 *
 * ## Why a saved board is swept at once, and waited for (phase 2)
 *
 * A board save lands in `jira.json`; the client reloads the board and `GET /api/jira` on the route's answer. If the route answered first, the client would read
 * the pre-save list with nothing on its own clock to ask again for up to a whole interval (or ever, for `off`). So `boardSaved(id)` sweeps that board now and
 * resolves when the sweep is done — raced against `JIRA_SAVE_SWEEP_WAIT_MS`, so a slow Jira holds the sheet for a bounded time and no longer: past the cap the
 * save has still landed and the sweep still runs to its end, and the next status poll catches the list up. It never rejects.
 *
 * "Now" is `forced`, a map from board id to the generation of the save that asked — NOT a reset of the cache's `polledAt`, which would empty the board's last
 * good list (`coldOwed` reads it, and an edit that fails to sweep must keep showing what the board last knew). `due()` honours it. A sweep spends the
 * force only when it SUCCEEDS on the board, so every way of not getting an answer — the boot unanswered, a 429 window caught at the top of
 * the loop or opened mid-board, a 401, a 5xx, a transport error — leaves the board forced, owed, and retried on the next tick until Jira answers; for an `off`
 * board that is the only thing that would ever replace the list swept from the pre-edit definition.
 *
 * A sweep already in flight is not the answer: it read `jira.json` at its top, before the save. Each sweep notes the generation it read the file under, and
 * spends only a force no newer than that — so a sweep that reaches the board after the save, but on the older copy of it, answers nothing and spends nothing.
 * `boardSaved` waits the in-flight sweep out and then runs one that STARTED after the call.
 *
 * ## Why the two issue writes live here, and what follows them (phase 3)
 *
 * `assignToMe` and `transitionIssue` are the first calls this server makes that change Jira. They are here and not in a controller because everything they
 * must honour is private here: the read gate and the 429 window (a write inside one is refused up front with the stored instant, P1), the 401 bookkeeping,
 * the identity, and the caches. A write that lands is followed by one re-read of the issue, spliced in place into every board cache already holding it, so
 * the card moves on the client's next poll rather than the next sweep (§8, plan R4). The re-read reads the issue itself, so it already carries the write;
 * the SWEEP may not — one in flight across the write, or one answered from a search index that has not caught up, carries the pre-write copy. So
 * `sweepBoard` keeps a cached copy whose `updated` is strictly newer than the sweep's (R5, `keepNewer`). There is no per-key queue (R6): these are not
 * read-modify-write on a body, two browsers racing are Jira's last-write-wins, and R5 keeps the caches on the newest answer.
 *
 * ## The mention reply (Jira › Mentions, Post reply; plan rulings R4, R7)
 *
 * `postReply` is the third write and the only one that adds text: `POST issue/{key}/comment`, an ADF body opening with an @-mention of the author of the
 * ticket's NEWEST open mention — read from this cache, never from the request, so a stale page cannot aim a mention at someone the list no longer shows. It
 * lives here for the assign/transition reasons above plus two of its own. First, the open-mention check is a read of the cache with the dismissals and
 * `answeredAt` applied, which only this file can make. Second, R4: unlike assign and transition, a post is not idempotent — two lands as two comments — so
 * it IS single-flight per key: `replying` is checked and set synchronously, with no `await` between the open-mention check and the set, and cleared in a
 * `finally`. The modal's busy flag cannot stand in for it, because two tabs are two modals.
 *
 * A post that lands drops the ticket from the cache and records `answeredAt[key] = created` (R7). The next check's search may not carry the reply yet —
 * Jira's search index lags its writes by seconds to a minute — and would swap the ticket straight back. So the swap stays whole and filters nothing, like
 * dismissals, and `unanswered()` drops, ON READ, every candidate created at or before the key's `answeredAt` (the ticket too, once none is left) wherever
 * the cache is read: the payload, the summary, `mentionCandidate`, the thread route (as `judgeComments`' `answeredAfter`) and `postReply`'s own check. A
 * newer mention survives it and brings the ticket back. Entries older than the window are pruned at each check, since nothing that old can be a candidate
 * any more; memory only, so a restart forgets them, by which time the index has caught up. No board cache is spliced: a comment is not a field they show.
 */

/** Two "Sync now" presses closer than this share one sweep's answer: the second spends no call (spec §5; the GitHub poller exports its own, same value). */
export const SWEEP_FLOOR_MS = 5_000;

/** What `sweepNow` answers; the route maps `not-armed` to a 409 and `wait` to a 429 carrying `retryAt`. */
export type SweepNowResult = { kind: 'done' } | { kind: 'not-armed' } | { kind: 'wait'; retryAt: number };

/** The base tick, the GitHub poller's. Every `SyncInterval` is a whole number of these, so the tick is the resolution and no board needs its own timer. */
export const JIRA_POLL_MS = 15_000;
/** The longest a board save waits for its own sweep; past it the route answers and the sweep finishes on its own. */
export const JIRA_SAVE_SWEEP_WAIT_MS = 20_000;
/** Issues kept per saved query. Silent: spec §3 ties `truncated` to the board cap alone, and the band's copy says `first 500 shown`. */
export const JIRA_QUERY_CAP = 200;
/** Issues kept per root walk, the root itself counting as the first. Silent, for the same reason. */
export const JIRA_ROOT_CAP = 200;
/** Issues kept per board, after dedupe; the one cap `truncated` reports. */
export const JIRA_BOARD_CAP = 500;
/** `parent in` rounds below a root: epic → story → subtask. An initiative-level root reaches its epics and stories, not their subtasks (§3). */
export const JIRA_DESCENDANT_ROUNDS = 2;
/** The roots picker's result count. */
export const JIRA_SEARCH_LIMIT = 20;
/** The longest `q` the search route accepts; the route enforces it, this is its one home. */
export const JIRA_SEARCH_MAX_CHARS = 100;
/** `maxResults` on every sweep search page — Jira Cloud's ceiling for the enhanced search with this many fields. */
export const JIRA_PAGE_SIZE = 100;

const UNSUPPORTED = 'Jira Server/DC is not supported';

/** The mentions check's cache: `polledAt` moves only on a successful check, and `detail` says why the latest one failed (`null` after a success). */
export interface MentionsCache {
  polledAt: string | null;
  detail: string | null;
  truncated: boolean;
  /** Read-only to every reader: `applyDismissals` filters a COPY on read, never these arrays in place (an in-place filter would eat the candidates). */
  readonly issues: readonly JiraMentionCacheIssue[];
}

/** One board's last good sweep. Replaced whole, or not at all. */
export interface JiraBoardCache {
  issues: JiraIssue[];
  polledAt: string | null;
  truncated: boolean;
  failures: JiraBoardFailure[];
}

/**
 * A fresh read's outcome. `retryAt` rides only on a 429 (fresh or refused inside the window) and is the stored window end, verbatim (P1). `access` rides
 * only where the response's status would say the wrong thing — an `unsupported` site refused up front is a synthesised `0`, which `accessOf` reads as
 * `unreachable`, while `GET /api/jira` says `unsupported`.
 */
export type JiraResult<T> = { ok: true; value: T } | { ok: false; response: JiraResponse<unknown>; retryAt?: string; access?: JiraAccess };

/** What an issue write answers: a `JiraResult`, or one of the two refusals that are this server's own sentence rather than Jira's (plan R2, §8). */
export type JiraIssueWriteOutcome = JiraResult<JiraIssueWriteResult> | { ok: false; refusal: 'no identity' | 'transition not offered' };

/**
 * What `postReply` answers: the posted comment (its `url` the focused-comment link), the two refusals made before any call — `no open mention` (the key is
 * not open in the cache: answered, dismissed, or never there) and `posting` (R4, another post on the key is still out) — or a failure. `sent: true` marks a
 * failure Jira itself answered to the POST, so the route names the comment scope on that 401/403 and never on a refusal made before the call (the gate's,
 * or `unauthorizedRefusal()`'s 401, which is about the token as a whole).
 */
export type JiraReplyOutcome =
  | JiraResult<{ id: string; created: string; url: string }>
  | { ok: false; response: JiraResponse<unknown>; retryAt?: string; access?: JiraAccess; sent: true }
  | { ok: false; refusal: 'no open mention' | 'posting' };

/** A failed fresh read, as the routes receive it. */
type JiraRefusal = { ok: false; response: JiraResponse<unknown>; retryAt?: string; access?: JiraAccess };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const iso = (ms: number): string => new Date(ms).toISOString();
const ok = (res: JiraResponse<unknown>): boolean => res.status >= 200 && res.status < 300;

/** A response that says the SITE could not be read (as opposed to one entry): transport, a 5xx, a 401, a 429. Those end the sweep. */
const wholeBoard = (res: JiraResponse<unknown>): boolean => res.status === 0 || res.status === 401 || res.status === 429 || res.status >= 500;

/**
 * The `detail` a failure records: the transport error's own text for `0`; `Jira answered <status>` for a 5xx or a status `accessOf` has no opinion on (a
 * 5xx body is a gateway page, not a sentence); Jira's own sentence otherwise.
 */
function detailOf(res: JiraResponse<unknown>): string {
  if (res.status === 0) return res.message ?? 'Jira unreachable';
  if (res.status >= 500 || accessOf(res) === null) return `Jira answered ${res.status}`;
  return res.message ?? `Jira answered ${res.status}`;
}

/** A `failures` row's message: Jira's own sentence about that root or query — the reason a person can act on — never a bare status when Jira sent one. */
function entryMessage(res: JiraResponse<unknown>): string {
  return res.message ?? `Jira answered ${res.status}`;
}

/**
 * Every response this file made up rather than received. Held by identity, not by a field on the response, so `JiraResponse` stays the client's shape and a
 * synthesised 429 can never be told apart from Jira's by anything but this set — which `openWindow` consults, so only Jira can open a window (header).
 */
const SYNTHETIC = new WeakSet<JiraResponse<unknown>>();

/** A synthesised response, for an answer this file gives without asking Jira (P3, the 429 window). */
function synthetic(status: number, message: string | null): JiraResponse<unknown> {
  const res: JiraResponse<unknown> = { status, data: null, message, retryAfter: null };
  SYNTHETIC.add(res);
  return res;
}

interface Pages {
  /** Every key Jira returned, mapped or dropped by the Done window — what the next `parent in` round names. */
  raw: string[];
  issues: JiraIssue[];
  failure: JiraResponse<unknown> | null;
}

@Injectable()
export class JiraPollerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  private readonly boot = new JiraBootState();
  private readonly caches = new Map<string, JiraBoardCache>();
  /**
   * Boards a save asked to have swept now (header), each with the generation (`forceSeq`) of the save that asked. `due()` honours it,
   * and a sweep spends it only when it SUCCEEDS on the board and read `jira.json` after that save (`run()`).
   */
  private readonly forced = new Map<string, number>();
  /** Bumped by every `boardSaved`; a sweep remembers the value it read the file under, so it can tell a save it saw from one that landed after. */
  private forceSeq = 0;
  /** The calls the last sweep made, for the chip's CALLS meter (§6). */
  private sweepCalls = 0;
  /**
   * Calls a `mentionsSweepNow` check sent since the running tick's opening `takeCalls()` — the press's, not the tick's, so the tick subtracts them (header,
   * "The mentions routes"). Reset at every tick's start; a press between ticks only grows it until the next start resets it with the counter it shadows.
   */
  private pressCalls = 0;
  /** When the last sweep finished, for `SWEEP_FLOOR_MS`. `null` until one has. */
  private lastSweepEndAt: number | null = null;
  private last429At: string | null = null;
  /** The mentions check's last good answer, plus why the latest check (if it failed) is not newer. Replaced whole on success (`checkMentions`). */
  private mentions: MentionsCache = { polledAt: null, detail: null, truncated: false, issues: [] };
  /**
   * R7 (header, "The mention reply"): per key, Jira's `created` of the reply posted from here. Applied on read by `unanswered()`, never in the swap; pruned
   * at each check once older than the window. Memory only.
   */
  private readonly answeredAt = new Map<string, string>();
  /** R4: the keys whose reply POST is out right now. Checked and set with no `await` between, cleared in `postReply`'s `finally`. */
  private readonly replying = new Set<string>();
  /** The check running now, tick-borne or not: a second caller joins it rather than sending a second search (header; `mentionsSweepNow` joins too). */
  private mentionsInFlight: Promise<void> | null = null;
  /** When the last check STARTED — the cadence runs from the attempt, not the success. `null` until one has: due at once after boot. */
  private mentionsAttemptAt: number | null = null;
  /** When the last check ended, for `mentionsSweepNow`'s `SWEEP_FLOOR_MS` (spec "Sync now, two ways"). `null` until one has. */
  private mentionsEndAt: number | null = null;
  /** The site sweep asked for a check now (`sweepNow`). `mentionsDue` honours it; starting a check spends it, whatever the check then answers. */
  private mentionsForced = false;

  /** The verdict a 429 window covered, restored when the window ends with the boot still unanswered (header). `null` while no window is open. */
  private beforeWindow: { access: JiraAccess; detail: string | null } | null = null;

  /**
   * The dismissals the payload and the summary are filtered against. Optional so a suite can build a poller on a bare client (`new JiraPollerService(client)`)
   * — it then reads as no dismissals; the module always provides the one store, the same instance the mentions controller writes.
   */
  constructor(
    private readonly client: JiraClient,
    @Optional() @Inject(JiraMentionsStore) private readonly store: JiraMentionsStore | null = null
  ) {}

  /** A tick is scheduled. Derived from the timer, for the reason the tracker poller gives: two sources of truth for "is a tick coming" drift apart. */
  get armed(): boolean {
    return this.timer !== null;
  }

  onApplicationBootstrap(): void {
    this.arm();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.disarm();
  }

  /** Start the chain if anything is owed, or confirm it is running. Idempotent — phase 2's board saves call it after they write. */
  arm(): void {
    if (this.stopped) return;
    if (!jiraEnv().configured || !this.owed()) {
      this.clearTimer();
      return;
    }
    // A pending timer OR a tick mid-flight both mean the chain is alive: a tick clears its own timer on entry, so checking the timer alone would let a
    // concurrent `arm()` start a second chain in that window.
    if (this.timer !== null || this.inFlight !== null) return;
    void this.tick();
  }

  /** Drops the pending link. Not a hard stop: a sweep in flight still schedules its successor when it ends — `onApplicationShutdown` is the hard stop. */
  disarm(): void {
    this.clearTimer();
  }

  /** One sweep, or the one already running — a caller awaiting `tick()` is asking "has a sweep including right now finished". */
  tick(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const running = this.sweep().finally(() => {
      this.inFlight = null;
      this.lastSweepEndAt = Date.now();
    });
    this.inFlight = running;
    return running;
  }

  /**
   * A board was saved: sweep it now and resolve when a sweep that includes it has finished, or after `JIRA_SAVE_SWEEP_WAIT_MS`, whichever is first. Never
   * rejects — a save has already landed by the time this is called, and a failing Jira is the board's `access`, not the route's error. Where the sweep cannot
   * run (boot unanswered, a 429 window, `unsupported`) it returns early, as `run()` does, and this resolves with the board still owed.
   */
  async boardSaved(id: string): Promise<void> {
    if (this.stopped) return;
    this.forced.set(id, ++this.forceSeq);
    const swept = (async (): Promise<void> => {
      // The in-flight sweep read the file before the save, so it cannot spend this force (its generation is older); the sweep after it can.
      if (this.inFlight !== null) await this.inFlight.catch(() => undefined);
      // `tick()` is `sweep()`, which clears the pending link on entry — the one place that is done.
      await this.tick();
    })().catch(() => undefined);

    let cap: NodeJS.Timeout | undefined;
    const capped = new Promise<void>((resolve) => {
      cap = setTimeout(resolve, JIRA_SAVE_SWEEP_WAIT_MS);
      cap.unref?.();
    });
    try {
      await Promise.race([swept, capped]);
    } finally {
      clearTimeout(cap);
    }
  }

  /**
   * `POST /api/jira/sweep`, the popover head's site-wide `Sync now`. Everything is decided synchronously before the first await, so two presses in one tick see
   * the same `inFlight` and join it rather than each forcing a sweep. Order: nothing armed and nothing running → `not-armed` (an unconfigured or `unsupported`
   * site has no chain, and a button that did something there would be a second polling path); a 429 window → `wait` with the STORED end, no call (the per-board
   * `boards/sweep` is not refused in one — this button alone is); a sweep running → join it; one finished under `SWEEP_FLOOR_MS` ago → `done`, no call; else
   * force every non-`off` board (the `boardSaved` mechanism, so a 401 or a window opening mid-sweep leaves them owed), force a mentions check
   * (`mentionsForced`), and sweep once. An `off` board is left to its own per-row icon. With the arming widened (header), `not-armed` is now only an
   * unconfigured or `unsupported` site: a site with every board `off` keeps a chain for mentions, so the press checks them and answers `done`.
   */
  async sweepNow(): Promise<SweepNowResult> {
    const now = Date.now();
    if (this.stopped || (this.timer === null && this.inFlight === null)) return { kind: 'not-armed' };
    this.expireWindow(now);
    if (this.inWindow(now)) return { kind: 'wait', retryAt: this.boot.retryAt! };
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
      return { kind: 'done' };
    }
    if (this.lastSweepEndAt !== null && now - this.lastSweepEndAt < SWEEP_FLOOR_MS) return { kind: 'done' };
    for (const board of readJiraConfig().boards) if (board.interval !== 'off') this.forced.set(board.id, ++this.forceSeq);
    this.mentionsForced = true;
    await this.tick().catch(() => undefined);
    return { kind: 'done' };
  }

  /**
   * `POST /api/jira/mentions/sweep`, the Mentions page's own "check now" (spec "Poller arming"). Like `sweepNow`, every decision is made before the first
   * await. Order: mentions not armed (unconfigured, `unsupported`) → `not-armed`; a 429 window → `wait` with the STORED end, no call; a check running
   * (tick-borne or another press) → join it; one ended under `SWEEP_FLOOR_MS` ago → `done`, no call; the boot not whole (no `cloudId`, or a 401 reset
   * `me`, which the JQL is built from) → `done`, no call — the status says why, and the boot retry on the chain is what fixes it; else one check, outside
   * the tick (header), then `wake()`. Never rejects: `checkMentions` turns a throw into the mentions `detail`.
   */
  async mentionsSweepNow(): Promise<SweepNowResult> {
    const now = Date.now();
    if (this.stopped || !this.mentionsArmed()) return { kind: 'not-armed' };
    this.expireWindow(now);
    if (this.inWindow(now)) return { kind: 'wait', retryAt: this.boot.retryAt! };
    if (this.mentionsInFlight !== null) {
      await this.mentionsInFlight;
      return { kind: 'done' };
    }
    if (this.mentionsEndAt !== null && now - this.mentionsEndAt < SWEEP_FLOOR_MS) return { kind: 'done' };
    const gate = this.gate();
    if ('refused' in gate || !this.boot.answered()) return { kind: 'done' };
    await this.checkMentions(gate.auth, true);
    this.wake();
    return { kind: 'done' };
  }

  /** A board was deleted: its cache goes now, not at the next sweep's hygiene pass — a board re-created under the same id must start cold. */
  boardDeleted(id: string): void {
    this.caches.delete(id);
    this.forced.delete(id);
  }

  /** `GET /api/jira`. No outbound call: everything here is memory, the env and `jira.json`. The credentials never appear (§10). */
  status(): JiraStatusPayload {
    const env = jiraEnv();
    if (!env.configured) {
      return {
        configured: false,
        configUnreadable: null,
        site: null,
        me: null,
        tokenKind: null,
        access: 'unconfigured',
        detail: env.detail,
        boards: [],
        repos: {},
        repoDefaults: {},
        projects: [],
        skills: [],
        calls: { sweep: 0, last429At: null },
        live: {},
        armed: false,
        home: null,
        mentions: null
      };
    }
    this.expireWindow(Date.now());
    const config = readJiraConfig();
    const boards = config.boards.map((board) => {
      const cache = this.caches.get(board.id);
      return {
        ...board,
        polledAt: cache?.polledAt ?? null,
        count: cache?.issues.length ?? 0,
        truncated: cache?.truncated ?? false,
        failures: cache?.failures ?? []
      };
    });
    return {
      configured: true,
      configUnreadable: config.unreadable,
      site: env.site,
      // Shown only once the boot is whole: an identity beside a board that cannot be swept yet (the sprint field still missing) would read as a working
      // connection. The boot state keeps the answer, so the retry asks only what is still missing.
      me: this.boot.answered() ? this.boot.me : null,
      tokenKind: this.boot.tokenKind,
      access: this.boot.access,
      detail: this.boot.detail,
      boards,
      repos: config.repos,
      repoDefaults: config.repoDefaults,
      projects: this.projectsOf(config),
      skills: config.skills,
      calls: { sweep: this.sweepCalls, last429At: this.last429At },
      live: {},
      // A sweep clears the timer on entry, so the `armed` getter reads false for its whole length — the poller's busiest moment, which the Connection card
      // and the chip would then call `idle`. A tick in flight is a chain that is alive, so status counts it; the getter stays timer-only, as `arm()` needs.
      armed: this.timer !== null || this.inFlight !== null,
      home: homedir(),
      mentions: this.mentionsSummary()
    };
  }

  /**
   * `GET /api/jira/mentions` — the cache with the dismissals applied (header), no call. Unconfigured answers what `GET /api/jira` says in that state, its
   * reason included. `me` is the boot's display name (the `@` chip), `null` until `myself` answers; `retryAt` the open 429 window's end, else `null`.
   */
  mentionsPayload(): JiraMentionsPayload {
    const env = jiraEnv();
    if (!env.configured) return { configured: false, detail: env.detail };
    const { issues, dismissed } = applyDismissals(this.unanswered(), this.dismissedPredicate());
    return {
      configured: true,
      polledAt: this.mentions.polledAt,
      detail: this.mentions.detail,
      truncated: this.mentions.truncated,
      retryAt: this.windowEnd(),
      window: JIRA_MENTIONS_WINDOW_DAYS,
      me: this.boot.me?.name ?? null,
      issues,
      dismissed
    };
  }

  /**
   * `GET /api/jira/issue/:key/thread` — the mention modal's fresh read: the newest `JIRA_THREAD_MAX` comments, put back in time order, each judged as the
   * check judges a thread (`judgeComments` over the same page, minus the dismissed ids), so `open` here and the list never disagree about one comment. A
   * fresh read like `issueDetail`: the gate first, a failure through `routeFailed` (the route turns a 403/404 into its own 404), and its calls a route's.
   * With `me` unknown there is no "mine" to judge: refused as the 401 that state is, or as the boot's own `connecting`.
   */
  async thread(key: string): Promise<JiraResult<JiraThreadPayload>> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const me = this.boot.me;
    if (me === null) return this.unauthorizedRefusal() ?? { ok: false, response: synthetic(0, this.boot.detail ?? 'connecting') };
    const res = await this.client.comments(gate.auth, key, JIRA_THREAD_MAX);
    if (!ok(res)) return this.routeFailed(res);
    // The endpoint answers newest first (`orderBy=-created`, so the cap keeps the newest); the modal reads a conversation, oldest first.
    const page = Array.isArray(res.data?.comments) ? res.data.comments : [];
    const comments = rawComments(page).reverse();
    const dismissed = this.dismissedPredicate();
    // `answeredAfter` is R7's: a reply posted from here that this read may already carry (then my own comment answers it anyway) or may not.
    const answeredAfter = this.answeredAt.get(key) ?? null;
    const open = new Set(
      judgeComments({ comments, me: me.accountId, site: gate.auth.site, key, now: Date.now(), windowDays: JIRA_MENTIONS_WINDOW_DAYS, answeredAfter })
        .map((m) => m.commentId)
        .filter((id) => !dismissed(id))
    );
    // `truncated` is Jira's `total` against the page Jira SENT, not against `comments`: `rawComments` skips an entry with no string id or `created`, and a
    // thread returned whole must not read as cut short because one of its entries was unreadable.
    const total = typeof res.data?.total === 'number' ? res.data.total : page.length;
    return {
      ok: true,
      value: {
        key,
        total,
        truncated: total > page.length,
        comments: comments.map((c) => ({
          id: c.id,
          author: authorOf(c),
          created: c.created,
          markdown: adfToMarkdown(c.body).markdown,
          mine: c.author?.accountId === me.accountId,
          mentionsMe: mentionsUser(c.body, me.accountId),
          open: open.has(c.id)
        }))
      }
    };
  }

  /**
   * The cached candidate `commentId` on `key`, or `null` — what `POST /api/jira/mentions/dismiss` proves each id against, from memory, before it writes. A
   * candidate, not an open mention: whether it is already dismissed is the store's question, asked by the route that holds the store.
   */
  mentionCandidate(key: string, commentId: string): JiraMention | null {
    const issue = this.unanswered().find((i) => i.key === key);
    return issue?.candidates.find((m) => m.commentId === commentId) ?? null;
  }

  /**
   * The status payload's slice: `count` is the payload's `issues.length` (TICKETS waiting, the rail's unit), `null` until a check has succeeded. The whole
   * slice is `null` while no check is owed (`!mentionsArmed()`: unconfigured, or an `unsupported` site): nothing will ever stamp `polledAt`, and a
   * `polledAt: null` summary would keep the shell's status read on its 15 s floor and the popover on "not checked yet" for good.
   */
  private mentionsSummary(): JiraMentionsSummary | null {
    if (!this.mentionsArmed()) return null;
    const { polledAt, detail, truncated } = this.mentions;
    const count = polledAt === null ? null : applyDismissals(this.unanswered(), this.dismissedPredicate()).issues.length;
    return { polledAt, count, detail, truncated, retryAt: this.windowEnd() };
  }

  /**
   * The cache as every reader sees it (R7): per key with an `answeredAt`, the candidates created at or before it are dropped, and a ticket left with none
   * goes. A COPY for any ticket it touches — the cache's arrays are read-only to every reader — and the cache itself when nothing was answered. Applied
   * BEFORE `applyDismissals`, so a ticket whose only remaining candidate is a newer dismissed one lands in `dismissed`, not nowhere. A candidate or an entry
   * whose instant does not parse is kept: hiding a mention on a reading this code cannot make is the worse error.
   */
  private unanswered(): readonly JiraMentionCacheIssue[] {
    if (this.answeredAt.size === 0) return this.mentions.issues;
    const out: JiraMentionCacheIssue[] = [];
    for (const issue of this.mentions.issues) {
      const cut = Date.parse(this.answeredAt.get(issue.key) ?? '');
      if (Number.isNaN(cut)) {
        out.push(issue);
        continue;
      }
      const candidates = issue.candidates.filter((m) => !(Date.parse(m.created) <= cut));
      if (candidates.length > 0) out.push({ ...issue, mentions: [...candidates], candidates });
    }
    return out;
  }

  /** One read of the store per payload: a Set, so filtering a hundred tickets is not a hundred scans of the dismissal list. */
  private dismissedPredicate(): (commentId: string) => boolean {
    const ids = new Set((this.store?.dismissed() ?? []).map((d) => d.commentId));
    return (commentId) => ids.has(commentId);
  }

  /** The open 429 window's end as ISO, or `null` — expired where it is read, as `status()` does. */
  private windowEnd(): string | null {
    const now = Date.now();
    this.expireWindow(now);
    return this.inWindow(now) ? iso(this.boot.retryAt!) : null;
  }

  /** The mentions cache as the last check left it — candidates, NOT dismissal-filtered; `applyDismissals` derives the payload from it on read, in a copy. */
  mentionsCache(): Readonly<MentionsCache> {
    return this.mentions;
  }

  /** Mentions are owed whenever the site is configured and not `unsupported` (spec "Poller arming") — the same condition `owed()` arms the chain on. */
  mentionsArmed(): boolean {
    return jiraEnv().configured && this.boot.access !== 'unsupported';
  }

  /** A board's cached list: `null` for a board `jira.json` does not hold, an empty list with `polledAt: null` for one not swept yet. */
  boardIssues(id: string): JiraBoardIssuesPayload | null {
    if (!readJiraConfig().boards.some((b) => b.id === id)) return null;
    const cache = this.caches.get(id);
    return cache === undefined ? { issues: [], polledAt: null } : { issues: cache.issues, polledAt: cache.polledAt };
  }

  /** The ids of the boards (in `jira.json` order) whose cache holds `key`. Read against the config so a deleted board stops answering at once. */
  boardsHolding(key: string): string[] {
    return readJiraConfig()
      .boards.filter((b) => this.caches.get(b.id)?.issues.some((i) => i.key === key) ?? false)
      .map((b) => b.id);
  }

  /**
   * Who the credentials resolve to, or `null` while `myself` has not answered (or a 401 undid it) — the very value `assignToMe` reads. `POST
   * /api/agents/dispatch-jira` asks it twice before writing anything: to refuse an assign with `no identity` before its other writes, and to skip an assign
   * the ticket already carries. Not `status().me`, which also waits for the rest of the boot: the two would disagree for exactly as long as the sprint
   * field is unanswered, and the dispatch must refuse the assign exactly when `assignToMe` would.
   */
  identity(): { accountId: string; name: string } | null {
    return this.boot.me;
  }

  /** `GET /api/jira/issue/:key`: the issue, its children and its transitions, read fresh, the Done window off. Any of the three failing fails it (P4). */
  async issueDetail(key: string): Promise<JiraResult<JiraIssueDetail>> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const { auth } = gate;
    const ctx: MapContext = { site: auth.site, sprintField: this.boot.sprintField, now: null };

    const res = await this.client.issue(auth, key, [...this.sweepFields(), 'description']);
    if (!ok(res)) return this.routeFailed(res);
    const issue = mapJiraIssue(res.data, ctx);
    if (issue === null) return this.routeFailed(synthetic(0, 'Jira sent an issue this server cannot read'));

    const children = await this.pages(auth, `parent in (${jqlString(key)})`, ctx, JIRA_ROOT_CAP);
    if (children.failure !== null) return this.routeFailed(children.failure);

    // A window opened (by a sweep, or another route) while the first two calls were out: the third is one Jira has already said it will refuse.
    const refused = this.windowRefusal();
    if (refused !== null) return refused;
    const offered = await this.client.transitions(auth, key);
    if (!ok(offered)) return this.routeFailed(offered);
    const transitions: JiraTransition[] = (Array.isArray(offered.data?.transitions) ? offered.data.transitions : []).filter(isObj).map((t) => {
      const to = isObj(t.to) ? t.to : {};
      return {
        id: str(t.id),
        name: str(t.name),
        to: { name: str(to.name), category: categoryOf(isObj(to.statusCategory) ? to.statusCategory.key : undefined) }
      };
    });

    const fields = isObj(res.data?.fields) ? res.data.fields : {};
    return {
      ok: true,
      value: {
        ...issue,
        // `null` on a ticket with no description; `adfToMarkdown` folds any non-document to '' (Review Focus 5).
        description: adfToMarkdown(fields.description).markdown,
        children: children.issues,
        transitions,
        boards: this.boardsHolding(key),
        session: null
      }
    };
  }

  /**
   * One issue, read fresh with the sweep's fields and nothing else: what a session detected on a branch needs for its link's snapshot (Jira sessions §5), and
   * what `/jira link` checks before it links. A single `client.issue` read — no children, no transitions — so a tick that confirms five keys costs five calls.
   * Refused with no call inside a 429 window (the gate); a failure goes through `routeFailed`, as every fresh read's does, so a 401 or a 429 here moves the site
   * state and the caller sees the 404 / 429 / 0 and tells them apart. The Done window is OFF (`now: null`): whether a board would still show the issue is not
   * the question, whether the key is a real ticket is.
   */
  async issueSummary(key: string): Promise<JiraResult<JiraIssue>> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const { auth } = gate;
    const res = await this.client.issue(auth, key, this.sweepFields());
    if (!ok(res)) return this.routeFailed(res);
    const issue = mapJiraIssue(res.data, { site: auth.site, sprintField: this.boot.sprintField, now: null });
    if (issue === null) return this.routeFailed(synthetic(0, 'Jira sent an issue this server cannot read'));
    return { ok: true, value: issue };
  }

  /**
   * The roots picker: an exact key when `q` (trimmed, upper-cased) is one, else a summary prefix match, `JIRA_SEARCH_LIMIT` at most, the Done window off.
   * Blank is `[]` with no call. The length bound is the route's to enforce (`JIRA_SEARCH_MAX_CHARS`).
   */
  async search(q: string): Promise<JiraResult<JiraIssue[]>> {
    const text = q.trim();
    if (text === '') return { ok: true, value: [] };
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const upper = text.toUpperCase();
    const jql = isJiraKey(upper) ? `key = ${jqlString(upper)}` : `summary ~ ${jqlString(`${text}*`)}`;
    const res = await this.client.search(gate.auth, { jql, fields: this.sweepFields(), maxResults: JIRA_SEARCH_LIMIT });
    if (!ok(res)) return this.routeFailed(res);
    const ctx: MapContext = { site: gate.auth.site, sprintField: this.boot.sprintField, now: null };
    const issues = (Array.isArray(res.data?.issues) ? res.data.issues : [])
      .map((raw) => mapJiraIssue(raw, ctx))
      .filter((i): i is JiraIssue => i !== null)
      .slice(0, JIRA_SEARCH_LIMIT);
    return { ok: true, value: issues };
  }

  /**
   * Every project the credentials can see, sorted by key. Paged by `startAt` (P13), never by following the `nextPage` URL Jira hands back: the client builds
   * every URL itself, so Basic auth is never sent to an address that came out of a response body.
   */
  async projects(): Promise<JiraResult<JiraProjectRef[]>> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const byKey = new Map<string, string>();
    let startAt = 0;
    for (;;) {
      const res = await this.client.projects(gate.auth, startAt);
      if (!ok(res)) return this.routeFailed(res);
      const values = Array.isArray(res.data?.values) ? res.data.values : [];
      for (const v of values) {
        if (isObj(v) && typeof v.key === 'string' && !byKey.has(v.key)) byKey.set(v.key, str(v.name) || v.key);
      }
      // An empty page ends it too: a Jira that says `isLast: false` and sends nothing would otherwise be asked for the same page forever.
      if (res.data?.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
    const value = [...byKey].map(([key, name]) => ({ key, name })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { ok: true, value };
  }

  /**
   * The board sheet's check line: Jira's strict parse first (an unknown field is an error there, not an empty result), then the approximate count — which
   * is where an unbounded query is refused, since it parses fine (P8). Both of those answers are `ok: true` with a verdict inside; only a failure to ASK is
   * a `JiraResult` failure.
   */
  async checkJql(jql: string): Promise<JiraResult<JiraJqlCheckResult>> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const parsed = await this.client.parseJql(gate.auth, jql);
    if (!ok(parsed)) return this.routeFailed(parsed);
    const first = Array.isArray(parsed.data?.queries) ? parsed.data.queries[0] : undefined;
    const errors = isObj(first) && Array.isArray(first.errors) ? first.errors.filter((e): e is string => typeof e === 'string' && e !== '') : [];
    if (errors.length > 0) return { ok: true, value: { ok: false, message: errors.join('; ') } };

    const counted = await this.client.approximateCount(gate.auth, jql);
    if (counted.status === 400) return { ok: true, value: { ok: false, message: counted.message ?? 'Jira answered 400' } };
    if (!ok(counted)) return this.routeFailed(counted);
    return { ok: true, value: { ok: true, count: typeof counted.data?.count === 'number' ? counted.data.count : 0 } };
  }

  /**
   * `POST /api/jira/issue/assign` (phase 3, §8): `PUT issue/{key}/assignee` with MY accountId, then the splice. Refused with no call by the read gate
   * (unconfigured, a 429 window, `unsupported`, no `cloudId`), then by R2: under `unauthorized` the 401 that state already is, and with the identity unknown
   * `no identity` — never a PUT carrying anything else, because Jira reads `{ accountId: null }` as UNASSIGN. No second window check before the PUT: nothing
   * is awaited between the gate's and the send, so no window can have opened in between.
   */
  async assignToMe(key: string): Promise<JiraIssueWriteOutcome> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const unauthorized = this.unauthorizedRefusal();
    if (unauthorized !== null) return unauthorized;
    const me = this.boot.me;
    if (me === null) return { ok: false, refusal: 'no identity' };

    const res = await this.client.assign(gate.auth, key, me.accountId);
    if (!ok(res)) return this.routeFailed(res);
    return { ok: true, value: { ok: true, reread: await this.splice(gate.auth, key) } };
  }

  /**
   * `POST /api/jira/issue/transition` (phase 3, §8): a FRESH `GET issue/{key}/transitions`, the id checked against it, then `POST issue/{key}/transitions`
   * and the splice. The list the modal drew its menu from is minutes old by the time someone picks; the workflow may have moved the issue since, and Jira's
   * 400 for a stale id is a sentence about Jira's ids, not about the issue — so the offered check is here, and its refusal is this server's own
   * (`transition not offered`). Needs no identity (R2): refused only while `unauthorized`, which `gate()` alone would let through, since a 401 keeps the
   * `cloudId`. The read is the window's to refuse as well: a 429 met while it was out — a sweep's or another route's — makes the POST one Jira has already
   * said it will refuse (the `issueDetail` pattern).
   */
  async transitionIssue(key: string, transitionId: string): Promise<JiraIssueWriteOutcome> {
    const gate = this.gate();
    if ('refused' in gate) return gate.refused;
    const unauthorized = this.unauthorizedRefusal();
    if (unauthorized !== null) return unauthorized;
    const { auth } = gate;

    const offered = await this.client.transitions(auth, key);
    if (!ok(offered)) return this.routeFailed(offered);
    const list = Array.isArray(offered.data?.transitions) ? offered.data.transitions : [];
    if (!list.some((t) => isObj(t) && str(t.id) === transitionId)) return { ok: false, refusal: 'transition not offered' };

    const refused = this.windowRefusal();
    if (refused !== null) return refused;
    const res = await this.client.transition(auth, key, transitionId);
    if (!ok(res)) return this.routeFailed(res);
    return { ok: true, value: { ok: true, reread: await this.splice(auth, key) } };
  }

  /**
   * `POST /api/jira/mentions/reply` (header, "The mention reply"). Order: the open-mention check (sync, the cache with dismissals and `answeredAt` applied)
   * → R4's check-and-set (sync — no `await` between the two, so of two posts racing on one key exactly one passes) → `gate()` → `unauthorizedRefusal()` →
   * `addComment`. The mention targets the author of the ticket's newest open mention (`mentions[0]`, newest first). On a 2xx the ticket leaves the cache and
   * `answeredAt` records Jira's `created` (now, should Jira send none that parses); a failure goes through `routeFailed`, so a 401 resets the boot and a 429
   * opens the window as any read's does, and comes back marked `sent`. No second window check before the POST: nothing is awaited between the gate's and the
   * send.
   */
  async postReply(key: string, text: string): Promise<JiraReplyOutcome> {
    const issue = applyDismissals(this.unanswered(), this.dismissedPredicate()).issues.find((i) => i.key === key);
    if (issue === undefined) return { ok: false, refusal: 'no open mention' };
    if (this.replying.has(key)) return { ok: false, refusal: 'posting' };
    this.replying.add(key);
    try {
      const gate = this.gate();
      if ('refused' in gate) return gate.refused;
      const unauthorized = this.unauthorizedRefusal();
      if (unauthorized !== null) return unauthorized;

      const to = issue.mentions[0].author;
      const res = await this.client.addComment(gate.auth, key, replyDoc({ accountId: to.accountId, name: to.name }, text));
      if (!ok(res)) return { ...this.routeFailed(res), sent: true };
      const id = str(res.data?.id);
      const created = Number.isNaN(Date.parse(str(res.data?.created))) ? iso(Date.now()) : str(res.data?.created);
      this.mentions = { ...this.mentions, issues: this.mentions.issues.filter((i) => i.key !== key) };
      this.answeredAt.set(key, created);
      return { ok: true, value: { id, created, url: `https://${gate.auth.site}/browse/${key}?focusedCommentId=${id}` } };
    } finally {
      this.replying.delete(key);
    }
  }

  // ── the chain ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) return;
    // `unref()` so a pending poll never keeps the process alive on its own — the tracker poller's and the watchdog's treatment.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, JIRA_POLL_MS);
    this.timer.unref?.();
  }

  /** Make sure a link is coming — for a route that just put the boot back into "owed" (a 401). A sweep in flight schedules its own successor. */
  private wake(): void {
    if (this.timer === null && this.inFlight === null) this.schedule();
  }

  /**
   * The arming rule (header): mentions are owed for as long as the site is configured (the caller's check), so only `unsupported` (P5, final) disarms. The
   * board clauses this used to hold — a syncing board, a cold sweep owed, a forced board — are all subsumed: each still decides `due()`, not the chain.
   */
  private owed(): boolean {
    return this.boot.access !== 'unsupported';
  }

  private coldOwed(board: JiraBoard): boolean {
    return (this.caches.get(board.id)?.polledAt ?? null) === null;
  }

  /** Never swept (or never successfully) is due at any interval — the cold sweep; otherwise one interval since the last good sweep (§3). */
  private due(board: JiraBoard, now: number): boolean {
    if (this.coldOwed(board) || this.forced.has(board.id)) return true;
    const ms = SYNC_INTERVALS[board.interval];
    if (ms === null) return false;
    return now - Date.parse(this.caches.get(board.id)!.polledAt!) >= ms;
  }

  private inWindow(now: number): boolean {
    return this.boot.retryAt !== null && now < this.boot.retryAt;
  }

  /**
   * A 429 window that has run out is not a verdict any more. Expired where the state is READ — `status()`, the read gate, the sweep — not by a timer:
   * a route can open the window while the chain is disarmed (an `unsupported` site, or before the first tick — and, before mentions widened the
   * arming, a site with no boards), and a verdict that only a sweep could clear would then read `rate-limited` with a past instant for the life of the
   * process.
   */
  private expireWindow(now: number): void {
    if (this.boot.retryAt === null || now < this.boot.retryAt) return;
    this.boot.retryAt = null;
    const before = this.beforeWindow;
    this.beforeWindow = null;
    if (this.boot.access !== 'rate-limited') return;
    if (this.boot.answered()) {
      this.boot.access = 'ok';
      this.boot.detail = null;
    } else if (before !== null && before.access !== 'ok' && before.access !== 'rate-limited') {
      // The boot is still missing something, and what the window covered said why: a 401 or an outage is still the last thing Jira told us.
      this.boot.access = before.access;
      this.boot.detail = before.detail;
    } else {
      this.boot.access = 'ok';
      this.boot.detail = 'connecting';
    }
  }

  private async sweep(): Promise<void> {
    // Consumed by this tick, before any await, so `armed` cannot read true for a chain whose next link this tick has not created yet.
    this.clearTimer();
    const env = jiraEnv();
    // Unconfigured is the whole "off" state; `unsupported` is final (P5). Neither schedules a successor.
    if (!env.configured || this.boot.access === 'unsupported') return;

    const config = readJiraConfig();
    // Taken next to the read: a force whose generation is at most this was set before the file was read, so this sweep sees the save it asked for.
    const seen = this.forceSeq;
    // Memory hygiene only — every reader filters by the config anyway. An unreadable file prunes nothing: it reads as no boards, and the caches of the
    // boards it still holds must survive until it parses again.
    if (config.unreadable === null) {
      for (const id of [...this.caches.keys()]) if (!config.boards.some((b) => b.id === id)) this.caches.delete(id);
      for (const id of [...this.forced.keys()]) if (!config.boards.some((b) => b.id === id)) this.forced.delete(id);
    }

    // The calls the routes made since the last tick are not this sweep's.
    this.client.takeCalls();
    this.pressCalls = 0;
    try {
      await this.run(env, config, seen);
    } finally {
      // Nor are a mentions press's made WHILE it ran (header): the client's counter cannot tell them apart, so the press counted its own.
      this.sweepCalls = Math.max(0, this.client.takeCalls() - this.pressCalls);
    }
    // Judged after the awaits — see the header: a boot that turned out `unsupported` mid-sweep stops the chain here.
    if (this.owed()) this.schedule();
  }

  private async run(creds: { site: string; email: string; token: string }, config: JiraConfig, seen: number): Promise<void> {
    const now = Date.now();
    this.expireWindow(now);
    if (this.inWindow(now)) return;

    // No board is searched until every boot answer is in — see `identity.ts` for why the sprint field is one of them.
    if (!this.boot.answered()) {
      if (!this.boot.due(now)) return;
      if (!(await this.runBoot(creds))) return;
    }

    const auth: JiraAuth = { ...creds, cloudId: this.boot.cloudId! };
    if (await this.sweepBoards(auth, config, seen)) {
      // Every due board answered, so an earlier board-level `unreachable` is over — and only that verdict: a 429 or a 401 a ROUTE recorded while this sweep
      // awaited is evidence this sweep does not have, and clearing it would read `ok` while the routes are refused (§8: only those two move the state).
      if (this.boot.access === 'unreachable') {
        this.boot.access = 'ok';
        this.boot.detail = null;
      }
    }
    // After the boards, whatever they answered (header): the step applies the window and boot gate itself, so a board 5xx no longer starves it.
    //
    // Riding the tick has a latency cost, accepted on purpose: the check holds `inFlight` for its whole run — one search plus, worst case, a hundred
    // sequential thread reads (every kept ticket with more than the inline 20 comments). A `boardSaved` landing meanwhile waits behind it, can reach its
    // `JIRA_SAVE_SWEEP_WAIT_MS` cap, and answers the save with the new board not yet swept; the sweep still follows the moment the check ends, so this is a
    // slower first fill, never a lost one. The usual check is one call and a few reads, and the alternative — a second chain beside the tick — would split
    // the one gate, the one 429/401 handling and the one CALLS figure this file keeps in one place.
    if (this.mentionsDue(Date.now())) await this.checkMentions(auth);
  }

  /** The board loop. False when it ended early — a window or a 401 met between boards, or a whole-board failure — which leaves `access` as it stands. */
  private async sweepBoards(auth: JiraAuth, config: JiraConfig, seen: number): Promise<boolean> {
    for (const board of config.boards) {
      // A route may have met a 429 while this sweep awaited: honour the window from the next board on.
      if (this.inWindow(Date.now())) return false;
      // ...or a 401: `me` is gone, and no board is searched without it.
      if (!this.boot.answered()) return false;
      if (!this.due(board, Date.now())) continue;
      const force = this.forced.get(board.id);
      if (!(await this.sweepBoard(board, auth))) return false;
      // Spent only by a success on a file read after the save (header): a whole-board failure — a 429 window opening mid-board, a 401, a 5xx — replaced
      // nothing, so the board is still owed, and a save that landed after this sweep read the file is a newer force than the one it just answered.
      if (force !== undefined && force <= seen && this.forced.get(board.id) === force) this.forced.delete(board.id);
    }
    return true;
  }

  // ── the mentions step ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Whether this tick owes a check: never inside a 429 window or with the boot unanswered (a 401 reset `me` — and the JQL is built from it); otherwise
   * forced by the site sweep, never attempted, or `JIRA_MENTIONS_POLL_MS` since the last attempt began.
   */
  private mentionsDue(now: number): boolean {
    if (this.inWindow(now) || !this.boot.answered()) return false;
    if (this.mentionsForced || this.mentionsAttemptAt === null) return true;
    return now - this.mentionsAttemptAt >= JIRA_MENTIONS_POLL_MS;
  }

  /**
   * One mentions check, or the one already running — the in-flight join `tick()` gives the board sweep, kept separately because `mentionsSweepNow` runs it
   * outside a tick. Starting OR joining one spends `mentionsForced`; starting one stamps the attempt (the cadence); ending one stamps `mentionsEndAt`
   * (the floor). Never rejects: an unexpected throw is a failed check, recorded as its detail, and must not take the tick's successor with it. `byPress` is
   * whoever STARTS the check: a tick that joins a press's check adds none of its calls to its figure, and a press that joins a tick's leaves them there.
   */
  private checkMentions(auth: JiraAuth, byPress = false): Promise<void> {
    if (this.mentionsInFlight !== null) {
      // The running check IS the answer to a force raised while it was out: leaving the flag set would send a second search on the next 15 s tick.
      this.mentionsForced = false;
      return this.mentionsInFlight;
    }
    this.mentionsAttemptAt = Date.now();
    this.mentionsForced = false;
    const running = this.runMentions(auth, byPress)
      .catch((err: unknown) => {
        this.mentions = { ...this.mentions, detail: err instanceof Error ? err.message : 'mentions check failed' };
      })
      .finally(() => {
        this.mentionsInFlight = null;
        this.mentionsEndAt = Date.now();
      });
    this.mentionsInFlight = running;
    return running;
  }

  /** `byPress`: started by `mentionsSweepNow`, so every call it sends is counted into `pressCalls` rather than left in a tick's figure (header). */
  private async runMentions(auth: JiraAuth, byPress: boolean): Promise<void> {
    // R7's prune (header): an `answeredAt` older than the window can hide nothing — every mention it covers is out of the window too.
    const horizon = Date.now() - JIRA_MENTIONS_WINDOW_DAYS * 86_400_000;
    for (const [key, at] of this.answeredAt) {
      if (Date.parse(at) < horizon) this.answeredAt.delete(key);
    }
    const me = this.boot.me;
    if (me === null) return;
    // Read once for the whole check, not once per ticket: up to a hundred tickets ask it, and none of them needs a fresher copy than the check's start.
    const config = readJiraConfig();
    const result = await runMentionsCheck({
      client: this.client,
      auth,
      me: me.accountId,
      now: Date.now(),
      boardsOf: (key) => this.boardNamesHolding(key, config),
      refuse: () => {
        if (this.inWindow(Date.now())) return synthetic(429, null);
        // Answering null means the call goes out synchronously after this — the one point both counters move together.
        if (byPress) this.pressCalls += 1;
        return null;
      }
    });
    if (result.ok) {
      // Swapped whole, dismissals NOT applied — `applyDismissals` applies them on read, so a Dismiss that landed while this check was out survives the swap.
      this.mentions = { polledAt: iso(Date.now()), detail: null, truncated: result.truncated, issues: result.issues };
      return;
    }
    const res = result.response;
    // A 401 and a 429 are about the token and the site: the board sweep's handling, so the boot resets or the one shared window opens (a synthesised 429
    // from `refuse` opens nothing — `openWindow` knows it). The mentions rows and detail stay as they are: `access` and `retryAt` already say why.
    if (res.status === 401 || res.status === 429) {
      this.boardFailed(res);
      return;
    }
    this.mentions = { ...this.mentions, detail: detailOf(res) };
  }

  /** The NAMES of the boards (in `jira.json` order) whose cache holds `key` — `boardsHolding`'s ids, named, for the mention row's board chips. */
  private boardNamesHolding(key: string, config: JiraConfig): string[] {
    return config.boards
      .filter((b) => this.caches.get(b.id)?.issues.some((i) => i.key === key) ?? false)
      .map((b) => b.name);
  }

  /** The boot calls still owed, in order, stopping at the first failure. True when the boot is whole afterwards. */
  private async runBoot(creds: { site: string; email: string; token: string }): Promise<boolean> {
    if (this.boot.cloudId === null) {
      const res = await this.client.tenantInfo(creds.site);
      if (!this.bootAnswered(res)) return false;
      const cloudId = res.data?.cloudId;
      if (typeof cloudId !== 'string' || cloudId === '') {
        this.bootFail(null, 'tenant_info carried no cloudId');
        return false;
      }
      this.boot.cloudId = cloudId;
    }
    const auth: JiraAuth = { ...creds, cloudId: this.boot.cloudId };
    // Every later step asks this first: a route may have met a 429 while the step before awaited, and the boot makes no call inside a window (header). No
    // `fail` either — the window already says when to ask again, and the boot resumes from the step it stopped at.
    const windowOpen = (): boolean => this.inWindow(Date.now());

    if (!this.boot.serverInfoOk) {
      if (windowOpen()) return false;
      const res = await this.client.serverInfo(auth);
      // A 404 is what the gateway answers for a site that is not Cloud; a `deploymentType` other than `Cloud` is Server/DC saying so itself. Both are
      // FINAL, so only an explicit answer counts: a 2xx with no `deploymentType` (a proxy's page, a body that did not parse) is a retryable failure.
      const deployment = res.data?.deploymentType;
      if (res.status === 404 || (ok(res) && typeof deployment === 'string' && deployment !== 'Cloud')) {
        this.boot.access = 'unsupported';
        this.boot.detail = UNSUPPORTED;
        return false;
      }
      if (!this.bootAnswered(res)) return false;
      if (deployment !== 'Cloud') {
        this.bootFail(null, 'serverInfo carried no deploymentType');
        return false;
      }
      this.boot.serverInfoOk = true;
    }

    if (this.boot.me === null) {
      if (windowOpen()) return false;
      const res = await this.client.myself(auth);
      if (!this.bootAnswered(res)) return false;
      const accountId = res.data?.accountId;
      if (typeof accountId !== 'string' || accountId === '') {
        this.bootFail(null, 'myself carried no accountId');
        return false;
      }
      this.boot.me = { accountId, name: str(res.data?.displayName) };
    }

    // Only once the gateway's `myself` has answered 200 (P2): a bad token is a 401 at the site too, and would otherwise be recorded as `scoped`. Its own
    // step rather than a tail of the one above, so a window that opens between the two still gets the probe asked when it ends.
    if (!this.boot.tokenProbed && this.boot.me !== null) {
      if (windowOpen()) return false;
      this.boot.tokenProbed = true;
      const probe = await this.client.myselfAtSite(auth);
      this.boot.tokenKind = ok(probe) ? 'classic' : probe.status === 401 ? 'scoped' : null;
    }

    if (!this.boot.fieldsOk) {
      if (windowOpen()) return false;
      const res = await this.client.fields(auth);
      if (!this.bootAnswered(res)) return false;
      const fields = (Array.isArray(res.data) ? res.data : []).filter(
        (f): f is { id: string; name: string; schema?: { custom?: string } } => isObj(f) && typeof f.id === 'string'
      );
      this.boot.sprintField = pickSprintField(fields);
      this.boot.fieldsOk = true;
    }

    // A route 401 during one of the awaits above reset `me`: the boot is not whole, whatever the last call here answered.
    if (!this.boot.answered()) return false;
    this.boot.succeed(Date.now());
    return true;
  }

  /** True on a 2xx; otherwise records the failure (a 429 opens the window rather than the back-off — the window already says when to ask again). */
  private bootAnswered(res: JiraResponse<unknown>): boolean {
    if (ok(res)) return true;
    if (res.status === 429) {
      this.openWindow(res);
      return false;
    }
    this.bootFail(accessOf(res), detailOf(res));
    return false;
  }

  /** `boot.fail`, except inside a 429 window: a boot call that was already out when a route opened one must not overwrite `rate-limited` (header). */
  private bootFail(access: JiraAccess | null, detail: string): void {
    if (this.inWindow(Date.now())) return;
    this.boot.fail(access, detail, Date.now());
  }

  /**
   * The one place a window opens, and the one place it is kept from moving (P1, header): only a 429 Jira sent opens one, and a 429 met while one is in force
   * restamps `last429At` — it is still the last 429 Jira sent — and leaves the stored end, `access` and `detail` alone.
   */
  private openWindow(res: JiraResponse<unknown>): void {
    if (SYNTHETIC.has(res)) return;
    const now = Date.now();
    this.last429At = iso(now);
    // A window that ran out but was not yet expired where it is read restores its verdict first, so the one captured below is not `rate-limited`.
    this.expireWindow(now);
    if (this.inWindow(now)) return;
    const until = now + (res.retryAfter !== null ? res.retryAfter * 1000 : JIRA_RATE_LIMIT_DEFAULT_MS);
    this.beforeWindow = { access: this.boot.access, detail: this.boot.detail };
    this.boot.retryAt = until;
    this.boot.access = 'rate-limited';
    this.boot.detail = `Jira rate limit — retry after ${iso(until)}`;
  }

  /** What a whole-board failure does to the site-level state. The cache is not touched — see the header. */
  private boardFailed(res: JiraResponse<unknown>): false {
    if (res.status === 401) {
      this.boot.reset();
      // Once per streak, as in `routeFailed`: a route that met the 401 while this search awaited has already restarted the boot retry.
      if (this.boot.access !== 'unauthorized') this.boot.fail('unauthorized', detailOf(res), Date.now());
    } else if (res.status === 429) {
      // `openWindow` keeps an open window's end and ignores the synthetic refusal from `pages` (P1).
      this.openWindow(res);
    } else if (!this.inWindow(Date.now())) {
      // Inside a window a route opened while this search was out, `rate-limited` is the newer and more useful verdict.
      this.boot.access = 'unreachable';
      this.boot.detail = detailOf(res);
    }
    return false;
  }

  /**
   * One board: its queries in order, then its roots in order with their walks; deduped by key (first occurrence wins), capped at `JIRA_BOARD_CAP`, and
   * swapped into the cache whole. False when a whole-board failure ended it (and the sweep with it).
   */
  private async sweepBoard(board: JiraBoard, auth: JiraAuth): Promise<boolean> {
    const ctx: MapContext = { site: auth.site, sprintField: this.boot.sprintField, now: Date.now() };
    const seen = new Set<string>();
    const list: JiraIssue[] = [];
    const failures: JiraBoardFailure[] = [];
    const add = (issues: JiraIssue[]): void => {
      for (const issue of issues) {
        if (seen.has(issue.key)) continue;
        seen.add(issue.key);
        list.push(issue);
      }
    };

    for (const q of board.queries) {
      const got = await this.pages(auth, q.jql, ctx, JIRA_QUERY_CAP);
      if (got.failure !== null && wholeBoard(got.failure)) return this.boardFailed(got.failure);
      // A per-entry failure keeps what that entry returned before it; the `failures` row is what stops a partial list reading as a whole one.
      if (got.failure !== null) failures.push({ kind: 'query', id: q.id, message: entryMessage(got.failure) });
      add(got.issues);
    }

    for (const root of board.roots) {
      const got = await this.walk(auth, root, ctx);
      if (got.failure !== null && wholeBoard(got.failure)) return this.boardFailed(got.failure);
      if (got.failure !== null) failures.push({ kind: 'root', id: root, message: entryMessage(got.failure) });
      else if (got.unknown) failures.push({ kind: 'root', id: root, message: `Jira knows no issue ${root}` });
      add(got.issues);
    }

    this.caches.set(board.id, {
      issues: this.keepNewer(board.id, list.slice(0, JIRA_BOARD_CAP)),
      // The instant the board's last call answered.
      polledAt: iso(Date.now()),
      truncated: list.length > JIRA_BOARD_CAP,
      failures
    });
    return true;
  }

  /**
   * Newest `updated` wins (plan R5, Review Focus 3): an issue the sweep returned is swapped for the copy this board's cache holds when the cached one's
   * `updated` is STRICTLY newer. That copy is a splice — a write landed and was re-read — and the sweep's is older for one of two reasons: it was read
   * before the write (a sweep in flight across it), or Jira's search index had not caught up (the re-read is `GET issue`, which reads the issue itself; the
   * search lags it). Either way putting it back would undo the card the person just moved, until a later sweep put it right again.
   *
   * The cache is read HERE, at the end of the sweep, not when it started: a splice that landed while this sweep awaited is exactly the case. Equal, or
   * unparseable on either side, is the sweep's copy — the rule needs evidence the cached copy is newer, and the sweep's is otherwise the authority on the
   * board. It only replaces: membership is the sweep's, so a key the sweep did not return is gone as before — a lagging index can drop a just-assigned issue
   * from an `assignee = currentUser()` board for one sweep, accepted (R5).
   */
  private keepNewer(boardId: string, issues: JiraIssue[]): JiraIssue[] {
    const held = this.caches.get(boardId)?.issues;
    if (held === undefined || held.length === 0) return issues;
    const byKey = new Map(held.map((i) => [i.key, i]));
    return issues.map((swept) => {
      const cached = byKey.get(swept.key);
      if (cached === undefined) return swept;
      const a = Date.parse(cached.updated);
      const b = Date.parse(swept.updated);
      return !Number.isNaN(a) && !Number.isNaN(b) && a > b ? cached : swept;
    });
  }

  /**
   * After a write that LANDED: one `GET issue/{key}` with the sweep's fields, mapped with the sweep's context (`now: Date.now()`, the Done window on — this
   * copy goes into the board's cache, where the sweep's rule holds), and swapped IN PLACE into every board cache that already holds the key (R4). It never
   * adds the key to a board: membership is the board's queries' and roots' business, and a splice that added would let a write put an issue on a board
   * whose JQL excludes it. Each touched cache is replaced whole with its `polledAt` unmoved — a splice is one issue, not a sweep, and the age says how old
   * the LIST is.
   *
   * True when the re-read came back as an issue (whether or not any cache held it, and whether or not the window dropped it); false otherwise, with every
   * cache untouched (R1, Review Focus 5). A failure still goes through `routeFailed`, so a 401 or a 429 here moves the site state as any read's does — but
   * the write's answer stays ok: it happened. A window opened while the write was out refuses the re-read up front, like any read.
   */
  private async splice(auth: JiraAuth, key: string): Promise<boolean> {
    if (this.windowRefusal() !== null) return false;
    const res = await this.client.issue(auth, key, this.sweepFields());
    if (!ok(res)) {
      this.routeFailed(res);
      return false;
    }
    const ctx: MapContext = { site: auth.site, sprintField: this.boot.sprintField, now: Date.now() };
    const issue = mapJiraIssue(res.data, ctx);
    // Null for two reasons: the body is not an issue (no re-read worth the name), or the Done window dropped it — a good read that this server would not
    // show on a board, so no cache takes it, and the next sweep drops the old copy the same way.
    if (issue === null) return mapJiraIssue(res.data, { ...ctx, now: null }) !== null;
    for (const [id, cache] of this.caches) {
      if (!cache.issues.some((i) => i.key === key)) continue;
      this.caches.set(id, { ...cache, issues: cache.issues.map((i) => (i.key === key ? issue : i)) });
    }
    return true;
  }

  /**
   * A root and its descendants: `key = "K"`, then `JIRA_DESCENDANT_ROUNDS` rounds of `parent in (…)` over every key the previous round RETURNED (mapped or
   * dropped by the Done window), stopping early at `JIRA_ROOT_CAP` kept issues or an empty round. A root Jira answers with no issue at all is `unknown`
   * (P3 — Jira says 200 with nothing for a key it does not know); a root the window dropped is not unknown, and its walk still runs.
   */
  private async walk(auth: JiraAuth, root: string, ctx: MapContext): Promise<Pages & { unknown: boolean }> {
    const first = await this.pages(auth, `key = ${jqlString(root)}`, ctx, JIRA_ROOT_CAP);
    if (first.failure !== null) return { ...first, unknown: false };
    if (first.raw.length === 0) return { ...first, unknown: true };
    const issues = [...first.issues];
    let parents = first.raw;
    for (let round = 0; round < JIRA_DESCENDANT_ROUNDS && parents.length > 0 && issues.length < JIRA_ROOT_CAP; round++) {
      const got = await this.pages(auth, `parent in (${parents.map(jqlString).join(', ')})`, ctx, JIRA_ROOT_CAP - issues.length);
      issues.push(...got.issues);
      if (got.failure !== null) return { raw: [], issues, failure: got.failure, unknown: false };
      parents = got.raw;
    }
    return { raw: [], issues, failure: null, unknown: false };
  }

  /**
   * One JQL, paged by `nextPageToken`, until `room` issues are kept, Jira says `isLast`, or a page names no next token — a page claiming `isLast: false`
   * with no token ends the walk there rather than asking for the first page again forever (Review Focus 3).
   */
  private async pages(auth: JiraAuth, jql: string, ctx: MapContext, room: number): Promise<Pages> {
    const raw: string[] = [];
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    while (issues.length < room) {
      // A route may have opened a 429 window while this walk awaited; the sweep makes no call inside it (the header).
      if (this.inWindow(Date.now())) return { raw, issues: issues.slice(0, room), failure: synthetic(429, null) };
      const res = await this.client.search(auth, { jql, fields: this.sweepFields(), maxResults: JIRA_PAGE_SIZE, nextPageToken });
      if (!ok(res)) return { raw, issues: issues.slice(0, room), failure: res };
      const page = Array.isArray(res.data?.issues) ? res.data.issues : [];
      for (const r of page) {
        if (isObj(r) && typeof r.key === 'string') raw.push(r.key);
        const issue = mapJiraIssue(r, ctx);
        if (issue !== null) issues.push(issue);
      }
      const next = res.data?.nextPageToken;
      if (res.data?.isLast !== false || typeof next !== 'string' || next === '') break;
      nextPageToken = next;
    }
    return { raw, issues: issues.slice(0, room), failure: null };
  }

  /** The sweep's field list (§4) plus the discovered sprint field, when the site has one. */
  private sweepFields(): string[] {
    return this.boot.sprintField === null ? [...JIRA_ISSUE_FIELDS] : [...JIRA_ISSUE_FIELDS, this.boot.sprintField];
  }

  /** The union of project keys on the cached boards and the mapped keys, sorted; a name from a cached issue when there is one, else the key. */
  private projectsOf(config: JiraConfig): JiraProjectRef[] {
    const names = new Map<string, string>();
    for (const board of config.boards) {
      for (const issue of this.caches.get(board.id)?.issues ?? []) if (!names.has(issue.project.key)) names.set(issue.project.key, issue.project.name);
    }
    for (const key of Object.keys(config.repos)) if (!names.has(key)) names.set(key, key);
    return [...names]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // ── the fresh reads' shared edges ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Whether a fresh read may be sent, and with what. Refused with NO call: inside a 429 window (the stored instant, P1); before boot has a `cloudId` — there
   * is no gateway path to ask — answering from the boot state (P3: a 401 state is the 401, anything else `unreachable` with the boot's detail); and for an
   * `unsupported` site, which no read can change. Unconfigured never reaches here past the routes (they answer 503 first), but is refused all the same.
   */
  private gate(): { auth: JiraAuth } | { refused: JiraRefusal } {
    const env = jiraEnv();
    if (!env.configured) return { refused: { ok: false, response: synthetic(0, env.detail) } };
    const inWindow = this.windowRefusal();
    if (inWindow !== null) return { refused: inWindow };
    if (this.boot.access === 'unsupported') return { refused: { ok: false, response: synthetic(0, UNSUPPORTED), access: 'unsupported' } };
    if (this.boot.cloudId === null) {
      const detail = this.boot.detail ?? 'connecting';
      return { refused: { ok: false, response: this.boot.access === 'unauthorized' ? synthetic(401, detail) : synthetic(0, detail) } };
    }
    return { auth: { site: env.site, email: env.email, token: env.token, cloudId: this.boot.cloudId } };
  }

  /**
   * R2's first half, for both issue writes: while `access` is `unauthorized` the credentials are known bad, so a write is refused with no call, as the 401 it
   * would meet — synthesised, so `jiraHttpError` answers the 401 body and the boot's back-off is not doubled by a refusal Jira never sent. Checked on
   * `access`, not on `me`: a 401 on the boot's `field` call leaves `me` set and the credentials just as bad. Config writes do not ask this (§8).
   */
  private unauthorizedRefusal(): JiraRefusal | null {
    if (this.boot.access !== 'unauthorized') return null;
    return { ok: false, response: synthetic(401, this.boot.detail ?? 'Jira rejected the credentials') };
  }

  /** The refusal a read gets inside a 429 window — a synthesised 429 and the STORED instant (P1) — or `null` when none is in force. */
  private windowRefusal(): JiraRefusal | null {
    this.expireWindow(Date.now());
    if (!this.inWindow(Date.now())) return null;
    return { ok: false, response: synthetic(429, null), retryAt: iso(this.boot.retryAt!) };
  }

  /**
   * A fresh read's failure. Only a 401 (the credentials stopped working: `me` reset, the boot retry restarts) and a 429 (the window opens) move the
   * site-level state; a 0, 5xx, 400, 403 or 404 on a route answers its mapping and leaves `access` to the sweep (§8).
   */
  private routeFailed(res: JiraResponse<unknown>): JiraRefusal {
    if (res.status === 401) {
      this.boot.reset();
      // Once per streak: a read refused again while already `unauthorized` must not double the back-off and slide the boot's retry out to the cap.
      if (this.boot.access !== 'unauthorized') this.boot.fail('unauthorized', detailOf(res), Date.now());
      this.wake();
    }
    if (res.status === 429) {
      this.openWindow(res);
      // The stored end on every 429 path (P1) — the one this 429 opened, or the one already in force that it did not move. A synthesised 429 whose window
      // has somehow ended carries none, and `jiraHttpError` falls back to the default.
      return this.boot.retryAt === null ? { ok: false, response: res } : { ok: false, response: res, retryAt: iso(this.boot.retryAt) };
    }
    return { ok: false, response: res };
  }
}
