import { useState, type ReactNode } from 'react';

import { REVIEW_EFFORT_OPTIONS, REVIEW_MODE_OPTIONS, REVIEW_MODEL_OPTIONS, parseSmallMaxLines } from '../../lib/agents';
import { REVIEW_SMALL_MAX_LINES_MAX, REVIEW_SMALL_MAX_LINES_MIN } from '../../../../shared/agent';
import type { ReviewConfig, ReviewEffort, ReviewModel, ReviewPair } from '../../../../shared/types';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { SettingsRow } from '../ui/SettingsRow';

const LIMIT_HINT = 'Groups with at most this many changed lines use the small pair. The first group always uses the big pair.';

type PairName = 'same' | 'big' | 'small';

/**
 * ReviewerFields — the reviewer config's pickers (reviewer coverage task 11, spec §7), one component for the three surfaces that set it: Settings › Shared's
 * `Reviewer` card (`layout="rows"`, `.claude/DESIGN.md` §8.6 — `SettingsRow`s holding a pill `Segmented` and 36 px `Select`s) and the two launch sheets
 * (`layout="sheet"`, §8.7 Overlays — `.sheet-field` labels in a wrapping `.sheet-row`, the shape their own Model and Effort already take). One component so the
 * words, the option lists and the limit's validation cannot drift between the place a person saves the setting and the places they override it per launch.
 *
 * Controlled and stateless about the config: `value` is the whole `ReviewConfig` and every change hands `onChange` a whole new one, so `same` survives a switch
 * to split and back (spec: "stored so a mode switch keeps it") without this component remembering anything. `Same for all groups` draws `Model` and `Effort`;
 * `Big and small groups` draws the two pairs and the limit. The selects' `''` is the unset member, `null` on the wire.
 *
 * The limit is the one field with a draft of its own (`LimitField`): a number typed half-way — `1` on the way to `150` — must not be sent, and an out-of-range
 * one must say so rather than snap back. So it commits on blur or Enter, only a value `parseSmallMaxLines` accepts, and draws `aria-invalid` otherwise.
 */
export function ReviewerFields({
  value,
  onChange,
  layout = 'rows'
}: {
  value: ReviewConfig;
  onChange: (next: ReviewConfig) => void;
  layout?: 'rows' | 'sheet';
}) {
  const setPair = (name: PairName, pair: ReviewPair) => onChange({ ...value, [name]: pair });
  const modelSelect = (name: PairName, label: string) => (
    <Select<'' | ReviewModel>
      label={label}
      value={value[name].model ?? ''}
      options={REVIEW_MODEL_OPTIONS}
      onChange={(m) => setPair(name, { ...value[name], model: m === '' ? null : m })}
    />
  );
  const effortSelect = (name: PairName, label: string) => (
    <Select<'' | ReviewEffort>
      label={label}
      value={value[name].effort ?? ''}
      options={REVIEW_EFFORT_OPTIONS}
      onChange={(e) => setPair(name, { ...value[name], effort: e === '' ? null : e })}
    />
  );
  const limit = <LimitField value={value.smallMaxLines} onCommit={(n) => onChange({ ...value, smallMaxLines: n })} />;
  const modes = (
    <Segmented<ReviewConfig['mode']> label="Models" pill value={value.mode} options={REVIEW_MODE_OPTIONS} onChange={(mode) => onChange({ ...value, mode })} />
  );

  // Each entry is one labelled control; the two layouts differ only in the frame they put around it, so the order and the words are written once.
  const fields: { name: string; control: ReactNode; hint?: string }[] =
    value.mode === 'same'
      ? [
          { name: 'Model', control: modelSelect('same', 'Model') },
          { name: 'Effort', control: effortSelect('same', 'Effort') }
        ]
      : [
          { name: 'Big groups — model', control: modelSelect('big', 'Big groups — model') },
          { name: 'Big groups — effort', control: effortSelect('big', 'Big groups — effort') },
          { name: 'Small groups — model', control: modelSelect('small', 'Small groups — model') },
          { name: 'Small groups — effort', control: effortSelect('small', 'Small groups — effort') },
          { name: 'Small group limit', control: limit, hint: LIMIT_HINT }
        ];

  if (layout === 'rows') {
    return (
      <>
        <SettingsRow name="Models">{modes}</SettingsRow>
        {fields.map((f) => (
          <SettingsRow key={f.name} name={f.name} hint={f.hint}>
            {f.control}
          </SettingsRow>
        ))}
      </>
    );
  }

  // The sheet frame: a named group, so a sheet that already has its own `Model` and `Effort` selects (both launch sheets do) keeps the two sets apart for a
  // screen reader and for a test's `within`. The limit's hint goes under the row as a `.sheet-note`, the sheets' own small print.
  const hint = fields.find((f) => f.hint)?.hint;
  return (
    <div className="sheet-field reviewer-fields" role="group" aria-label="Reviewer">
      <span className="set-name">Reviewer</span>
      {modes}
      <div className="sheet-row">
        {fields.map((f) => (
          <label key={f.name} className="sheet-field">
            <span className="set-name">{f.name}</span>
            {f.control}
          </label>
        ))}
      </div>
      {hint && <span className="sheet-note">{hint}</span>}
    </div>
  );
}

/**
 * The small-group limit as a 36 px text field (`.set-text`, page CSS for the §8.6 family's text member) holding the string as typed. Not `ui/NumberField`: that
 * one commits whatever it is given on blur and re-seeds by key, with no state in which a value is shown but refused. The draft follows `value` when the
 * committed number changes from outside (a save's answer, a seed), adjusted during render so no frame shows the stale text.
 */
function LimitField({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }
  const parsed = parseSmallMaxLines(draft);
  const commit = () => {
    if (parsed !== null && parsed !== value) onCommit(parsed);
  };
  return (
    <input
      className="set-text reviewer-limit"
      type="number"
      inputMode="numeric"
      min={REVIEW_SMALL_MAX_LINES_MIN}
      max={REVIEW_SMALL_MAX_LINES_MAX}
      step={1}
      aria-label="Small group limit"
      aria-invalid={parsed === null ? true : undefined}
      title={parsed === null ? `a whole number from ${REVIEW_SMALL_MAX_LINES_MIN} to ${REVIEW_SMALL_MAX_LINES_MAX}` : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}
