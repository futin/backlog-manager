import { dispatchDotTone } from '../../../../shared/agent';
import type { AgentsStatus, MachineHealth } from '../../../../shared/types';
import { Dot } from '../ui/Dot';

/**
 * This machine's dispatch report — the status line and the setup steps — drawn in Home's detail on the Dashboards page (`.claude/DESIGN.md` §8.6), which
 * is where it has lived since the `Claude Agents` card was folded into the Dashboards card and that card became a page: both answered "what can this
 * machine's own dashboard do", one as a status and one as a list entry, and two cards for one subject read as two subjects. A module of its own because
 * `DashboardsPage` draws it and `SettingsView` imports `DashboardsPage`, so it cannot live in either without a cycle.
 *
 * Read-only, like the card it came from: every gate named here lives on a host — in this API's env or in the dashboard's — and a switch that wrote to a
 * browser's localStorage would be a lie about where the setting is. The bearer token is not here and never was: it must never be in a browser at all.
 */

/*
 * The dot is `dispatchDotTone`'s (shared/agent.ts) — the one reading of "a launch could go there now" — drawn by `ui/Dot`, so this row and every other
 * surface that draws a machine's health cannot disagree. Four rungs: no tone (quiet) while there is no answer or dispatch is off, `crashed` when dispatch is
 * on but the dashboard did not answer, `paused` when it answered but cannot take a launch (no CLAUDE_BIN, or remote answers off — the gaps the line below
 * names), `live` when all four hold. The old three-colour dot read green with no CLAUDE_BIN, which is a dashboard that 404s every spawn.
 */

/**
 * One line per gate, in the order dispatchBlock (shared/agent.ts) checks
 * them, so the first gap named here is also the thing worth fixing
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
//
// One ladder for every machine (Settings › Dashboards): Home passes `useAgents`' `AgentsStatus` and a remote its `MachineStatus` from the machines read —
// both are a `MachineHealth`, so the off / unreachable / connected words can never drift apart between two copies. The project count is the one rung only
// Home's report carries (`projectPaths`); a remote's health has none, so its line ends at the ceiling rather than drawing a `0 projects` nobody measured.
export function AgentsStatusLines({ status }: { status: (MachineHealth & { projectPaths?: string[] }) | null }) {
  const dot = <Dot tone={dispatchDotTone(status) ?? undefined} />;
  if (status === null) return <>checking…</>;
  if (!status.enabled) return <>{dot} off — dispatch is not enabled on the API</>;
  if (!status.reachable) {
    return (
      <>
        {dot} unreachable{status.error ? ` — ${status.error}` : ''}
      </>
    );
  }
  const gaps = [status.spawnAvailable ? null : 'no CLAUDE_BIN', status.remoteAnswer ? null : 'remote answers off'].filter((g): g is string => g !== null);
  return (
    <>
      {dot} connected{gaps.length > 0 ? ` — ${gaps.join(', ')}` : ' · spawn on'}
      {' · '}ceiling: {status.spawnMaxPermission ?? 'unknown'}
      {status.projectPaths !== undefined && <>{` · ${status.projectPaths.length} projects`}</>}
    </>
  );
}

/**
 * The five setup steps, shown only once an answer has landed and it is not healthy. Gated on an actual answer, not bare `tone !== 'live'`: that is
 * true the instant `status` is still `null`, which would fold "not answered yet" into "broken" and tell the reader to go edit their .env while the status
 * line above still correctly says "checking…".
 */
export function DispatchSetupSteps({ status }: { status: AgentsStatus | null }) {
  if (status === null || dispatchDotTone(status) === 'live') return null;
  return (
    <div className="set-row set-row-stacked">
      <div className="set-label">
        <span className="set-name">Setting it up</span>
        <span className="set-hint">
          1 · <code>BM_AGENTS=on</code> and <code>BM_AGENTS_URL</code> in this app's <code>.env</code>, then restart the API.
          <br />2 · <code>CLAUDE_BIN</code> in the dashboard's <code>.env</code> — that is its spawn gate.
          <br />
          3 · Turn its remote-answer pill on; spawning is refused without it.
          <br />4 · Run its <code>pnpm hooks:install</code>, or a groom that asks you a question will stall with nowhere to ask.
          <br />5 · A project needs one Claude session inside the dashboard's <code>LOOKBACK_HOURS</code> before it can be dispatched to — open one there, or
          raise <code>LOOKBACK_HOURS</code> in the dashboard's <code>.env</code>.
        </span>
      </div>
    </div>
  );
}
