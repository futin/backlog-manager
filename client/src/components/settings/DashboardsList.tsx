import type { ReactNode } from 'react';

import { usagePercent, usageTone } from '../../lib/dashboards';
import type { MachineUsage } from '../../../../shared/types';
import { Dot } from '../ui/Dot';
import { Meter } from '../ui/Meter';
import { Pill } from '../ui/Pill';
import { Sheet } from '../ui/Sheet';

/**
 * The machine list on Settings › Dashboards (spec 2026-10-23 "The page" › List; `.claude/DESIGN.md` §8.6, and §7's status micro-labels for the pills).
 * The left column above the 1100 px fold, the top of the page under it: one row per machine in prefer order, each reading at a glance — where it sits in the
 * order, whether a launch could go there now, which account, how much of each window is gone — and selecting it for the detail beside it.
 *
 * **A row is a `<button>` with `aria-pressed`**, not a `Chip`: it is a selector over a list, two lines tall with meters inside, and the 28/32 px chip is a
 * one-line control. Keyboard-selectable for free; it is not a dialog and joins no Escape stack. Selecting is a read, so the rows stay enabled while the file
 * is unreadable and every write control is not.
 *
 * **`MachineIdentity` is shared with the detail's head** so the two cannot come to draw one machine two ways: the order box, the health `Dot`, the name, the
 * `this machine` pill on Home, and the account `Pill` or a muted `no account set` — muted text rather than an empty or `—` pill, because a pill states a fact
 * and "none" is not one.
 *
 * Every value arrives as a named prop the page picked from the view; nothing here spreads an entry, so a field a future payload grows cannot reach the DOM.
 */

export type ListMachine = {
  id: string;
  label: string;
  /** 1-based place in the prefer order. */
  order: number;
  home: boolean;
  account: string | null;
  /** `dispatchDotTone`'s answer, already decided by the page; `undefined` draws the quiet dot. */
  tone: 'live' | 'paused' | 'crashed' | undefined;
  /** This machine's figure from the machines read, or `null` (none yet, none fresh, or unreachable) — then the row draws no meters at all. */
  usage: MachineUsage | null;
};

export function MachineIdentity({ machine }: { machine: Pick<ListMachine, 'label' | 'order' | 'home' | 'account' | 'tone'> }) {
  return (
    <span className="dash-page-ident">
      <span className="dash-page-order">{machine.order}</span>
      <Dot tone={machine.tone} />
      <span className="dash-page-name">{machine.label}</span>
      {machine.home && <Pill>this machine</Pill>}
      {machine.account ? <Pill>{machine.account}</Pill> : <span className="dash-page-muted">no account set</span>}
    </span>
  );
}

/** The two windows as meters side by side; the labels are upper-case in the source because §1 allows exactly one uppercasing rule, the rail kicker's. */
function RowMeters({ usage }: { usage: MachineUsage }) {
  return (
    <span className="dash-page-meters">
      <Meter
        label="5 H"
        value={`${usagePercent(usage.fiveHour.pct)}%`}
        fraction={usage.fiveHour.pct / 100}
        tone={usageTone(usage.fiveHour.pct)}
        width="fill"
      />
      <Meter label="WEEK" value={`${usagePercent(usage.week.pct)}%`} fraction={usage.week.pct / 100} tone={usageTone(usage.week.pct)} width="fill" />
    </span>
  );
}

export function DashboardsList({
  machines,
  selected,
  onSelect,
  add
}: {
  machines: ListMachine[];
  selected: string;
  onSelect: (id: string) => void;
  /** The `Add dashboard` chip that ends the list — the page's, because its disabled rules read the view and its click opens the page's sheet. */
  add: ReactNode;
}) {
  return (
    <Sheet className="dash-page-list">
      {machines.map((m) => (
        <button key={m.id} type="button" className="dash-page-row" aria-pressed={m.id === selected} onClick={() => onSelect(m.id)}>
          <MachineIdentity machine={m} />
          {m.usage && <RowMeters usage={m.usage} />}
        </button>
      ))}
      <span className="dash-page-add">{add}</span>
    </Sheet>
  );
}
