import { useId } from 'react';

import { Meter } from './Meter';
import { Pill } from './Pill';
import { useNow } from '../../hooks/useNow';
import {
  NO_MACHINE_TEXT,
  SETTINGS_HREF,
  fiveHourResetText,
  oldestUsageAgeMs,
  showsPicker,
  usageAgeText,
  usagePercent,
  usageTone
} from '../../lib/dashboards';
import type { MachineOffer, ProjectOffers } from '../../../../shared/types';

/**
 * RunOn — the "Run on" machine-card group at the top of a launch sheet (spec "The picker's look", option A; .claude/DESIGN.md §8.7's Launch and Orchestrate sheets, §7's
 * reusable patterns and §8.2's tokens). One card-sized toggle button per machine, side by side: a name, an account line, a 5 h and a weekly bar with their
 * percentages and the 5 h reset time. The suggested machine carries a `Suggested` tag and the home machine a `home` tag; one line beneath says which strategy
 * suggested it and why, with a link to the Settings card, and the age of the usage readings sits at the group's top right. A machine the server did not offer
 * is drawn disabled with its reason in the card — the card is the one place that reason is read, so it is never a tooltip.
 *
 * The cards are `Meter`s and `Pill`s, and the skin is the chip family's (`--strip` ground, a `--hairline2` stroke, `--ink3` when pressed, a dashed stroke when
 * disabled), so the group looks like the rest of the sheet's controls and the daylight contrast measurements already cover its colours. Its own class family,
 * `.ui-run-on`, lives in the primitives block of `styles.css` and is declared once (guard 7), because two surfaces draw it — the Orchestrate sheet and the card
 * dispatch — and neither may restate its look.
 *
 * Controlled: `value` is the picked machine id (`'home'` or a remote's name) and `onChange` reports a pick. Which machine STARTS selected is the sheet's call
 * (`defaultMachine` in `lib/dashboards.ts`), not the group's, because the sheet also decides what a pick locks (`lockedFor`). Everything drawn is the server's
 * answer as it came — percentages are clamped and worded in `lib/dashboards.ts`, never here.
 *
 * Draws nothing for fewer than two machines: a files project, or a setup with no remote configured, is a home-only launch and the sheet looks as it always did.
 * With two or more it draws even when only one is offered, because an unreachable remote is still a card with a reason.
 *
 * A pressed-and-disabled combination is possible in principle (the sheet's `value` names a machine whose offer then lapsed) and draws as disabled; the sheet
 * reads `offers` again and moves the pick, which is why this component never moves it on its own.
 */
export function RunOn({ offers, value, onChange }: { offers: ProjectOffers; value: string; onChange: (machine: string) => void }) {
  // The 5 h reset text is the only thing here that moves on its own, in whole minutes, so a half-minute tick is more than it needs.
  const now = useNow(true, 30_000);
  // Two groups can be mounted at once (a sheet over a card's dispatch), so the label's id is per instance.
  const titleId = useId();
  if (!showsPicker(offers)) return null;

  const age = oldestUsageAgeMs(offers);
  const suggested = offers.suggestion?.machine ?? null;
  const anyOffered = offers.machines.some((m) => m.offered);

  return (
    <div className="ui-run-on">
      <div className="ui-run-on-head">
        <span className="ui-run-on-title" id={titleId}>
          Run on
        </span>
        {age !== null && <span className="ui-run-on-age">{usageAgeText(age)}</span>}
      </div>
      <div className="ui-run-on-cards" role="group" aria-labelledby={titleId}>
        {offers.machines.map((m) => (
          <MachineCard
            key={m.machine}
            offer={m}
            pressed={m.machine === value}
            suggested={m.machine === suggested}
            now={now}
            onPick={() => onChange(m.machine)}
          />
        ))}
      </div>
      {offers.suggestion ? (
        <div className="ui-run-on-foot">
          <p className="ui-run-on-reason">{offers.suggestion.reason}</p>
          <a className="ui-run-on-link" href={SETTINGS_HREF} target="_blank" rel="noreferrer">
            Settings
          </a>
        </div>
      ) : (
        !anyOffered && <p className="ui-run-on-reason">{NO_MACHINE_TEXT}</p>
      )}
    </div>
  );
}

function WindowMeter({ label, pct }: { label: string; pct: number }) {
  return <Meter label={label} value={`${usagePercent(pct)}%`} fraction={usagePercent(pct) / 100} tone={usageTone(pct)} width="fill" />;
}

function MachineCard({
  offer,
  pressed,
  suggested,
  now,
  onPick
}: {
  offer: MachineOffer;
  pressed: boolean;
  suggested: boolean;
  now: number;
  onPick: () => void;
}) {
  const { usage } = offer;
  const reset = usage ? fiveHourResetText(usage, now) : null;
  return (
    <button type="button" className={pressed ? 'ui-run-on-card on' : 'ui-run-on-card'} aria-pressed={pressed} disabled={!offer.offered} onClick={onPick}>
      <span className="ui-run-on-name">
        <span className="ui-run-on-label">{offer.label}</span>
        {suggested && <Pill tone="live">Suggested</Pill>}
        {offer.home && <Pill>home</Pill>}
      </span>
      {offer.account && <span className="ui-run-on-account">{offer.account}</span>}
      {!offer.offered ? (
        <span className="ui-run-on-why">{offer.reason ?? 'not offered'}</span>
      ) : usage ? (
        <>
          <span className="ui-run-on-bars">
            <WindowMeter label="5 h" pct={usage.fiveHour.pct} />
            <WindowMeter label="week" pct={usage.week.pct} />
          </span>
          {reset && <span className="ui-run-on-reset">{reset}</span>}
        </>
      ) : (
        <span className="ui-run-on-why">usage unknown</span>
      )}
    </button>
  );
}
