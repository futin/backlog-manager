import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useAgents } from '../../hooks/useAgents';
import { useDashboards } from '../../hooks/useDashboards';
import { useMountedRef } from '../../hooks/useMountedRef';
import { deleteEntry, saveEntry, saveHome, saveSuggestion } from '../../lib/dashboards';
import { EFFORTS, MODELS } from '../../../../shared/agent';
import type { AgentsStatus, DashboardsView, SuggestStrategy } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { DashboardSheet, ticked } from './DashboardSheet';
import { AgentsStatusLines, DispatchSetupSteps } from './DispatchStatus';
import { Confirm } from '../ui/Confirm';
import { NumberField } from '../ui/NumberField';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';

/**
 * The Dashboards card (multi-dashboard spec "Settings"; drawn to `.claude/DESIGN.md` §8.6 — a `SettingsGroup`, its rows and the 36 px control family, the
 * composition `JiraSkillsGroup` makes of the same parts). Shared Settings, `scope="this machine"`: every value on it is a file on the API host
 * (`dashboards.json`) or that host's environment, so a phone and a laptop that open this board are editing the same list. The page is the scope (§8.6), so
 * nothing per-device is on it.
 *
 * **What the card draws.** The machines in prefer order — home first until the person moves it — each as one row: its name, then lines for what it is (URLs,
 * the machine name a claim's `host` must equal, the account, the models and efforts it may run) and one line for its token. Home's URL is `BM_AGENTS_URL` and
 * its token `BM_AGENTS_TOKEN`: the env var's NAME and, for the URL, its value are shown and neither is editable here; a remote's URL and token var are
 * `BM_AGENTS_TOKEN_<NAME>`. Under the machines: the three suggestion strategies as a radio group and the threshold.
 *
 * **Home's first line is this machine's dispatch report** (`DispatchStatus.tsx`) — the status that was the `Claude Agents` card before the two were folded
 * into this one, since that card reported the very dashboard this one lists as Home — and the setup steps open under the Home row while it is unhealthy. It
 * is read by `useAgents`, not from the dashboards view, so it is drawn even while `GET /api/dashboards` has not answered or has failed.
 *
 * **A token is never on this page, in any form.** The payload carries a boolean (`tokenSet`) and the var's name, and the line says `✓ set` or `not set —
 * needed only if that dashboard does not trust this machine`: a dashboard that trusts its tailnet (or, for home, loopback) takes a call with no token at all,
 * so an unset one is the common, working case and is not drawn as a fault. There is no field to enter one, because a value typed into a browser would have to be stored somewhere the server reads it from,
 * and the env var is that place already; rows are drawn from named fields, never by spreading an entry, so a field a future payload grows cannot reach the
 * DOM by accident.
 *
 * **Home's models and efforts are drawn and editable, and narrow nothing.** They are what a remote launch would be limited to if home were one, kept so a
 * home entry reads like the others; home's own launch sheets behave exactly as before (the server drops an unknown model on home silently), so neither this
 * card nor the sheet puts a hint beside them that suggests otherwise.
 *
 * **Add and Edit open a sheet** (`DashboardSheet`, §8.7) — one at a time, over the card rather than in place under a row, where a seven-field form inside
 * the list read as more of the list. What each field sends, the placeholders that show the server's defaults and the same-name hold are that file's header.
 * Remove stays inline: it is one question about one row, asked through `Confirm` in place of the row's controls.
 *
 * **Every write answers the whole fresh view** (`lib/dashboards.ts`) and the card draws that, never an optimistic copy; a refusal (400 with the field's
 * sentence, 404 for a row another tab removed, 409 for an unreadable file) is shown in the server's own words under the control that sent it and changes
 * nothing locally. One write is in flight at a time — the guard is a ref and `busy` is the rendering (`JiraSkillsGroup`'s split, bug-19), so a double click
 * cannot send an add twice.
 *
 * **Unreadable file** (`source: 'unreadable'`): the server ignores every remote and refuses every write (409, file untouched), so every control is
 * DISABLED and the hint names the file and the one fix, by hand.
 *
 * The threshold is the 1–100 `NumberField`, which commits on blur; a refused value (the server's 400 for 0 or 101) re-seeds the field from the stored one,
 * so the number shown is the number in force.
 */

const STRATEGIES: { id: SuggestStrategy; name: string; line: string }[] = [
  { id: 'prefer', name: 'Prefer order', line: 'The first in the order above that is under the threshold on both windows' },
  { id: 'headroom', name: 'Most headroom', line: 'The lowest used figure — the higher of its 5 h and weekly percent' },
  { id: 'runway', name: 'Least likely to run out', line: 'One projected to last past its weekly reset; ties go to the order above' }
];

/** The server's cap (`MAX_REMOTES`), mirrored only to disable `Add dashboard` at it; the server still enforces its own. */
const MAX_REMOTES = 8;

type Scope = 'form' | 'list' | 'suggest';
type Editing = { kind: 'home' } | { kind: 'new' } | { kind: 'edit'; name: string } | null;
type Remote = DashboardsView['dashboards'][number];

export function DashboardsGroup() {
  const { view: loaded, error } = useDashboards();
  const { status } = useAgents();
  // A write answers the whole fresh view; the hook reads once on mount, so the latest answer simply outranks it.
  const [written, setWritten] = useState<DashboardsView | null>(null);
  const view = written ?? loaded;
  const mounted = useMountedRef();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ scope: Scope; message: string } | null>(null);
  // Bumped when a threshold is refused, to re-mount the field so it shows the stored value rather than the refused one.
  const [thresholdNonce, setThresholdNonce] = useState(0);

  if (view === null) {
    return (
      <SettingsGroup title="Dashboards" scope="this machine">
        <SettingsRow
          name="Dispatch"
          hint={
            <>
              dispatch <AgentsStatusLines status={status} />
            </>
          }
        />
        <DispatchSetupSteps status={status} />
        <SettingsRow
          name={error === null ? 'Dashboards' : 'Unavailable'}
          hint={
            error === null ? 'checking…' : `Could not read the dashboards — ${error}. This card will fill in once the API answers GET /api/dashboards again.`
          }
        />
      </SettingsGroup>
    );
  }

  const unreadable = view.source === 'unreadable';
  const locked = unreadable || busy;

  /** One write at a time. Resolves `true` when the server stored it; the sentence for a refusal goes where `scope` says. */
  async function write(scope: Scope, send: () => Promise<DashboardsView>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const fresh = await send();
      if (mounted.current) setWritten(fresh);
      return true;
    } catch (e) {
      if (mounted.current) setNotice({ scope, message: e instanceof Error ? e.message : 'the dashboards were not saved' });
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // The machines in prefer order. `order` lists every machine once, but a row the server sent and the order lacks is still drawn, last, rather than hidden.
  const remotes = new Map(view.dashboards.map((d) => [d.name, d]));
  const ids = [...view.order.filter((id) => id === 'home' || remotes.has(id)), ...view.dashboards.map((d) => d.name).filter((n) => !view.order.includes(n))];
  if (!ids.includes('home')) ids.unshift('home');

  const move = (id: string, by: -1 | 1): void => {
    const at = ids.indexOf(id);
    const next = [...ids];
    [next[at], next[at + by]] = [next[at + by], next[at]];
    void write('list', () => saveSuggestion({ order: next }));
  };

  const remove = async (name: string): Promise<void> => {
    setAsking(null);
    if (await write('list', () => deleteEntry(name))) setEditing((cur) => (cur?.kind === 'edit' && cur.name === name ? null : cur));
  };

  // `inForm` draws the sentence as a bare line under the sheet's buttons, where a padded row would sit oddly in a footer.
  const noticeFor = (scope: Scope, inForm = false): ReactNode =>
    notice?.scope === scope &&
    (inForm ? (
      <span className="set-error" role="alert">
        {notice.message}
      </span>
    ) : (
      <div className="set-row set-error-row" role="alert">
        <span className="set-error">{notice.message}</span>
      </div>
    ));

  const machineControls = (id: string): ReactNode => {
    const label = id === 'home' ? view.home.label : id;
    const at = ids.indexOf(id);
    if (asking === id) {
      return (
        <Confirm
          label={`Remove ${label}`}
          acceptLabel="Remove"
          dismissLabel="Keep"
          testId={`dashboard-delete-${id}`}
          onAccept={() => void remove(id)}
          onDismiss={() => setAsking(null)}
        >
          Remove {label}? Launches can no longer go there; its token stays in .env.
        </Confirm>
      );
    }
    return (
      <>
        <Chip size={28} variant="flat" aria-label={`Move ${label} up`} disabled={locked || at === 0} onClick={() => move(id, -1)}>
          ↑
        </Chip>
        <Chip size={28} variant="flat" aria-label={`Move ${label} down`} disabled={locked || at === ids.length - 1} onClick={() => move(id, 1)}>
          ↓
        </Chip>
        <Chip
          size={28}
          aria-label={`Edit ${label}`}
          disabled={unreadable}
          onClick={() => {
            setNotice(null);
            setEditing(id === 'home' ? { kind: 'home' } : { kind: 'edit', name: id });
          }}
        >
          Edit
        </Chip>
        {id !== 'home' && (
          <Chip size={28} variant="danger" aria-label={`Remove ${label}`} disabled={locked} onClick={() => setAsking(id)}>
            Remove
          </Chip>
        )}
      </>
    );
  };

  const closeForm = (): void => {
    setEditing(null);
    setNotice(null);
  };

  return (
    <SettingsGroup
      title="Dashboards"
      scope="this machine"
      right={
        <Chip
          size={28}
          disabled={unreadable || view.dashboards.length >= MAX_REMOTES}
          title={view.dashboards.length >= MAX_REMOTES ? `at most ${MAX_REMOTES} dashboards` : undefined}
          onClick={() => {
            setNotice(null);
            setEditing({ kind: 'new' });
          }}
        >
          Add dashboard
        </Chip>
      }
    >
      <div className="set-row">
        <span className="set-hint">
          {unreadable ? (
            <>
              <code>{view.file}</code> exists and cannot be read — every remote is ignored and nothing can be saved until it is fixed or removed by hand.
            </>
          ) : (
            <>Listed in prefer order — move a machine with ↑ ↓. Tokens are never entered here: each is an environment variable, set in .env.</>
          )}
        </span>
      </div>

      {ids.map((id) => {
        const remote = id === 'home' ? null : (remotes.get(id) as Remote);
        return (
          <div key={id} className="dash-machine">
            <SettingsRow
              name={remote === null ? view.home.label : remote.name}
              hint={remote === null ? <HomeLines view={view} status={status} /> : <RemoteLines entry={remote} />}
            >
              {machineControls(id)}
            </SettingsRow>
            {remote === null && <DispatchSetupSteps status={status} />}
          </div>
        );
      })}
      {noticeFor('list')}
      {editing?.kind === 'home' && (
        <DashboardSheet
          kind="home"
          view={view}
          busy={busy}
          onClose={closeForm}
          onSave={async (patch) => {
            if (await write('form', () => saveHome(patch))) closeForm();
          }}
          error={noticeFor('form', true)}
        />
      )}
      {(editing?.kind === 'new' || (editing?.kind === 'edit' && remotes.has(editing.name))) && (
        <DashboardSheet
          kind="remote"
          initial={editing.kind === 'edit' ? (remotes.get(editing.name) as Remote) : null}
          taken={view.dashboards.map((d) => d.name).filter((n) => editing.kind !== 'edit' || n !== editing.name)}
          busy={busy}
          onClose={closeForm}
          onSave={async (entry) => {
            if (await write('form', () => saveEntry(entry, editing.kind === 'edit' ? editing.name : undefined))) closeForm();
          }}
          error={noticeFor('form', true)}
        />
      )}

      <div className="set-row set-row-stacked">
        <div className="set-label">
          <span className="set-name">Suggest</span>
          <span className="set-hint">Which machine a launch sheet starts on. You can still pick another there.</span>
        </div>
        <div className="dash-strategies" role="radiogroup" aria-label="Suggestion strategy">
          {STRATEGIES.map((s) => (
            <label key={s.id} className="dash-strategy">
              <input
                type="radio"
                name="dashboards-strategy"
                checked={view.strategy === s.id}
                disabled={locked}
                aria-labelledby={`dash-strategy-${s.id}`}
                aria-describedby={`dash-strategy-${s.id}-line`}
                onChange={() => void write('suggest', () => saveSuggestion({ strategy: s.id }))}
              />
              <span className="dash-strategy-text">
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
        <span key={thresholdNonce} className="dash-threshold">
          <NumberField
            label="Threshold"
            value={view.threshold}
            min={1}
            max={100}
            unit="%"
            disabled={locked}
            onCommit={(v) => {
              if (v === view.threshold) return;
              void write('suggest', () => saveSuggestion({ threshold: v })).then((ok) => {
                if (!ok && mounted.current) setThresholdNonce((n) => n + 1);
              });
            }}
          />
        </span>
      </SettingsRow>
      {noticeFor('suggest')}
      <div className="set-row">
        <span className="set-hint">
          Saved to <code>{view.file}</code>
        </span>
      </div>
    </SettingsGroup>
  );
}

/** One line under a machine's name — block-level inside the row's hint, so each fact reads on its own line. */
function Line({ children }: { children: ReactNode }) {
  return <span className="dash-line">{children}</span>;
}

/** The token's line: the var's NAME and whether it is set, and nothing of its value (the payload never carries one). */
function tokenLine(tokenVar: string, set: boolean): string {
  return set ? `${tokenVar} ✓ set` : `${tokenVar} not set — needed only if that dashboard does not trust this machine; then add it to .env and restart`;
}

function listLine(label: string, list: string[], all: readonly string[]): string {
  return `${label}: ${ticked(list, all).join(', ')}`;
}

function HomeLines({ view, status }: { view: DashboardsView; status: AgentsStatus | null }) {
  const { home } = view;
  return (
    <>
      <Line>
        dispatch <AgentsStatusLines status={status} />
      </Line>
      <Line>
        <code>BM_AGENTS_URL</code> {home.url}
      </Line>
      <Line>{tokenLine(home.tokenVar, home.tokenSet)}</Line>
      {home.account && <Line>account: {home.account}</Line>}
      <Line>{listLine('models', home.models, MODELS)}</Line>
      <Line>{listLine('efforts', home.efforts, EFFORTS)}</Line>
    </>
  );
}

function RemoteLines({ entry }: { entry: Remote }) {
  return (
    <>
      <Line>dashboard {entry.url}</Line>
      <Line>board {entry.bmUrl}</Line>
      <Line>machine name {entry.host}</Line>
      <Line>{tokenLine(entry.tokenVar, entry.tokenSet)}</Line>
      {entry.account && <Line>account: {entry.account}</Line>}
      <Line>{listLine('models', entry.models, MODELS)}</Line>
      <Line>{listLine('efforts', entry.efforts, EFFORTS)}</Line>
    </>
  );
}
