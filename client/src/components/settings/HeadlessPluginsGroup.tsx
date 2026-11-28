import { useState } from 'react';

import { useHeadlessSetting } from '../../hooks/useHeadlessSetting';
import { HEADLESS_LOCKED_PLUGIN, addHeadlessPlugin, headlessChips, removeHeadlessPlugin } from '../../lib/headless-plugins';
import { Chip } from '../ui/Chip';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Switch } from '../ui/Switch';
import type { HeadlessConfig } from '../../../../shared/types';

/**
 * The orchestrator's plugin allowlist (#625; drawn to `.claude/DESIGN.md` §8.6 — a `SettingsGroup` of `SettingsRow`s, `ReviewerGroup`'s composition). Which
 * plugins a per-item session an orchestrator run launches still loads; every other enabled plugin is switched off for that one session, because each one's
 * skills, hooks and agents ride in a preamble a headless execute pays on every turn and never uses.
 *
 * On the SHARED page with the `this machine` pill: the value is `~/.backlog-manager/settings/headless.json` on the API host, which `orchestrate.mjs
 * headless-settings` reads at each launch — one setting per machine, not per browser. `backlog-manager` is drawn first and locked, because the tool keeps it
 * whatever the list says (the session's own `/backlog-execute` lives in it); a desktop app's `@builtin` plugins are never switched off either, and the note says
 * so rather than listing them, since `claude plugin list` does not report them.
 *
 * Saves on every change (`useHeadlessSetting.save`) and disables its controls while a save is out, so at most one POST is in flight and the card always shows
 * the server's answer. A name that fails the shape is refused inline — the field turns red and nothing is sent. An `unreadable` source disables every control
 * and names the file, `TickGroup`'s pattern: the server refuses to write over a file it could not read (409), so offering edits would only fail.
 */
export function HeadlessPluginsGroup() {
  const { status, setting, loadError, saving, save, saveError } = useHeadlessSetting();
  const [typed, setTyped] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  if (setting === null) {
    return (
      <SettingsGroup title="Orchestrator plugins" pill="this machine">
        <div className="set-row set-row-stacked">
          <div className="set-label">
            <span className="set-name">{status === 'failed' ? 'Unavailable' : 'Loading'}</span>
            {status === 'failed' && (
              <span className="set-hint">
                Could not read the plugin list{loadError ? ` — ${loadError}` : ''}. This group will fill in once the API answers{' '}
                <code>GET /api/settings/headless</code> again.
              </span>
            )}
          </div>
        </div>
      </SettingsGroup>
    );
  }

  const { config, source } = setting;
  const locked = source === 'unreadable';
  const disabled = locked || saving;
  const why = locked ? 'headless.json could not be read — fix or remove it by hand' : undefined;
  const commit = (next: HeadlessConfig) => void save(next);

  const add = () => {
    const result = addHeadlessPlugin(config.plugins, typed);
    if (!result.ok) {
      setAddError(result.error);
      return;
    }
    setAddError(null);
    setTyped('');
    if (result.plugins.length !== config.plugins.length) commit({ ...config, plugins: result.plugins });
  };

  return (
    <SettingsGroup title="Orchestrator plugins" pill="this machine">
      {locked && (
        <div className="set-row">
          <span className="set-hint">
            <code>~/.backlog-manager/settings/headless.json</code> exists but could not be read, so runs trim nothing. Fix or remove it by hand.
          </span>
        </div>
      )}
      <SettingsRow name="Trim plugins in orchestrator sessions" hint="Each item's session loads only the plugins listed below.">
        <Switch
          checked={config.enabled}
          label="Trim plugins in orchestrator sessions"
          disabled={disabled}
          title={why}
          onChange={(enabled) => commit({ ...config, enabled })}
        />
      </SettingsRow>
      <SettingsRow
        name="Kept plugins"
        hint="A desktop app's @builtin plugins are never switched off."
        more="A name matches a plugin by its bare name (superpowers) or its full id (superpowers@claude-plugins-official). backlog-manager is always kept: the session's own /backlog-execute lives in it."
        stacked
      >
        <div className="set-plugins">
          {headlessChips(config.plugins).map((name) =>
            name === HEADLESS_LOCKED_PLUGIN ? (
              <Chip key={name} variant="flat" size={28} disabled title="Always kept — the session's own skill lives in it">
                {name} · locked
              </Chip>
            ) : (
              <Chip
                key={name}
                size={28}
                disabled={disabled || !config.enabled}
                title={why}
                aria-label={`Remove ${name}`}
                onClick={() => commit({ ...config, plugins: removeHeadlessPlugin(config.plugins, name) })}
              >
                {name} ×
              </Chip>
            )
          )}
        </div>
      </SettingsRow>
      <div className="set-row set-row-stacked set-plugins-add">
        <input
          className="set-text"
          type="text"
          aria-label="Plugin name"
          placeholder="plugin or plugin@marketplace"
          value={typed}
          disabled={disabled || !config.enabled}
          aria-invalid={addError !== null}
          onChange={(e) => {
            setTyped(e.target.value);
            setAddError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <Chip size={28} disabled={disabled || !config.enabled} onClick={add}>
          Add
        </Chip>
      </div>
      {addError !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">{addError}</span>
        </div>
      )}
      {saveError !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">Not saved — {saveError}. The value shown is the one still on the server.</span>
        </div>
      )}
    </SettingsGroup>
  );
}
