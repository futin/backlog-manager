import type { AgentsStatus } from '../../../../shared/types';

/**
 * This machine's dispatch report — the status line and the setup steps — drawn on the `Home` row of the Dashboards card (`.claude/DESIGN.md` §8.6), which
 * is where it has lived since the `Claude Agents` card was folded into that one: both answered "what can this machine's own dashboard do", one as a status
 * and one as a list entry, and two cards for one subject read as two subjects. A module of its own because `DashboardsGroup` draws it and `SettingsView`
 * imports `DashboardsGroup`, so it cannot live in either without a cycle.
 *
 * Read-only, like the card it came from: every gate named here lives on a host — in this API's env or in the dashboard's — and a switch that wrote to a
 * browser's localStorage would be a lie about where the setting is. The bearer token is not here and never was: it must never be in a browser at all.
 */

/**
 * The dot's three colors answer one question — "can I dispatch right now?" —
 * not the whole gate ladder `dispatchGate` walks: `spawnAvailable` (no
 * CLAUDE_BIN) still surfaces as gap text below, it just doesn't change the
 * color. `green` needs the dashboard reachable AND remote answers on;
 * anything short of reachable (off, unreachable, still checking) is `gray`
 * rather than a fourth color, since none of those name a fixable dashboard
 * setting the way "remote answers off" does.
 */
type DotTier = 'green' | 'amber' | 'gray';

function dispatchDotTier(status: AgentsStatus | null): DotTier {
  if (status === null || !status.enabled || !status.reachable) return 'gray';
  return status.remoteAnswer ? 'green' : 'amber';
}

function Dot({ tier }: { tier: DotTier }) {
  return <span className={`set-dot set-dot-${tier}`}>●</span>;
}

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
export function AgentsStatusLines({ status }: { status: AgentsStatus | null }) {
  const dot = <Dot tier={dispatchDotTier(status)} />;
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
      {' · '}
      {status.projectPaths.length} projects
    </>
  );
}

/** Every gate open: the one state in which the setup steps would only nag. */
export function dispatchHealthy(status: AgentsStatus | null): boolean {
  return status !== null && status.enabled && status.reachable && status.spawnAvailable && status.remoteAnswer;
}

/**
 * The five setup steps, shown only once an answer has landed and it is not healthy. Gated on an actual answer, not bare `!healthy`: `dispatchHealthy` is
 * false the instant `status` is still `null`, which would fold "not answered yet" into "broken" and tell the reader to go edit their .env while the status
 * line above still correctly says "checking…".
 */
export function DispatchSetupSteps({ status }: { status: AgentsStatus | null }) {
  if (status === null || dispatchHealthy(status)) return null;
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
