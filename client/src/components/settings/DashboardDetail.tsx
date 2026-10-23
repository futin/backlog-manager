import type { ReactNode } from 'react';

import { noUsageText, resetClockText, usagePercent, usageTone } from '../../lib/dashboards';
import { dispatchDotTone, EFFORTS, MODELS } from '../../../../shared/agent';
import type { AgentsStatus, DashboardsView, MachineStatus } from '../../../../shared/types';
import { Dot } from '../ui/Dot';
import { Meter } from '../ui/Meter';
import { Pill } from '../ui/Pill';
import { Sheet } from '../ui/Sheet';
import { ticked } from './DashboardSheet';
import { AgentsStatusLines, DispatchSetupSteps } from './DispatchStatus';
import { MachineIdentity, type ListMachine } from './DashboardsList';

/**
 * The selected machine's detail on Settings › Dashboards (spec 2026-10-23 "The page" › Detail; a `Sheet`, `.claude/DESIGN.md` §8.2 and §8.6, with §7's
 * micro-labels for the model and effort pills). Top to bottom: the head (the list row's identity, then the page's ↑ ↓ Edit Remove or the Remove `Confirm`),
 * the `list`-scope refusal, the status line, the two usage windows, the Models and Efforts the machine may run, and the facts.
 *
 * **Two sources, never mixed in one reading.** Home's status line and setup steps read `useAgents` — the same status Home's dot reads, so a green dot can
 * never sit above open setup steps — and a remote's read its entry in `GET /api/dashboards/machines`. Usage, for Home too, is the machines read's. The
 * config half (head, lists, facts) reads `GET /api/dashboards` only, so it draws at once and the status half says `checking…` until its answer lands.
 *
 * **A remote's line is Home's in the same words where they apply** (`AgentsStatusLines`): `off`, `unreachable — <the server's error>`, `connected` with the
 * gaps that stop a launch or `· spawn on`, then the ceiling. Never a project count — the machines read does not carry one, and a line that drew `0 projects`
 * would be a reading nobody took.
 *
 * **Models and efforts are facts, so they are `Pill`s, not `Chip`s** (the clickable primitive): every member of `MODELS` / `EFFORTS`, the allowed ones in
 * the normal look and the rest `off`, titled `not run on <label>`. "Allowed" is `ticked` — an empty list means "no narrowing", every member. Home's are drawn
 * the same way and, as on the old card, narrow nothing; no hint here says otherwise.
 *
 * **A token is never here.** The `Token` fact is the var's NAME and `✓ set`, or the not-set sentence — never drawn as a fault, because a dashboard that
 * trusts its tailnet (or, for Home, loopback) takes a call with no token, so an unset one is the common, working case. Every value is a named field.
 */

type Remote = DashboardsView['dashboards'][number];

/** The token's fact: the var's NAME and whether it is set, and nothing of its value (the payload never carries one). */
function tokenLine(tokenVar: string, set: boolean): string {
  return set ? `${tokenVar} ✓ set` : `${tokenVar} not set — needed only if that dashboard does not trust this machine; then add it to .env and restart`;
}

function RemoteStatusLine({ status }: { status: MachineStatus | null }) {
  if (status === null) return <span>checking…</span>;
  const dot = <Dot tone={dispatchDotTone(status) ?? undefined} />;
  let line: string;
  if (!status.enabled) line = 'off — dispatch is not enabled on the API';
  else if (!status.reachable) line = `unreachable${status.error ? ` — ${status.error}` : ''}`;
  else {
    const gaps = [status.spawnAvailable ? null : 'no CLAUDE_BIN', status.remoteAnswer ? null : 'remote answers off'].filter((g): g is string => g !== null);
    line = `connected${gaps.length > 0 ? ` — ${gaps.join(', ')}` : ' · spawn on'} · ceiling: ${status.spawnMaxPermission ?? 'unknown'}`;
  }
  return (
    <span>
      {dot} {line}
    </span>
  );
}

/**
 * Both windows full width, each with its reset as a local clock time under it (`resetClockText` — absolute, unlike the launch sheet's relative
 * `fiveHourResetText`). No figure: one muted line, `noUsageText`'s — specific only where the server already knows (unreachable, stale).
 */
function Usage({ status, now }: { status: MachineStatus | null; now: number }) {
  if (status === null) return <p className="dash-page-muted">checking…</p>;
  const { usage } = status;
  if (usage === null) return <p className="dash-page-muted">{noUsageText(status)}</p>;
  const windows = [
    { label: '5 h', w: usage.fiveHour },
    { label: 'week', w: usage.week }
  ];
  return (
    <>
      {windows.map(({ label, w }) => {
        const reset = resetClockText(w.resetsAt, now);
        return (
          <span key={label} className="dash-page-window">
            <Meter label={label} value={`${usagePercent(w.pct)}%`} fraction={w.pct / 100} tone={usageTone(w.pct)} width="fill" />
            {reset !== null && <span className="dash-page-muted">{reset}</span>}
          </span>
        );
      })}
    </>
  );
}

function Allowed({ list, all, label }: { list: string[]; all: readonly string[]; label: string }) {
  const allowed = ticked(list, all);
  return (
    <span className="dash-page-pills">
      {all.map((m) => {
        const on = allowed.includes(m);
        return (
          <Pill key={m} off={!on} title={on ? undefined : `not run on ${label}`}>
            {m}
          </Pill>
        );
      })}
    </span>
  );
}

export function DashboardDetail({
  machine,
  home,
  remote,
  agents,
  status,
  controls,
  notice
}: {
  machine: ListMachine;
  /** The view's Home entry — read for Home's own facts only. */
  home: DashboardsView['home'];
  /** The remote's entry, or `null` when `machine` is Home. */
  remote: Remote | null;
  /** `useAgents`' status — Home's status line and setup steps. */
  agents: AgentsStatus | null;
  /** This machine's entry in the machines read; `null` before it lands or when the answer lacks the machine. */
  status: MachineStatus | null;
  /** The head's right side: the page's ↑ ↓ Edit Remove, or the Remove `Confirm` in their place. */
  controls: ReactNode;
  /** The `list`-scope refusal row, or nothing. */
  notice: ReactNode;
}) {
  const now = Date.now();
  const models = remote === null ? home.models : remote.models;
  const efforts = remote === null ? home.efforts : remote.efforts;
  return (
    <Sheet as="section" className="dash-page-detail">
      <div className="dash-page-head">
        <MachineIdentity machine={machine} />
        <span className="dash-page-controls">{controls}</span>
      </div>
      {notice}
      {remote === null ? (
        <>
          <p className="dash-page-status set-hint">
            dispatch <AgentsStatusLines status={agents} />
          </p>
          <DispatchSetupSteps status={agents} />
        </>
      ) : (
        <p className="dash-page-status set-hint">
          <RemoteStatusLine status={status} />
        </p>
      )}
      <div className="dash-page-usage">
        <Usage status={status} now={now} />
      </div>
      <dl className="dash-page-facts set-hint">
        <dt>Models</dt>
        <dd>
          <Allowed list={models} all={MODELS} label={machine.label} />
        </dd>
        <dt>Efforts</dt>
        <dd>
          <Allowed list={efforts} all={EFFORTS} label={machine.label} />
        </dd>
      </dl>
      <dl className="dash-page-facts set-hint">
        <dt>Dashboard</dt>
        {remote === null ? (
          <dd>
            <code>{home.url}</code> <Pill>BM_AGENTS_URL</Pill>
          </dd>
        ) : (
          <dd>
            <code>{remote.url}</code>
          </dd>
        )}
        {remote !== null && (
          <>
            <dt>Board</dt>
            <dd>{remote.bmUrl ? <code>{remote.bmUrl}</code> : '—'}</dd>
            <dt>Machine name</dt>
            <dd>{remote.host ? <code>{remote.host}</code> : '—'}</dd>
          </>
        )}
        <dt>Token</dt>
        <dd>{remote === null ? tokenLine(home.tokenVar, home.tokenSet) : tokenLine(remote.tokenVar, remote.tokenSet)}</dd>
      </dl>
    </Sheet>
  );
}
