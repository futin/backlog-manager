import { unwrap } from './agents';
import { parseReviewConfig } from '../../../shared/agent';
import type { ReviewConfig, ReviewSetting, TimeZoneSetting } from '../../../shared/types';

/**
 * settings-api.ts — the board-wide display settings stored on the API host (#241). Today one: the shared time zone, `settings/timezone.json`.
 *
 * Its own file rather than beside `fetchWatchdog` in `lib/agents.ts`: that file is the dashboard calls and the watchdog, and a display preference read by
 * every surface on the board has nothing to do with either.
 */

/** A body is a `TimeZoneSetting` when `timeZone` is a string or `null` — anything else fails the read rather than drawing a zone that is not one. */
function isTimeZoneSetting(data: unknown): data is TimeZoneSetting {
  if (typeof data !== 'object' || data === null) return false;
  const tz = (data as TimeZoneSetting).timeZone;
  return tz === null || typeof tz === 'string';
}

/** `GET /api/settings/timezone` — unguarded, a plain GET. */
export async function fetchTimeZone(): Promise<TimeZoneSetting> {
  const data = await unwrap<TimeZoneSetting>(await fetch('/api/settings/timezone'));
  if (!isTimeZoneSetting(data)) throw new Error('malformed /api/settings/timezone response');
  return data;
}

/**
 * `POST /api/settings/timezone` — the Settings card's one write path. A refusal rejects with the server's own `error` sentence (`unwrap`), exactly as
 * `updateWatchdogConfig` does, and the answer is the CANONICAL id the server wrote, which the caller shows instead of what it sent.
 */
export async function updateTimeZone(timeZone: string | null): Promise<TimeZoneSetting> {
  const data = await unwrap<TimeZoneSetting>(
    await fetch('/api/settings/timezone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeZone }) })
  );
  if (!isTimeZoneSetting(data)) throw new Error('malformed /api/settings/timezone response');
  return data;
}

/**
 * `GET /api/settings/review` — the reviewer config (reviewer coverage task 11), `settings/review.json` on the API host. The body is the config plus an
 * optional `fileError: true` (the file exists but could not be read, so the server answered its defaults). Validated with the same strict
 * `parseReviewConfig` the server and the skill's twin use, after `fileError` is set aside: a body the board cannot read as a config fails the read rather than
 * drawing pickers over a shape nobody wrote.
 */
export async function fetchReviewSetting(): Promise<ReviewSetting> {
  const data = await unwrap<unknown>(await fetch('/api/settings/review'));
  if (typeof data !== 'object' || data === null) throw new Error('malformed /api/settings/review response');
  const { fileError, ...rest } = data as Record<string, unknown>;
  const parsed = parseReviewConfig(rest);
  if (!parsed.ok) throw new Error('malformed /api/settings/review response');
  return fileError === true ? { ...parsed.config, fileError: true } : parsed.config;
}

/**
 * `POST /api/settings/review` — the Settings card's one write path. A refusal rejects with the server's own `error` sentence
 * (`invalid review config: <member>`), and the answer is the config the server wrote, which the caller shows instead of what it sent — `updateTimeZone`'s
 * contract.
 */
export async function updateReviewSetting(config: ReviewConfig): Promise<ReviewConfig> {
  const data = await unwrap<unknown>(
    await fetch('/api/settings/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
  );
  const parsed = parseReviewConfig(data);
  if (!parsed.ok) throw new Error('malformed /api/settings/review response');
  return parsed.config;
}
