import type { ReactNode } from 'react';

import type { SuggestStrategy } from '../../../../shared/types';
import { NumberField } from '../ui/NumberField';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';

/**
 * The Suggest card at the top of Settings › Dashboards (spec 2026-10-23 "The page"; drawn to `.claude/DESIGN.md` §8.6 — a `SettingsGroup`, its rows and the
 * 36 px control family). Full width, above the list and the detail, because both of its settings read the WHOLE list rather than one machine on it.
 *
 * **The strategy stays three radios.** `Segmented` would be the page's natural picker, but it is a `role="group"` of `aria-pressed` buttons and its header
 * rejects radiogroup semantics on purpose, so the three options keep today's `role="radiogroup"` with its accessible name, each radio labelled by its name
 * and described by its own line. Only the look changes: each label is a tile drawing the name over that line, side by side above the phone break and stacked
 * under it. Accessibility outranks the look — the tile is a `<label>`, so a click anywhere on it is a click on its radio.
 *
 * The lines read "the prefer order" where the old card said "the order above": the list is no longer above them, it is under them, in its own column.
 *
 * The threshold is the 1–100 `NumberField`, which commits on blur; a refused value (the server's 400 for 0 or 101) re-seeds the field from the stored one
 * through `thresholdKey`, so the number shown is the number in force. The card owns no state and sends nothing itself: every write is the page's one
 * single-flight `write`, handed down as `onStrategy` / `onThreshold`, so a strategy click and a list move can never be in flight together.
 */

const STRATEGIES: { id: SuggestStrategy; name: string; line: string }[] = [
  { id: 'prefer', name: 'Prefer order', line: 'The first in the prefer order that is under the threshold on both windows' },
  { id: 'headroom', name: 'Most headroom', line: 'The lowest used figure — the higher of its 5 h and weekly percent' },
  { id: 'runway', name: 'Least likely to run out', line: 'One projected to last past its weekly reset; ties go to the prefer order' }
];

export function SuggestCard({
  strategy,
  threshold,
  locked,
  thresholdKey,
  onStrategy,
  onThreshold,
  notice
}: {
  strategy: SuggestStrategy;
  threshold: number;
  /** Unreadable file or a write in flight: every control is disabled. */
  locked: boolean;
  /** Bumped by the page when a threshold is refused, re-mounting the field so it shows the stored value rather than the refused one. */
  thresholdKey: number;
  onStrategy: (s: SuggestStrategy) => void;
  onThreshold: (v: number) => void;
  /** The `suggest`-scope refusal row, in the server's words, or nothing. */
  notice: ReactNode;
}) {
  return (
    <SettingsGroup title="Suggest" scope="Which machine a launch sheet starts on. You can still pick another there.">
      <div className="set-row set-row-stacked">
        <div className="set-label">
          <span className="set-name">Strategy</span>
        </div>
        <div className="dash-page-strategies" role="radiogroup" aria-label="Suggestion strategy">
          {STRATEGIES.map((s) => (
            <label key={s.id} className={strategy === s.id ? 'dash-page-strategy on' : 'dash-page-strategy'}>
              <input
                type="radio"
                name="dashboards-strategy"
                checked={strategy === s.id}
                disabled={locked}
                aria-labelledby={`dash-strategy-${s.id}`}
                aria-describedby={`dash-strategy-${s.id}-line`}
                onChange={() => onStrategy(s.id)}
              />
              <span className="dash-page-strategy-text">
                <span className="set-name" id={`dash-strategy-${s.id}`}>
                  {s.name}
                </span>
                <span className="set-hint" id={`dash-strategy-${s.id}-line`}>
                  {s.line}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <SettingsRow name="Threshold" hint="A machine is under it when both its 5 h and its weekly use are below this percent.">
        <span key={thresholdKey} className="dash-threshold">
          <NumberField
            label="Threshold"
            value={threshold}
            min={1}
            max={100}
            unit="%"
            disabled={locked}
            onCommit={(v) => {
              if (v !== threshold) onThreshold(v);
            }}
          />
        </span>
      </SettingsRow>
      {notice}
    </SettingsGroup>
  );
}
