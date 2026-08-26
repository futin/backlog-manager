import { Segmented, SettingsGroup, SettingsRow } from './SettingsRow';
import { useSettings } from '../../hooks/useSettings';
import { FONT_SCALES, THEMES, type Landing, type ThemeId } from '../../lib/settings';

/**
 * Preview colors per theme — board / strip / accent, in that order. A mirror of
 * the `[data-theme]` blocks in shared/theme.css, kept here because it is
 * presentation: the swatch has to paint a palette that is NOT currently applied,
 * so it cannot read the live custom properties.
 */
const SWATCHES: Record<ThemeId, [string, string, string]> = {
  midnight: ['#0c1220', '#182238', '#55d0dd'],
  graphite: ['#111214', '#1f2124', '#6fc5cf'],
  amber: ['#0a0805', '#1a150c', '#ffb03a'],
  nightshift: ['#07120d', '#12251b', '#4fe09a'],
  daylight: ['#e8e3d7', '#fbf8f1', '#136d78']
};

const DENSITIES = [
  { value: 'comfortable' as const, label: 'Comfortable' },
  { value: 'compact' as const, label: 'Compact' }
];

/**
 * The landing choices, with copy rather than section ids. "Last used" is
 * first because it is the default and reads as the absence of a choice; the two
 * named sections below it are the override.
 */
const LANDINGS: { value: Landing; label: string }[] = [
  { value: 'last', label: 'Last used' },
  { value: 'projects', label: 'Projects' },
  { value: 'settings', label: 'Settings' }
];

/** The Settings section: this device only (localStorage). */
export default function SettingsView() {
  const { settings, update } = useSettings();

  return (
    <div className="set">
      <SettingsGroup title="Display · this device">
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Theme</span>
            <span className="set-hint">{THEMES.find((t) => t.id === settings.theme)?.hint}</span>
          </div>
        </div>
        <div className="set-themes" style={{ marginTop: 5 }}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={t.id === settings.theme ? 'set-theme on' : 'set-theme'}
              aria-pressed={t.id === settings.theme}
              onClick={() => update({ theme: t.id })}
            >
              <span className="set-swatch">
                <i style={{ background: SWATCHES[t.id][0] }} />
                <i style={{ background: SWATCHES[t.id][1] }} />
                <i style={{ background: SWATCHES[t.id][2] }} />
              </span>
              <span className="set-theme-name">{t.label}</span>
            </button>
          ))}
        </div>

        <SettingsRow
          name="Density"
          hint="Compact tightens padding and the gaps between cards — more items per screen."
        >
          <Segmented
            value={settings.density}
            options={DENSITIES}
            onChange={(density) => update({ density })}
          />
        </SettingsRow>

        <SettingsRow
          name="Text size"
          hint="Scales the whole board, not just type — the rail, the cards and the spacing move with it."
        >
          <Segmented
            value={settings.fontScale}
            options={FONT_SCALES.map((v) => ({ value: v, label: `${v}%` }))}
            onChange={(fontScale) => update({ fontScale })}
          />
        </SettingsRow>

        <SettingsRow
          name="Opens on"
          hint="Which section this device lands on when you load the page."
        >
          <select
            value={settings.landing}
            aria-label="Opens on"
            onChange={(e) => update({ landing: e.target.value as Landing })}
          >
            {LANDINGS.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
