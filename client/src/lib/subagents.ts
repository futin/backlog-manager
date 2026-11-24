import { isOrphan, subagentState } from '../../../shared/agent';
import type { SubagentDetail, SubagentJob, SubagentState } from '../../../shared/types';
import type { PillTone } from '../components/ui/Pill';
import { errorOf } from './http';

/**
 * The words and tones the subagent list draws (#611, spec docs/superpowers/specs/2026-11-24-subagent-visibility-design.md, "Copy"). Every string here is the
 * spec's copy table verbatim, and every derivation pure with `nowMs` passed in, so the list, its tests and any later surface word one subagent one way.
 *
 * What a state MEANS is `shared/agent.ts`'s (`subagentState`, `isOrphan`, `waitingOnSubagent`) — the server proxies the facts and must never grow a second
 * reading of them. This file only says how a state, a duration and a row are worded on the board, which is why it lives in `client/src/lib/` and not there.
 */

/** The summary's state order: the live readings first, worst-live before the finished ones, so the line reads "what is moving, then what stopped". */
const STATE_ORDER: readonly SubagentState[] = ['working', 'quiet', 'stuck', 'blocked', 'killed', 'ended'];

/**
 * One tone per state, from Pill's five readings: `working` is something running, `quiet` a plain count (silence under the stuck line is not yet a
 * problem), `stuck` waits on a person, `blocked` and `killed` are failures, `ended` is finished.
 */
export const SUBAGENT_STATE_TONE: Record<SubagentState, PillTone> = {
  working: 'live',
  quiet: 'neutral',
  stuck: 'warn',
  blocked: 'bad',
  killed: 'bad',
  ended: 'done'
};

/** The dashboard's `blockedReason` in the words drawn after the row's pill. */
export const SUBAGENT_REASON_WORD: Record<NonNullable<SubagentJob['blockedReason']>, string> = {
  'rate-limit': 'rate limit',
  rejected: 'tool use rejected',
  interrupted: 'interrupted'
};

/** The `orphan` tag's title: what the tag means and why it matters, since the tag alone does not say nothing will wake the parent. */
export const SUBAGENT_ORPHAN_TITLE = 'background agent whose parent process is gone — nothing will wake the parent when it stops';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * A subagent's duration at the scale a subagent lives at: `<1m`, `3m`, `1h 12m`, `2d 4h`, and `—` for an absent or unusable one. Seconds are dropped on
 * purpose — the list re-renders on a 10 s poll, so a seconds reading would jump ten at a time — and every rung keeps two units at most.
 */
export function subagentDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < MIN) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`;
  return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
}

/** Milliseconds from an ISO stamp to `untilMs`, or `null` when the stamp is absent or does not parse — never `NaN` into the DOM. */
function since(iso: string | null | undefined, untilMs: number): number | null {
  if (iso == null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : untilMs - t;
}

/** `<n> subagent(s)` then `· <k> <state>` for each state present, in `STATE_ORDER`. */
export function subagentSummary(detail: SubagentDetail, nowMs: number): string {
  const n = detail.agents.length;
  const counts = new Map<SubagentState, number>();
  for (const job of detail.agents) {
    const s = subagentState(job, nowMs);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const parts = [`${n} ${n === 1 ? 'subagent' : 'subagents'}`];
  for (const s of STATE_ORDER) {
    const k = counts.get(s);
    if (k) parts.push(`${k} ${s}`);
  }
  return parts.join(' · ');
}

/** The parent's badge words for `waitingOnSubagent`'s answer; `null` draws nothing. */
export function subagentBadge(w: 'waiting' | 'waiting-blocked' | null): string | null {
  if (w === 'waiting') return 'waiting on subagent';
  if (w === 'waiting-blocked') return 'waiting on a blocked subagent';
  return null;
}

export interface SubagentRowFacts {
  state: SubagentState;
  tone: PillTone;
  /** The description, else the type, else `subagent`. */
  label: string;
  /** `type · fg|bg · model`, each part omitted when absent — `''` when all three are. */
  meta: string;
  /** A running job's age since it started; a finished one's `ran <duration>`. */
  age: string;
  /** Time since the transcript was last written — `—` with no stamp, `null` for a finished job, which draws none. */
  sinceWrite: string | null;
  /** The last tool call as the dashboard sent it; `null` draws nothing. */
  lastTool: string | null;
  /** A blocked job's reason in words, else `null`. */
  reason: string | null;
  orphan: boolean;
}

/** Everything one row of the list draws, worded. */
export function subagentRowFacts(job: SubagentJob, detail: SubagentDetail, nowMs: number): SubagentRowFacts {
  const state = subagentState(job, nowMs);
  const finished = state === 'ended' || state === 'killed';
  const meta = [job.type || null, job.background === true ? 'bg' : job.background === false ? 'fg' : null, job.model || null]
    .filter((p): p is string => p !== null)
    .join(' · ');
  let age: string;
  if (finished) {
    // `durationMs` is the dashboard's own measure and wins; the stamps are the fallback for a row that carries none.
    const ran = job.durationMs ?? (job.endedAt == null ? null : since(job.startedAt, Date.parse(job.endedAt)));
    age = `ran ${subagentDuration(ran !== null && Number.isNaN(ran) ? null : ran)}`;
  } else {
    age = subagentDuration(since(job.startedAt, nowMs));
  }
  return {
    state,
    tone: SUBAGENT_STATE_TONE[state],
    label: job.description || job.type || 'subagent',
    meta,
    age,
    sinceWrite: finished ? null : subagentDuration(since(job.lastWriteAt, nowMs)),
    lastTool: job.lastTool ?? null,
    reason: state === 'blocked' && job.blockedReason != null ? SUBAGENT_REASON_WORD[job.blockedReason] : null,
    orphan: isOrphan(job, detail)
  };
}

/**
 * `GET /api/agents/sessions/:id/subagents`, fresh — the route caches nothing and neither does this. Rejects with the route's own `error` sentence (the 400,
 * 404, 409 and 502 words are the spec's copy, drawn verbatim), `HTTP <status>` for a body without one, and `malformed response` for a 200 with no `agents`
 * array, so a render never maps over something that is not a list.
 */
export async function fetchSubagents(sessionId: string): Promise<SubagentDetail> {
  const res = await fetch(`/api/agents/sessions/${encodeURIComponent(sessionId)}/subagents`);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorOf(body, `HTTP ${res.status}`));
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { agents?: unknown }).agents)) throw new Error('malformed response');
  return body as SubagentDetail;
}
