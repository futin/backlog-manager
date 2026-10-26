import { unwrap } from './agents';
import type { TimeZoneSetting } from '../../../shared/types';

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
