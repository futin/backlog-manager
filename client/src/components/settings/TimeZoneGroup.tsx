import { useMemo } from 'react';

import { useTimeZone } from '../../hooks/TimeZoneContext';
import { timeZoneOptions } from '../../lib/time-zone';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Select } from '../ui/Select';

/**
 * The shared time zone's Settings card (#241; drawn to `.claude/DESIGN.md` §8.6 — a `SettingsGroup` of one `SettingsRow` and its 36 px `Select`, the
 * composition `TickGroup` makes of its one knob). One knob: which zone every clock, day group, week window and created date on the board is read in.
 *
 * It sits on the SHARED page because the value is a file on the API host (`~/.backlog-manager/settings/timezone.json`), so a phone, a laptop and a tailnet
 * browser that open this board read — and edit — the same one zone. That is the whole point of the setting: a per-browser zone was what let two devices
 * disagree about when a run started and which day it belongs to. The scope reads `this server`, the watchdog's word, because what the setting binds is every
 * browser this server answers, not the machine's own clock.
 *
 * The first option is "unset" — the empty string here, `null` on the wire — labelled with THIS browser's zone, so a reader can see what unset means on the
 * device in front of them. A Select over the platform's own list, never a free-text field: the server refuses an id it cannot canonicalise with a 400, and a
 * list leaves nothing on offer the server would have to refuse. `timeZoneOptions(stored)` splices a stored zone this browser does not list back in, so the
 * Select never silently reads as the first option for a value the server holds.
 *
 * A save redraws from the POST's own answer (the provider's contract), so `etc/utc` shows as `UTC`; a refused save keeps the server's value on screen and says
 * so in one `role="alert"` row, the wording `TickGroup` and `WatchdogGroup` use.
 */
export function TimeZoneGroup() {
  const { stored, browser, save, saveError } = useTimeZone();
  // `Intl.supportedValuesOf` is a ~400-entry list; built once per stored value rather than on every render of the Settings page.
  const options = useMemo(
    () => [{ value: '', label: `Each browser's own (${browser})` }, ...timeZoneOptions(stored).map((z) => ({ value: z, label: z }))],
    [stored, browser]
  );

  return (
    <SettingsGroup title="Time zone" scope="this server">
      <SettingsRow
        name="Time zone"
        hint={
          <>
            Stored in <code>~/.backlog-manager/settings/timezone.json</code> on the API host — every clock, day group, week range and created date reads
            it, on whichever phone or laptop opens the board. Unset, each browser uses its own zone.
          </>
        }
      >
        <Select label="Time zone" value={stored ?? ''} options={options} onChange={(v) => void save(v === '' ? null : v)} />
      </SettingsRow>
      {saveError !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">Not saved — {saveError}. The value shown is the one still on the server.</span>
        </div>
      )}
    </SettingsGroup>
  );
}
