import { Segmented, SettingsGroup, SettingsRow } from './SettingsRow';
import { useAgents } from '../../hooks/useAgents';
import { useSettings } from '../../hooks/useSettings';
import { FONT_SCALES, THEMES, type Landing, type ThemeId } from '../../lib/settings';
import { EFFORTS, MODELS } from '../../../../shared/agent';
import type { AgentsStatus } from '../../../../shared/types';

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

/**
 * One line per gate, in the order dispatchBlock (shared/agent.ts) checks
 * them, so the first red dot named here is also the thing worth fixing
 * first. Read-only: every one of these gates lives on a host — in this
 * API's env or in the dashboard's — and a switch here that wrote to a
 * browser's localStorage would just be a lie about where the setting is.
 */
// No wrapping `<span className="set-hint">` here on purpose: every caller
// passes this straight into `SettingsRow`'s `hint` prop, which already wraps
// its child in that exact span (`SettingsRow.tsx`). Wrapping it again here
// nested a `.set-hint` inside a `.set-hint` — harmless (the class sets no
// compounding properties) but redundant, so this returns bare content and
// lets the row supply the class once.
function AgentsStatusLines({ status }: { status: AgentsStatus | null }) {
  if (status === null) return <>checking…</>;
  if (!status.enabled) return <>● off — dispatch is not enabled on the API</>;
  if (!status.reachable) {
    return <>● unreachable{status.error ? ` — ${status.error}` : ''}</>;
  }
  const gaps = [
    status.spawnAvailable ? null : 'no CLAUDE_BIN',
    status.remoteAnswer ? null : 'remote answers off'
  ].filter((g): g is string => g !== null);
  return (
    <>
      ● connected{gaps.length > 0 ? ` — ${gaps.join(', ')}` : ' · spawn on'}
      {' · '}ceiling: {status.spawnMaxPermission ?? 'unknown'}
      {' · '}{status.projectPaths.length} projects
    </>
  );
}

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

      <AgentsGroup />
    </div>
  );
}

/**
 * The integration's only editable field is the link base, because it is the
 * only part of it that is genuinely per-device: the API's own outbound call
 * uses BM_AGENTS_URL on the host, and the bearer token must never be in a
 * browser at all. Everything else here is a report on where that host config
 * currently stands.
 */
function AgentsGroup() {
  const { settings, update } = useSettings();
  const { status } = useAgents();
  const healthy =
    status !== null && status.enabled && status.reachable &&
    status.spawnAvailable && status.remoteAnswer;

  return (
    <SettingsGroup title="Claude Agents · this machine">
      <SettingsRow name="Dispatch" hint={<AgentsStatusLines status={status} />}>
        <a className="sheet-link" href={settings.linkBase} target="_blank" rel="noreferrer">
          open dashboard ↗
        </a>
      </SettingsRow>

      {/* The two picker defaults, copied from the dashboard's own "New sessions
          · this device" group. They live here rather than in a group of their
          own because the reader arrives at this group to ask "how does dispatch
          behave on this device", and the answer is these three rows. Deliberately
          NOT gated on `healthy`: a default is worth setting before the
          integration works, and hiding the rows while it is down would read as
          the setting having been lost. */}
      <SettingsRow
        name="Default model"
        hint="Preselected in a card's launch sheet. “CLI default” sends no --model flag and lets Claude Code pick. Overridable per launch."
      >
        <select
          aria-label="Default model"
          value={settings.dispatchDefaultModel}
          onChange={(e) => update({ dispatchDefaultModel: e.target.value })}
        >
          <option value="">CLI default</option>
          {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </SettingsRow>

      <SettingsRow
        name="Default effort"
        hint="Preselected in a card's launch sheet. “CLI default” sends no --effort flag."
      >
        <select
          aria-label="Default effort"
          value={settings.dispatchDefaultEffort}
          onChange={(e) => update({ dispatchDefaultEffort: e.target.value })}
        >
          <option value="">CLI default</option>
          {EFFORTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </SettingsRow>

      <SettingsRow
        name="Dashboard link"
        hint="Where THIS device reaches the dashboard — the laptop on loopback, a phone on its tailnet name. Used only for the link; the API calls it over BM_AGENTS_URL."
      >
        <input
          type="text"
          aria-label="Dashboard link"
          defaultValue={settings.linkBase}
          // Re-seed on commit, same idiom and same reason as `NumberField`
          // (`SettingsRow.tsx`): this field's own commit path can rewrite
          // what was typed into a different canonical value — `clampOrigin`
          // (client/src/lib/settings.ts) strips a trailing slash, or falls
          // back to the default outright on a rejected scheme. Without this
          // key the box is a `defaultValue`-only input React never touches
          // again after mount, so it would go on showing the untouched
          // keystrokes forever — silently disagreeing with what is actually
          // stored and about to be used as the "open dashboard" href.
          key={settings.linkBase}
          onBlur={(e) => update({ linkBase: e.currentTarget.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </SettingsRow>

      {/* Gated on an actual answer, not bare `!healthy`: `healthy` starts
          false the instant `status` is still `null` (its own `status !==
          null` check fails first), which would fold "not answered yet" into
          "broken" and tell the reader to go edit their .env while the status
          line above still correctly says "checking…". */}
      {status !== null && !healthy && (
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Setting it up</span>
            <span className="set-hint">
              1 · <code>BM_AGENTS=on</code> and <code>BM_AGENTS_URL</code> in this app's <code>.env</code>, then restart the API.<br />
              2 · <code>CLAUDE_BIN</code> in the dashboard's <code>.env</code> — that is its spawn gate.<br />
              3 · Turn its remote-answer pill on; spawning is refused without it.<br />
              4 · Run its <code>pnpm hooks:install</code>, or a groom that asks you a question will stall with nowhere to ask.<br />
              5 · A project needs one Claude session inside the dashboard's <code>LOOKBACK_HOURS</code> before it can be dispatched to — open one there, or raise <code>LOOKBACK_HOURS</code> in the dashboard's <code>.env</code>.
            </span>
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
