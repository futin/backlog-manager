import { useEffect, useState } from 'react';

import { dispatchAgent, fetchAgentPlan, sessionUrl } from '../../lib/agents';
import { EFFORTS, MODELS } from '../../../../shared/agent';
import { useSettings } from '../../hooks/useSettings';
import type { AgentPlan, BacklogItem, PermissionMode } from '../../../../shared/types';

/**
 * LaunchSheet — the one extra tap between a card and a running Claude.
 *
 * It exists because dispatch is not a read: an `execute` launch edits code in
 * another repo with no human at a terminal. The sheet is where the prompt can
 * be read before it is sent, where the permission mode is chosen inside the
 * ceiling the host allows, and where "the dashboard cannot see this project"
 * surfaces before anything spawns rather than as a failed launch.
 *
 * The plan is re-fetched on open rather than passed down from the board's
 * status: the board's read may be minutes old, and the item may have been
 * groomed or archived in a terminal since.
 */
export function LaunchSheet({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  const { settings } = useSettings();
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionMode>('plan');
  // '' is the "default" option: no flag, so the CLI's own default stands.
  //
  // Seeded from Settings, and from nowhere else. The sheet still does not
  // remember your LAST pick — a sticky 'max' from last week quietly spending on
  // a trivial groom is the failure mode a per-launch control exists to prevent,
  // and that remains rejected. A default you set once, in a row you can go and
  // read, is the opposite arrangement: it is visible, it is stable, and nothing
  // moves it behind your back. `clampSettings` has already dropped anything
  // outside MODELS/EFFORTS, so this can only ever seed a value the selects
  // below actually offer.
  const [model, setModel] = useState(settings.dispatchDefaultModel);
  const [effort, setEffort] = useState(settings.dispatchDefaultEffort);
  const [remoteControl, setRemoteControl] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchAgentPlan(item.path)
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        setPrompt(p.prompt);
        setMode(p.defaultMode);
      })
      .catch((e: unknown) => {
        if (alive) setPlanError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [item.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const launch = (): void => {
    if (plan === null) return;
    setBusy(true);
    setError(null);
    dispatchAgent({
      itemPath: item.path,
      // The server's derivation, echoed back — and re-derived there before
      // anything spawns. Sending it makes a stale sheet fail loudly ("this
      // item's next step is groom") instead of quietly doing the wrong work.
      action: plan.action,
      prompt,
      permissionMode: mode,
      // Spread, not `model: model || undefined`: the key is absent from the
      // request rather than present-and-empty, which is the shape the server's
      // `pickFrom` and the dashboard's own parser both read as "no flag".
      ...(model === '' ? {} : { model }),
      ...(effort === '' ? {} : { effort }),
      remoteControl
    })
      .then((r) => setSessionId(r.sessionId))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const blocked = plan?.blocked ?? planError;

  return (
    <>
      <div className="sheet-backdrop" data-testid="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label={`dispatch ${item.id}`}>
        <div className="sheet-head">
          <span className="sheet-kicker">{plan === null ? 'dispatch' : plan.action}</span>
          <span className="sheet-title">{item.id} · {item.title}</span>
          <button className="drawer-close" onClick={onClose}>close</button>
        </div>

        {sessionId !== null ? (
          /* The form is gone on purpose: the session exists, and a second
             Launch would start a second one on the same item. */
          <div className="sheet-body">
            <div className="sheet-ok">launched · {sessionId}</div>
            <a className="sheet-link" href={sessionUrl(settings.linkBase, sessionId)} target="_blank" rel="noreferrer">
              open in dashboard ↗
            </a>
            <div className="sheet-note">
              Its questions appear there — and on your phone, if the dashboard's hooks are installed.
            </div>
          </div>
        ) : blocked !== null && blocked !== undefined ? (
          <div className="sheet-body">
            <div className="sheet-blocked">{blocked}</div>
          </div>
        ) : plan === null ? (
          <div className="sheet-body"><div className="drawer-empty">loading…</div></div>
        ) : (
          <div className="sheet-body">
            <label className="sheet-field">
              <span className="set-name">Project</span>
              <span className="sheet-static">{plan.project}</span>
            </label>

            <label className="sheet-field">
              <span className="set-name">Prompt</span>
              <textarea
                aria-label="Prompt"
                className="sheet-prompt"
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>

            {/* One row, three controls: "how should this run" is a single
                decision, and the dashboard's own launch panel groups the same
                three the same way. Stacked, they pushed Launch below the fold
                on a phone — the device this whole feature is aimed at. */}
            <div className="sheet-row">
              <label className="sheet-field">
                <span className="set-name">Permission mode</span>
                <select
                  aria-label="Permission mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as PermissionMode)}
                >
                  {/* Only what the host's ceiling can actually deliver: offering
                      a mode the dashboard would clamp is a promise this app
                      cannot keep. */}
                  {plan.allowedModes.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>

              {/* Same two pickers the dashboard's own launch panel offers, with
                  the same "default" first option, because this sheet is a second
                  front-end onto that one spawn. Neither list is clamped against
                  a host ceiling the way the modes above are — there is none —
                  so an unknown name costs the flag, not the launch. */}
              <label className="sheet-field">
                <span className="set-name">Model</span>
                <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">default</option>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>

              <label className="sheet-field">
                <span className="set-name">Effort</span>
                <select aria-label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">default</option>
                  {EFFORTS.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="sheet-check">
              <input
                type="checkbox"
                checked={remoteControl}
                onChange={(e) => setRemoteControl(e.target.checked)}
              />
              <span>remote control — the Claude phone app can see and drive it</span>
            </label>

            {error !== null && <div className="sheet-error">{error}</div>}

            <div className="sheet-actions">
              <button className="drawer-close" onClick={onClose}>cancel</button>
              <button className="sheet-launch" onClick={launch} disabled={busy || prompt.trim() === ''}>
                {busy ? 'launching…' : 'launch'}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
