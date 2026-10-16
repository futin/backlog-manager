import { useEffect, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useMountedRef } from '../../hooks/useMountedRef';
import { useNow } from '../../hooks/useNow';
import { JIRA_CUSTOM_QUERY, JIRA_QUERY_PRESETS, type JiraQueryPreset } from '../../lib/jira';
import { pollAge } from '../../lib/tracker';
import { DEFAULT_JIRA_INTERVAL, SYNC_INTERVALS, type JiraBoard, type JiraIssue, type SyncInterval } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { FormSheet } from '../ui/FormSheet';
import { Popover } from '../ui/Popover';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { SettingsRow } from '../ui/SettingsRow';

/**
 * JiraBoardSheet — create or edit one board (Jira phase 2, spec §6.4; `BoardSheet.html`, `NewBoard.html`; DESIGN.md §8.9.3, and §8.7 for the shell).
 *
 * One sheet serves both: `board: null` is a new board — titled `New board`, interval `1m` (`DEFAULT_JIRA_INTERVAL`), its action `Create board` and no
 * `Delete board` — and a board is an edit of it, every field seeded from it once, at mount. Seeded ONCE on purpose: Save reloads `GET /api/jira`, and so does
 * the status poll while the sheet is open, so a sheet that re-read its board from every new status would throw away a person's half-typed edit the moment
 * the server's clock ticked. The status the sheet was opened from is the one it edits; the server is the judge of whether that board still exists (404).
 *
 * Three sections, in the mock's order:
 *
 * - **Name & sync** — two `SettingsRow`s (§8.6's row, the same one Setup's cards draw): the name in a `.set-text`, the interval as a `Segmented` pill over
 *   `SYNC_INTERVALS`, the same control the Trackers card draws for a GitHub repo's interval, so the two read alike.
 * - **Roots** — the keys, one row each with ×, and a search field whose `Popover` lists `/api/jira/search` answers; a pick adds the key. Only the KEY is
 *   stored (`JiraBoard.roots` is `string[]`), so a row reads the key alone: the summary shown in the popover is not kept, and an edited board's roots arrive
 *   without one — fetching each to draw a summary would be twenty Jira calls to decorate a list the person already knows.
 * - **Queries** — the four chips (`JIRA_QUERY_PRESETS` and `JIRA_CUSTOM_QUERY`, R5; the leading `+ ` is drawn here, the presets store their chip text
 *   without it) and a row per query: label `.set-text`, JQL `.sheet-prompt` textarea, and the check line.
 *
 * **Every refusal keeps the sheet.** Save and Delete leave it open on any answer but a 200, with every edit where the person left it and the server's own
 * `error` sentence under the footer (Review Focus 2: a `jira.json` that stopped parsing while the sheet was open answers 409, and the sentence says what
 * to do about it — nothing was written, so nothing here may pretend it was). Validation is the server's alone (`parseBoardWrite`, which names the field);
 * the sheet repeats only the one rule a person cannot miss — a name and at least one root or query — as the disabled action, because a button that is
 * clickable and then refuses for an empty form teaches nothing.
 *
 * **A save waits for its sweep.** The route answers after the poller has swept the saved board, bounded at `JIRA_SAVE_SWEEP_WAIT_MS` (20 s, R2), so the
 * action reads `saving…` for that long at most and the reload that follows shows the board already polled. The cap is the server's; the sheet adds no
 * timer of its own, and a server that never answered would leave `saving…` up with Cancel still live.
 *
 * Escape: the shell (`FormSheet`) is on `useDialogEscape`'s stack, and the two things this sheet opens over itself — the roots `Popover` and the delete
 * `Confirm` — each join the stack while drawn, so a press closes the topmost of them and nothing under it (CLAUDE.md "Escape has one owner…").
 */

/** How long the JQL check waits after the last keystroke — the spec's 500 ms (§6.4), the one home of the number. */
export const JIRA_JQL_CHECK_DEBOUNCE_MS = 500;

/**
 * The same wait for the roots search, shorter: a search is a pick a person is waiting to see, where the check line is a verdict they read once they stop.
 * Debounced at all because every keystroke would otherwise be one Jira search (`/api/jira/search` calls Jira per request; nothing caches it).
 */
export const JIRA_ROOT_SEARCH_DEBOUNCE_MS = 300;

/** A query row as the sheet holds it: the stored id (R3 — kept only for a row that came from the board), plus a local key React can reconcile on. */
interface QueryRowState {
  key: number;
  id: string | null;
  label: string;
  jql: string;
}

export type JiraProjectList = { list: { key: string; name: string }[] | null; error: string | null };

const INTERVAL_OPTIONS = (Object.keys(SYNC_INTERVALS) as SyncInterval[]).map((value) => ({ value, label: value }));

/**
 * The `error` sentence of a refused write or read, or `fallback` when the body carries none (a proxy's HTML 502, an empty body). Exported for Setup's project
 * read, so a refusal reads the same way wherever this page reports one.
 */
export function errorOf(body: unknown, fallback: string): string {
  return typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : fallback;
}

/** Every write here goes out as JSON: the server's `SameOriginPostGuard` refuses any other content type with a 403. Exported for the Repositories card's write. */
export async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

export function JiraBoardSheet({
  board,
  projects,
  onClose,
  onSaved
}: {
  /** The board to edit, or `null` for a new one. Read once, at mount (see the header). */
  board: JiraBoard | null;
  /** `JiraSetupView`'s one `/api/jira/projects` read, for the `Unresolved in a project…` chip's `Select`. The sheet never fetches it itself. */
  projects: JiraProjectList;
  onClose: () => void;
  /** Called with the board as the server stored it, after the status reload has been asked for. The caller closes the sheet. */
  onSaved: (saved: JiraBoard) => void;
}) {
  const { reload } = useJiraContext();
  const mounted = useMountedRef();
  const nextKey = useRef(0);
  const [name, setName] = useState(board?.name ?? '');
  const [interval, setSyncInterval] = useState<SyncInterval>(board?.interval ?? DEFAULT_JIRA_INTERVAL);
  const [roots, setRoots] = useState<string[]>(board?.roots ?? []);
  const [rows, setRows] = useState<QueryRowState[]>(() => (board?.queries ?? []).map((q) => ({ key: nextKey.current++, ...q })));
  const [pickingProject, setPickingProject] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim() !== '' && (roots.length > 0 || rows.length > 0);

  const addRow = (preset: JiraQueryPreset, projectKey?: string): void => {
    const fill = (s: string): string => (projectKey === undefined ? s : s.split('<KEY>').join(projectKey));
    setRows((rs) => [...rs, { key: nextKey.current++, id: null, label: fill(preset.label), jql: fill(preset.jql) }]);
  };
  const patchRow = (key: number, patch: Partial<Pick<QueryRowState, 'label' | 'jql'>>): void =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save(): Promise<void> {
    setBusy('save');
    setError(null);
    try {
      const answer = await postJson('/api/jira/boards', {
        id: board?.id ?? null,
        name,
        interval,
        roots,
        queries: rows.map((r) => ({ id: r.id, label: r.label, jql: r.jql }))
      });
      // A landed save reloads the status even when the sheet was closed (Escape, Cancel) while it was in flight: the write happened, and the card under the
      // sheet would otherwise read the pre-save board until the next status poll — which, for a page of `off` boards, is never (R2's own reason).
      if (answer.ok) reload();
      if (!mounted.current) return;
      if (!answer.ok) {
        setError(errorOf(answer.body, `the board was not saved (HTTP ${answer.status})`));
        return;
      }
      onSaved(answer.body as JiraBoard);
    } catch {
      if (mounted.current) setError('the board was not saved — the server did not answer');
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    if (board === null) return;
    setConfirming(false);
    setBusy('delete');
    setError(null);
    try {
      const answer = await postJson('/api/jira/boards/delete', { id: board.id });
      // Reloaded even if the sheet is already gone, for the reason Save gives.
      if (answer.ok) reload();
      if (!mounted.current) return;
      if (!answer.ok) {
        setError(errorOf(answer.body, `the board was not deleted (HTTP ${answer.status})`));
        return;
      }
      onClose();
    } catch {
      if (mounted.current) setError('the board was not deleted — the server did not answer');
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const unresolved = JIRA_QUERY_PRESETS.find((p) => p.label.includes('<KEY>'));

  return (
    <FormSheet
      label={board === null ? 'New board' : `Edit board ${board.name}`}
      title={
        <>
          <span className="sheet-kicker">{board === null ? 'new board' : 'edit board'}</span>
          <span className="sheet-title">{board === null ? 'New board' : board.name}</span>
        </>
      }
      onClose={onClose}
      footer={
        <div className="jira-sheet-foot">
          <div className="jira-sheet-actions">
            {board !== null &&
              (confirming ? (
                <Confirm
                  label="Delete board"
                  testId="jira-board-delete"
                  acceptLabel="Delete"
                  dismissLabel="Keep"
                  onAccept={() => void remove()}
                  onDismiss={() => setConfirming(false)}
                >
                  Delete {board.name}? Its roots and queries go from this machine; Jira is untouched.
                </Confirm>
              ) : (
                <Chip size={28} variant="danger" disabled={busy !== null} onClick={() => setConfirming(true)}>
                  {busy === 'delete' ? 'deleting…' : 'Delete board'}
                </Chip>
              ))}
            <span className="jira-sheet-note">{board === null ? 'polled right after you create it' : 'polled again right after you save'}</span>
            <Chip size={28} variant="flat" onClick={onClose}>
              Cancel
            </Chip>
            <Chip
              size={28}
              variant="ink"
              disabled={!ready || busy !== null}
              title={ready ? undefined : 'needs a name and at least one root or query'}
              onClick={() => void save()}
            >
              {busy === 'save' ? 'saving…' : board === null ? 'Create board' : 'Save'}
            </Chip>
          </div>
          {error !== null && (
            <div className="jira-sheet-error" role="alert">
              {error}
            </div>
          )}
        </div>
      }
    >
      <section className="jira-sheet-sec" aria-label="Name & sync">
        <SettingsRow name="Name" hint="how the picker and this page call it">
          <input className="set-text jira-sheet-name" type="text" aria-label="Board name" value={name} onChange={(e) => setName(e.target.value)} />
        </SettingsRow>
        <SettingsRow name="Sync interval" hint="how often this machine asks Jira for this board">
          <Segmented pill label="Sync interval" value={interval} options={INTERVAL_OPTIONS} onChange={setSyncInterval} />
        </SettingsRow>
      </section>

      <section className="jira-sheet-sec" aria-label="Roots">
        <h4 className="jira-sheet-sec-title">Roots</h4>
        <p className="jira-sheet-why">
          An epic, story or task to follow with everything under it — three levels deep, so an epic brings its stories and their subtasks.
        </p>
        {roots.length === 0 ? (
          <p className="jira-sheet-empty">No roots yet — search below to add one. A board needs at least one root or one query.</p>
        ) : (
          roots.map((key) => (
            <div key={key} className="jira-sheet-root">
              <span className="jira-sheet-key">{key}</span>
              <button type="button" className="jira-sheet-x" aria-label={`Remove ${key}`} onClick={() => setRoots((rs) => rs.filter((r) => r !== key))}>
                ×
              </button>
            </div>
          ))
        )}
        <RootSearch roots={roots} onPick={(key) => setRoots((rs) => (rs.includes(key) ? rs : [...rs, key]))} />
      </section>

      <section className="jira-sheet-sec" aria-label="Queries">
        <h4 className="jira-sheet-sec-title">Queries</h4>
        <p className="jira-sheet-why">
          JQL, run as you on every poll. Start from a preset or write your own; the line under each one is Jira&apos;s answer, checked when you stop typing.
        </p>
        <div className="jira-sheet-presets">
          {JIRA_QUERY_PRESETS.map((preset) =>
            preset === unresolved && pickingProject ? (
              <ProjectPick key={preset.chip} projects={projects} onPick={(k) => {
                  setPickingProject(false);
                  addRow(preset, k);
                }} />
            ) : (
              <Chip key={preset.chip} size={28} onClick={() => {
                  if (preset === unresolved) setPickingProject(true);
                  else addRow(preset);
                }}>
                {`+ ${preset.chip}`}
              </Chip>
            )
          )}
          <Chip size={28} onClick={() => addRow(JIRA_CUSTOM_QUERY)}>
            {`+ ${JIRA_CUSTOM_QUERY.chip}`}
          </Chip>
        </div>
        {rows.length === 0 && <p className="jira-sheet-empty">No queries yet.</p>}
        {rows.map((row) => (
          <QueryRow
            key={row.key}
            row={row}
            onChange={(patch) => patchRow(row.key, patch)}
            onRemove={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
          />
        ))}
      </section>
    </FormSheet>
  );
}

/**
 * The `Unresolved in a project…` chip's `Select`, drawn in the chip's place while open (R5). Its first option is a placeholder so that picking the first
 * real project is a change; a pick adds the row and puts the chip back. The list is `JiraSetupView`'s one read; while it is still loading the `Select` is
 * disabled, and a failed read says so rather than offering an empty list that reads as "no projects".
 */
function ProjectPick({ projects, onPick }: { projects: JiraProjectList; onPick: (key: string) => void }) {
  if (projects.error !== null) return <span className="jira-sheet-error">{projects.error}</span>;
  const options = [
    { value: '', label: projects.list === null ? 'loading projects…' : 'pick a project…' },
    ...(projects.list ?? []).map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))
  ];
  return <Select label="Project" value="" options={options} disabled={projects.list === null} onChange={(k) => k !== '' && onPick(k)} />;
}

/**
 * The roots search: a field and, once Jira has answered for its text, a `Popover` of the matches (key and summary). The request carries the field's text,
 * trimmed and URL-encoded, `JIRA_ROOT_SEARCH_DEBOUNCE_MS` after the last keystroke; a blank field sends nothing. Only the newest request may write — a slow
 * answer for `pa` must not replace the list for `pay` — and a refusal (Jira's 400 on a reserved character is the server's 409, spec §5) is the server's
 * sentence under the field, with no popover.
 *
 * The popover's anchor is the field's wrapper, so a press in the field does not count as "outside" and typing on keeps the list up; Escape closes the list
 * first, then (a second press) the sheet.
 */
function RootSearch({ roots, onPick }: { roots: readonly string[]; onPick: (key: string) => void }) {
  const mounted = useMountedRef();
  const wrap = useRef<HTMLDivElement>(null);
  const latest = useRef(0);
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<JiraIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const term = text.trim();
    const mine = ++latest.current;
    if (term === '') {
      setMatches(null);
      setError(null);
      setOpen(false);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/jira/search?q=${encodeURIComponent(term)}`);
          const body: unknown = await res.json().catch(() => null);
          if (!mounted.current || mine !== latest.current) return;
          if (!res.ok) {
            setError(errorOf(body, `the search failed (HTTP ${res.status})`));
            setOpen(false);
            return;
          }
          setError(null);
          setMatches(Array.isArray(body) ? (body as JiraIssue[]) : []);
          setOpen(true);
        } catch {
          if (mounted.current && mine === latest.current) setError('the search failed — the server did not answer');
        }
      })();
    }, JIRA_ROOT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, mounted]);

  const pick = (key: string): void => {
    onPick(key);
    setText('');
  };

  return (
    <div className="jira-sheet-search" ref={wrap}>
      <input
        className="set-text jira-sheet-search-field"
        type="text"
        aria-label="Search issues"
        placeholder="a key, or words from the summary"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error !== null && <div className="jira-sheet-error">{error}</div>}
      {open && matches !== null && (
        <Popover label="Matches" width={420} anchor={wrap} onClose={() => setOpen(false)}>
          {matches.length === 0 ? (
            <p className="jira-sheet-empty">no matches</p>
          ) : (
            matches.map((m) => {
              const already = roots.includes(m.key);
              return (
                <button key={m.key} type="button" className="jira-sheet-match" disabled={already} onClick={() => pick(m.key)}>
                  <span className="jira-sheet-key">{m.key}</span>
                  <span className="jira-sheet-match-summary">{m.summary}</span>
                  {already && <span className="jira-sheet-match-meta">already a root</span>}
                </button>
              );
            })
          )}
        </Popover>
      )}
    </div>
  );
}

type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok'; count: number; at: string } | { kind: 'bad'; message: string; at: string };

/**
 * One query row: label, JQL, and the check line — `/api/jira/jql/check` for the row's JQL, `JIRA_JQL_CHECK_DEBOUNCE_MS` after the last edit (so three
 * keystrokes 100 ms apart are ONE request), and again for a row that arrives with JQL (a preset, or an edited board's stored query), so every row says
 * whether Jira accepts it before Save is pressed. `4 issues match · checked 3 s ago` (the age through `pollAge`, R9), or Jira's parse message in red — the
 * server folds a parse error and the count call's refusal of an unbounded query into one `{ ok: false, message }` (spec §5). A refused CHECK (400, 503) is
 * red too, with the server's sentence: a line that said nothing then would read as a JQL nobody had looked at.
 */
function QueryRow({
  row,
  onChange,
  onRemove
}: {
  row: QueryRowState;
  onChange: (patch: Partial<Pick<QueryRowState, 'label' | 'jql'>>) => void;
  onRemove: () => void;
}) {
  const mounted = useMountedRef();
  const latest = useRef(0);
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const now = useNow(check.kind === 'ok' || check.kind === 'bad', 1_000);

  useEffect(() => {
    const jql = row.jql.trim();
    const mine = ++latest.current;
    if (jql === '') {
      setCheck({ kind: 'idle' });
      return;
    }
    const timer = setTimeout(() => {
      setCheck({ kind: 'checking' });
      void (async () => {
        try {
          const res = await fetch(`/api/jira/jql/check?jql=${encodeURIComponent(jql)}`);
          const body: unknown = await res.json().catch(() => null);
          if (!mounted.current || mine !== latest.current) return;
          const at = new Date().toISOString();
          const b = (typeof body === 'object' && body !== null ? body : {}) as { ok?: unknown; count?: unknown; message?: unknown };
          if (res.ok && b.ok === true && typeof b.count === 'number') setCheck({ kind: 'ok', count: b.count, at });
          else if (res.ok && b.ok === false && typeof b.message === 'string') setCheck({ kind: 'bad', message: b.message, at });
          else setCheck({ kind: 'bad', message: errorOf(body, `the check failed (HTTP ${res.status})`), at });
        } catch {
          if (!mounted.current || mine !== latest.current) return;
          setCheck({ kind: 'bad', message: 'the check failed — the server did not answer', at: new Date().toISOString() });
        }
      })();
    }, JIRA_JQL_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [row.jql, mounted]);

  const checked = (at: string): string => `checked ${pollAge(at, now) ?? '0 s'} ago`;

  return (
    <div className="jira-sheet-query">
      <div className="jira-sheet-query-head">
        <input className="set-text" type="text" aria-label="Query label" value={row.label} onChange={(e) => onChange({ label: e.target.value })} />
        <button type="button" className="jira-sheet-x" aria-label={`Remove query ${row.label}`} onClick={onRemove}>
          ×
        </button>
      </div>
      <textarea
        className={check.kind === 'bad' ? 'sheet-prompt jira-sheet-jql bad' : 'sheet-prompt jira-sheet-jql'}
        aria-label="JQL"
        rows={2}
        value={row.jql}
        onChange={(e) => onChange({ jql: e.target.value })}
      />
      {check.kind === 'checking' && <div className="jira-sheet-check">checking…</div>}
      {check.kind === 'ok' && (
        <div className="jira-sheet-check ok">{`${check.count} ${check.count === 1 ? 'issue matches' : 'issues match'} · ${checked(check.at)}`}</div>
      )}
      {check.kind === 'bad' && (
        <div className="jira-sheet-check bad">
          <span>{check.message}</span>
          <span className="jira-sheet-check-when">{checked(check.at)}</span>
        </div>
      )}
    </div>
  );
}
