import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useAgents } from '../../hooks/useAgents';
import { useDashboards } from '../../hooks/useDashboards';
import { useMachines } from '../../hooks/useMachines';
import { useMountedRef } from '../../hooks/useMountedRef';
import { deleteEntry, HOME_MACHINE, machineIds, pickSelected, saveEntry, saveHome, saveSuggestion, statusFor } from '../../lib/dashboards';
import { dispatchDotTone } from '../../../../shared/agent';
import type { DashboardsView } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { Sheet } from '../ui/Sheet';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { DashboardDetail } from './DashboardDetail';
import { DashboardSheet } from './DashboardSheet';
import { DashboardsList, type ListMachine } from './DashboardsList';
import { AgentsStatusLines, DispatchSetupSteps } from './DispatchStatus';
import { SuggestCard } from './SuggestCard';

/**
 * Settings › Dashboards (spec 2026-10-23; multi-dashboard spec "Settings" before it; drawn to `.claude/DESIGN.md` §8.6 — `Sheet`s and `SettingsGroup`s, their
 * rows and the 36 px control family, under the band `SettingsView` draws). The page body: the Suggest card, the machine list beside the selected machine's
 * detail, and a footer. Every value on it is a file on the API host (`dashboards.json`) or that host's environment, so a phone and a laptop that open this
 * board are editing the same list. The page is the scope (§8.6), so nothing per-device is on it.
 *
 * **What the page draws.** The machines in prefer order — home first until the person moves it — each as one list row that reads at a glance (its place in
 * the order, its health dot, its name, its account, its two usage meters) and, for the selected one, a detail: what it is (URLs, the machine name a claim's
 * `host` must equal, the models and efforts it may run as pills) and one fact for its token. Home's URL is `BM_AGENTS_URL` and its token `BM_AGENTS_TOKEN`:
 * the env var's NAME and, for the URL, its value are shown and neither is editable here; a remote's token var is `BM_AGENTS_TOKEN_<NAME>`. Above both: the
 * three suggestion strategies as a radio group and the threshold (`SuggestCard`).
 *
 * **Home's status line is this machine's dispatch report** (`DispatchStatus.tsx`) — the status that was the `Claude Agents` card before it was folded into
 * the Dashboards card (this page's predecessor), since that card reported the very dashboard this page lists as Home — and the setup steps open under it while it is unhealthy. It is
 * read by `useAgents`, not from the dashboards view, so it is drawn even while `GET /api/dashboards` has not answered or has failed (the null-view card
 * below). Home's dot reads the same status through `dispatchDotTone`, so a green dot can never sit over open setup steps.
 *
 * **Health and usage are a separate read, and never block the config.** `useMachines` asks `GET /api/dashboards/machines` — a health probe of every remote
 * plus each machine's usage, up to two outbound budgets on the server — on mount, on focus, every minute, and at once after every successful write here.
 * The list, the detail's facts and every control draw from `GET /api/dashboards` alone, at its speed; the dots stay quiet, the meters absent and the usage
 * area says `checking…` until that answer lands, so a slow or dead remote can never hold the page hostage. The answer is matched to the list by machine id
 * (`statusFor`) and its own order is ignored — the list is `machineIds(view)`, always — so a machine the view lacks is never drawn and one the answer lacks
 * reads as not answered yet. The browser still never talks to a dashboard: the server makes every one of those calls.
 *
 * **Selection is page state, never stored.** `wanted` is the id the person last picked (or moved, or saved through the sheet); `pickSelected` draws it while
 * it is listed and the first machine otherwise, so a reorder keeps the selection on the machine rather than on the position, a rename through Edit follows
 * the new name, an Add selects the new machine once the server's answer contains it, and a Remove falls back with nothing to do.
 *
 * **A token is never on this page, in any form.** The payload carries a boolean (`tokenSet`) and the var's name, and the fact says `✓ set` or `not set —
 * needed only if that dashboard does not trust this machine`: a dashboard that trusts its tailnet (or, for home, loopback) takes a call with no token at
 * all, so an unset one is the common, working case and is not drawn as a fault. There is no field to enter one, because a value typed into a browser would
 * have to be stored somewhere the server reads it from, and the env var is that place already; everything is drawn from named fields, never by spreading an
 * entry, so a field a future payload grows cannot reach the DOM by accident.
 *
 * **Home's models and efforts are drawn and editable, and narrow nothing.** They are what a remote launch would be limited to if home were one, kept so a
 * home entry reads like the others; home's own launch sheets behave exactly as before (the server drops an unknown model on home silently), so neither this
 * page nor the sheet puts a hint beside them that suggests otherwise.
 *
 * **Add and Edit open a sheet** (`DashboardSheet`, §8.7) — one at a time, over the page rather than in place in the detail, where a seven-field form read as
 * more of the page. What each field sends, the placeholders that show the server's defaults and the same-name hold are that file's header. Remove stays
 * inline: it is one question about one machine, asked through `Confirm` in place of the detail head's controls.
 *
 * **Every write answers the whole fresh view** (`lib/dashboards.ts`) and the page draws that, never an optimistic copy; a refusal (400 with the field's
 * sentence, 404 for a row another tab removed, 409 for an unreadable file) is shown in the server's own words under the control that sent it — `form` in the
 * sheet, `list` under the detail head, `suggest` in the Suggest card — and changes nothing locally. One write is in flight at a time — the guard is a ref
 * and `busy` is the rendering (`JiraSkillsGroup`'s split, bug-19), so a double click cannot send an add twice.
 *
 * **Unreadable file** (`source: 'unreadable'`): the server ignores every remote and refuses every write (409, file untouched), so every control is DISABLED,
 * a banner at the top names the file and the one fix, by hand, and the list still draws Home. Selecting a machine is a read and stays possible.
 *
 * **The threshold's commit-on-blur and its re-seed after a refusal** are the Suggest card's paragraph now — `SuggestCard.tsx`'s header, beside the field.
 *
 * The view is read as the card read it — `useDashboards` once on mount, deliberately no focus trigger, plus each write's answer — so another tab's edit shows
 * on the next reload.
 */

/** The server's cap (`MAX_REMOTES`), mirrored only to disable `Add dashboard` at it; the server still enforces its own. */
const MAX_REMOTES = 8;

type Scope = 'form' | 'list' | 'suggest';
type Editing = { kind: 'home' } | { kind: 'new' } | { kind: 'edit'; name: string } | null;
type Remote = DashboardsView['dashboards'][number];

export function DashboardsPage() {
  const { view: loaded, error } = useDashboards();
  const { status } = useAgents();
  const { machines, reload: reloadMachines } = useMachines();
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
  // The machine the person last picked; `null` until they pick one, and `pickSelected` falls back to the first while it is not listed.
  const [wanted, setWanted] = useState<string | null>(null);

  if (view === null) {
    return (
      <div className="dash-page">
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
              error === null ? 'checking…' : `Could not read the dashboards — ${error}. This page will fill in once the API answers GET /api/dashboards again.`
            }
          />
        </SettingsGroup>
      </div>
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
      // A write can add, rename or remove a machine, so health and usage are asked again now rather than at the next minute.
      void reloadMachines();
      return true;
    } catch (e) {
      if (mounted.current) setNotice({ scope, message: e instanceof Error ? e.message : 'the dashboards were not saved' });
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const remotes = new Map(view.dashboards.map((d) => [d.name, d]));
  const ids = machineIds(view);
  const selected = pickSelected(ids, wanted);

  // One row per id, every value picked by name. Home's health is `useAgents`' status — the one its status line reads; a remote's is the machines read's.
  const rows: ListMachine[] = ids.map((id, at) => {
    const remote = id === HOME_MACHINE ? null : (remotes.get(id) as Remote);
    const health = remote === null ? status : statusFor(machines, id);
    return {
      id,
      label: remote === null ? view.home.label : remote.name,
      order: at + 1,
      home: remote === null,
      account: remote === null ? view.home.account : (remote.account ?? null),
      tone: dispatchDotTone(health) ?? undefined,
      usage: statusFor(machines, id)?.usage ?? null
    };
  });

  const move = (id: string, by: -1 | 1): void => {
    const at = ids.indexOf(id);
    const next = [...ids];
    [next[at], next[at + by]] = [next[at + by], next[at]];
    // By id, so the selection follows the machine to its new place — `wanted` may still be `null` from load.
    setWanted(id);
    void write('list', () => saveSuggestion({ order: next }));
  };

  const remove = async (name: string): Promise<void> => {
    setAsking(null);
    if (await write('list', () => deleteEntry(name))) setEditing((cur) => (cur?.kind === 'edit' && cur.name === name ? null : cur));
  };

  const choose = (id: string): void => {
    setWanted(id);
    setAsking(null);
    // A refused move or remove is about the machine it was sent for; it does not follow the selection to another one.
    setNotice((n) => (n?.scope === 'list' ? null : n));
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

  const controlsFor = (id: string, label: string): ReactNode => {
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
            setEditing(id === HOME_MACHINE ? { kind: 'home' } : { kind: 'edit', name: id });
          }}
        >
          Edit
        </Chip>
        {id !== HOME_MACHINE && (
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

  const full = view.dashboards.length >= MAX_REMOTES;
  const current = rows.find((r) => r.id === selected) as ListMachine;
  const currentRemote = selected === HOME_MACHINE ? null : (remotes.get(selected) as Remote);

  return (
    <div className="dash-page">
      {unreadable && (
        <Sheet className="dash-page-banner">
          <p className="set-hint">
            <code>{view.file}</code> exists and cannot be read — every remote is ignored and nothing can be saved until it is fixed or removed by hand.
          </p>
        </Sheet>
      )}

      <SuggestCard
        strategy={view.strategy}
        threshold={view.threshold}
        locked={locked}
        thresholdKey={thresholdNonce}
        onStrategy={(s) => void write('suggest', () => saveSuggestion({ strategy: s }))}
        onThreshold={(v) =>
          void write('suggest', () => saveSuggestion({ threshold: v })).then((ok) => {
            if (!ok && mounted.current) setThresholdNonce((n) => n + 1);
          })
        }
        notice={noticeFor('suggest')}
      />

      <div className="dash-page-cols">
        <DashboardsList
          machines={rows}
          selected={selected}
          onSelect={choose}
          add={
            <Chip
              size={28}
              icon="+"
              disabled={unreadable || full}
              title={full ? `at most ${MAX_REMOTES} dashboards` : undefined}
              onClick={() => {
                setNotice(null);
                setEditing({ kind: 'new' });
              }}
            >
              Add dashboard
            </Chip>
          }
        />
        <DashboardDetail
          machine={current}
          home={view.home}
          remote={currentRemote}
          agents={status}
          status={statusFor(machines, selected)}
          controls={controlsFor(selected, current.label)}
          notice={noticeFor('list')}
        />
      </div>

      <div className="dash-page-foot">
        <span className="set-hint">
          Saved to <code>{view.file}</code>
        </span>
        <span className="set-hint">
          Listed in prefer order — move a machine with ↑ ↓. Tokens are never entered here: each is an environment variable, set in .env.
        </span>
      </div>

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
            if (await write('form', () => saveEntry(entry, editing.kind === 'edit' ? editing.name : undefined))) {
              closeForm();
              // An Add or a rename: the fresh view the write answered already lists this name, so the selection lands on it.
              if (mounted.current) setWanted(entry.name);
            }
          }}
          error={noticeFor('form', true)}
        />
      )}
    </div>
  );
}
