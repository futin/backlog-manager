import type { ReactNode } from 'react';

/*
  `Segmented` and `NumberField` used to live here and now live in
  `components/ui/` (the design spec's §12.1): both are controls the launch and
  orchestrate sheets want too, and a primitive that only Settings can import is
  the drift that rule exists to stop. What stays here is what is genuinely
  Settings' own — a row and a group are this card's COMPOSITION of `Sheet` plus
  rows, not patterns another surface reuses.
*/

/** One labelled setting: name + explanation on the left, the control on the right. */
export function SettingsRow({ name, hint, children }: { name: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span className="set-name">{name}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

/** A group of rows under a section heading. */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-group">
      <div className="mdetail-label">{title}</div>
      {children}
    </section>
  );
}
