import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { EFFORTS, MODELS, defaultBoardUrl } from '../../../../shared/agent';
import type { DashboardEntryInput, DashboardsView } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { FormSheet } from '../ui/FormSheet';

/**
 * DashboardSheet — the Dashboards page's add and edit forms (`.claude/DESIGN.md` §8.7 "Sheet", `FormSheet`'s fifth composer; the fields are §8.6's 36 px
 * family). One sheet, three shapes: `Add dashboard`, a remote's `Edit`, and Home's `Edit`. They used to open in place, under the row they edited, and a form
 * of seven fields inside a list of machines read as part of the list — it was hard to see where the form ended, which fields were the entry's and which were
 * the next row's lines. A sheet puts the whole entry in one place with the list out of the way behind the scrim, and its Save and Cancel pinned in a footer
 * that never scrolls off.
 *
 * The sheet owns the fields' state and nothing else: every write still goes through `DashboardsPage`'s one-at-a-time `write`, which answers the fresh view,
 * and the page closes the sheet only when the server stored it. A refusal stays open with what was typed, and the server's sentence (`error`, drawn by the
 * page) sits under the footer's buttons. Escape and the scrim are the shell's (`useDialogEscape`, one of the stack's eight dialogs).
 *
 * Only Name and Dashboard URL are required: a blank Board URL or Machine name is sent as absent and the server stores its default (`validateEntry`), which the
 * field shows as its placeholder — `defaultBoardUrl` of the URL typed so far, and the name — so what the form promises is what the file gets. Models and
 * efforts are checkboxes; every box ticked is sent as NO list (home: `null`, which clears it), because absent means "the whole list" on the server and a stored
 * full list would silently stop following `MODELS` the day it grows. None ticked disables Save with the reason — the server would refuse an empty list, and a
 * button that can only fail is the silent no-op this page avoids. A new entry whose name already exists is held here too: the server treats a same-name POST
 * as an UPDATE (that is how Save on an edit works), so without the hold `Add dashboard` would overwrite a row in silence.
 *
 * **Home's models and efforts are editable, and narrow nothing.** They are what a remote launch would be limited to if home were one, kept so a home entry
 * reads like the others; home's own launch sheets behave exactly as before, so this sheet puts no hint beside them that suggests otherwise.
 */

type Remote = DashboardsView['dashboards'][number];

export type HomePatch = { label: string | null; account: string | null; models: string[] | null; efforts: string[] | null };

type Common = { busy: boolean; error: ReactNode; onClose: () => void };

/** An empty list from a stub or an older server means "no narrowing" — the whole list, ticked. */
export function ticked(list: string[], all: readonly string[]): string[] {
  return list.length === 0 ? [...all] : list;
}

export function DashboardSheet(
  props: Common &
    (
      | { kind: 'home'; view: DashboardsView; onSave: (patch: HomePatch) => void }
      | {
          kind: 'remote';
          /** `null` for `Add dashboard`. */
          initial: Remote | null;
          /** The OTHER entries' names — the ones this form's name may not repeat. */
          taken: string[];
          onSave: (entry: DashboardEntryInput) => void;
        }
    )
) {
  return props.kind === 'home' ? <HomeSheet {...props} /> : <RemoteSheet {...props} />;
}

function HomeSheet({ view, busy, error, onClose, onSave }: Common & { view: DashboardsView; onSave: (patch: HomePatch) => void }) {
  const [label, setLabel] = useState(view.home.label);
  const [account, setAccount] = useState(view.home.account ?? '');
  const [models, setModels] = useState(ticked(view.home.models, MODELS));
  const [efforts, setEfforts] = useState(ticked(view.home.efforts, EFFORTS));
  const why = models.length === 0 ? 'tick at least one model' : efforts.length === 0 ? 'tick at least one effort' : null;

  return (
    <FormSheet
      label={`Edit ${view.home.label}`}
      title={
        <>
          <span className="sheet-kicker">edit home</span>
          <span className="sheet-title">{view.home.label}</span>
        </>
      }
      onClose={onClose}
      footer={
        <Footer
          canSave={why === null}
          busy={busy}
          note={why ?? 'this machine — its URL and token come from .env'}
          error={error}
          onCancel={onClose}
          onSave={() =>
            onSave({
              label: label.trim() === '' ? null : label.trim(),
              account: account.trim() === '' ? null : account.trim(),
              models: models.length === MODELS.length ? null : models,
              efforts: efforts.length === EFFORTS.length ? null : efforts
            })
          }
        />
      }
    >
      <Field
        label="Label"
        hint="What a card and a launch sheet call this machine. Empty goes back to Home."
        value={label}
        onChange={setLabel}
        disabled={busy}
      />
      <Field
        label="Account"
        hint="Optional — the plan or login this machine runs on, shown beside the label."
        value={account}
        onChange={setAccount}
        disabled={busy}
      />
      <Checks legend="Models" all={MODELS} value={models} onChange={setModels} disabled={busy} />
      <Checks legend="Efforts" all={EFFORTS} value={efforts} onChange={setEfforts} disabled={busy} />
    </FormSheet>
  );
}

function RemoteSheet({
  initial,
  taken,
  busy,
  error,
  onClose,
  onSave
}: Common & { initial: Remote | null; taken: string[]; onSave: (entry: DashboardEntryInput) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [bmUrl, setBmUrl] = useState(initial?.bmUrl ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [account, setAccount] = useState(initial?.account ?? '');
  const [models, setModels] = useState(ticked(initial?.models ?? [], MODELS));
  const [efforts, setEfforts] = useState(ticked(initial?.efforts ?? [], EFFORTS));

  const trimmed = name.trim();
  // A NEW entry that repeats an existing name would be an UPDATE of it on the server (the same-name POST is how Save on an edit works), so it is held here;
  // a case-only clash with another entry the server refuses itself, with its own sentence, and that sentence is shown.
  const clash = initial === null && taken.some((n) => n === trimmed);
  const why = clash
    ? `a dashboard named "${trimmed}" already exists`
    : models.length === 0
      ? 'tick at least one model'
      : efforts.length === 0
        ? 'tick at least one effort'
        : null;
  const complete = trimmed !== '' && url.trim() !== '';

  return (
    <FormSheet
      label={initial === null ? 'Add dashboard' : `Edit dashboard ${initial.name}`}
      title={
        <>
          <span className="sheet-kicker">{initial === null ? 'add dashboard' : 'edit dashboard'}</span>
          <span className="sheet-title">{initial === null ? 'New dashboard' : initial.name}</span>
        </>
      }
      onClose={onClose}
      footer={
        <Footer
          canSave={complete && why === null}
          busy={busy}
          note={why ?? (complete ? null : 'needs a Name and a Dashboard URL')}
          error={error}
          onCancel={onClose}
          onSave={() => {
            // A blank Board URL or Machine name is left out, and the server stores the default the placeholder shows.
            const entry: DashboardEntryInput = { name: trimmed, url: url.trim() };
            if (bmUrl.trim() !== '') entry.bmUrl = bmUrl.trim();
            if (host.trim() !== '') entry.host = host.trim();
            if (account.trim() !== '') entry.account = account.trim();
            // Every box ticked is NO list: absent means the whole list, and follows `MODELS` when it grows.
            if (models.length !== MODELS.length) entry.models = models;
            if (efforts.length !== EFFORTS.length) entry.efforts = efforts;
            onSave(entry);
          }}
        />
      }
    >
      <Field
        label="Name"
        hint={
          <>
            Letters and digits, starting with a letter. Its token is <code>BM_AGENTS_TOKEN_{trimmed === '' ? '<NAME>' : trimmed.toUpperCase()}</code>.
          </>
        }
        value={name}
        onChange={setName}
        placeholder="Pro"
        disabled={busy}
      />
      <Field
        label="Dashboard URL"
        hint="The claude-agents-dashboard on that machine."
        value={url}
        onChange={setUrl}
        placeholder="http://pro.tailnet.ts.net:4173"
        disabled={busy}
      />
      <Field
        label="Board URL"
        hint="Optional — the backlog-manager on that machine. Blank is the dashboard's host on the board's default port."
        value={bmUrl}
        onChange={setBmUrl}
        placeholder={defaultBoardUrl(url.trim()) ?? 'http://pro.tailnet.ts.net:5177'}
        disabled={busy}
      />
      <Field
        label="Machine name"
        hint={
          <>
            Optional — blank is the name. Must equal <code>BM_MACHINE_NAME</code> in that machine's shell environment — it is how a claim says where it runs.
          </>
        }
        value={host}
        onChange={setHost}
        placeholder={trimmed === '' ? 'Pro' : trimmed}
        disabled={busy}
      />
      <Field
        label="Account"
        hint="Optional — the plan or login that machine runs on, shown beside its name."
        value={account}
        onChange={setAccount}
        disabled={busy}
      />
      <Checks legend="Models" all={MODELS} value={models} onChange={setModels} disabled={busy} />
      <Checks legend="Efforts" all={EFFORTS} value={efforts} onChange={setEfforts} disabled={busy} />
    </FormSheet>
  );
}

/** A labelled text field and, under it, the sentence that says what to put in it. */
function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  disabled
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="dash-field">
      <label className="set-name" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="set-text dash-text"
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && (
        <span className="set-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** A group of checkboxes over one fixed list (`MODELS` / `EFFORTS`). */
function Checks({
  legend,
  all,
  value,
  onChange,
  disabled
}: {
  legend: string;
  all: readonly string[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="dash-checks" disabled={disabled}>
      <legend className="set-name">{legend}</legend>
      {all.map((item) => (
        <label key={item} className="dash-check">
          <input
            type="checkbox"
            checked={value.includes(item)}
            onChange={(e) => onChange(all.filter((x) => (x === item ? e.target.checked : value.includes(x))))}
          />
          {item}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The pinned footer: a note on the left — why Save is off when it is, otherwise what this sheet is about — then Cancel and Save, and the server's refusal
 * under them (`error`, drawn by the group). Save reads `saving…` while the write is out.
 */
function Footer({
  canSave,
  busy,
  note,
  onSave,
  onCancel,
  error
}: {
  canSave: boolean;
  busy: boolean;
  note: string | null;
  onSave: () => void;
  onCancel: () => void;
  error: ReactNode;
}) {
  return (
    <div className="dash-sheet-foot">
      <div className="dash-actions">
        <span className="dash-sheet-note">{note}</span>
        <Chip size={28} variant="flat" disabled={busy} onClick={onCancel}>
          Cancel
        </Chip>
        <Chip size={28} variant="ink" disabled={!canSave || busy} onClick={onSave}>
          {busy ? 'saving…' : 'Save'}
        </Chip>
      </div>
      {error}
    </div>
  );
}
