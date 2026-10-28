import { useId, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useFetched } from '../../hooks/useFetched';
import { useMountedRef } from '../../hooks/useMountedRef';
import { displayPath, fetchJiraRefs, fetchJiraWorktrees, repoWorktrees, saveRepoDefaults, treeLiveKey, unmappedProjects } from '../../lib/jira';
import { defaultBaseProblem, patternProblem } from '../../../../shared/jira-branch';
import type { JiraRepoDefaults, JiraStatusPayload, JiraWorktree, JiraWorktreesPayload } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Pill } from '../ui/Pill';
import { Select } from '../ui/Select';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { errorOf, postJson } from '../../lib/http';
import type { JiraProjectList } from './JiraBoardSheet';
import { WorktreeRow } from './JiraWorktreeRow';

/**
 * Jira › Setup › Repositories (Jira phase 2, spec §6.4; DESIGN.md §8.9.3, and §8.6 for the card language) — which local checkouts a Jira project's tickets
 * are worked in. It is `jira.json`'s `repos` map, one project key to a list of absolute paths, and the only thing on this page that is not about boards.
 *
 * - **One row per mapped path**, the project (`PAY · Payments` on the project's first row, the bare key on its later ones — the name once is enough), the
 *   path through `displayPath` (`$HOME` as `~`, from the status' own `home`), and a `×`. The names come from the STATUS' `projects`, the union of every
 *   key seen on a board and every mapped key, so a mapped project no board shows any more still reads by key.
 * - **A warning row per `unmappedProjects` entry** — a project with issues on some board and no path — in the words the spec gives, after the mapped rows.
 * - **The add row**: a project `Select` over `/api/jira/projects`, a path field and `Add`. That list is `JiraSetupView`'s ONE read, handed down: this card
 *   never fetches it, so a status reload (a save here, a focus, the poll) costs Jira nothing. A list that could not be read is said under the row, in the
 *   server's sentence, and the Select stays disabled — mapped rows above it still read and still remove.
 *
 * **A path's defaults** (Jira repo/branch, spec §5.1; DESIGN.md §8.9.3): under the FIRST row of each distinct path — the defaults belong to the path, not to a
 * project, so a checkout mapped to two projects has one line — two fields and `Save`: the base a New worktree is cut from (placeholder `e.g. develop`) and the
 * pattern its branch is named by (`{key}-{slug}`). Each is stored per PATH through `POST /api/jira/repo-defaults`, both values always sent and an empty field
 * as `null` (unset), and a refusal is the server's sentence in the SAME error slot the path writes use. The row reads the path's refs once on mount
 * (`fetchJiraRefs(path, null)`, never again on a status reload): readable, the branch names are offered on the base field; unreadable, the row says
 * `branches unavailable — <path> <reason>` and both fields stay usable, because a repo that cannot be listed from the board may still be fine on the host.
 * `patternProblem` is an instant HINT while the pattern is typed — the same rules the server applies, so the sentence is rarely a surprise — and it never
 * blocks Save: the server's sentence is the one that counts, and a client rule that drifted ahead of it would refuse a pattern the server accepts. The base
 * gets the same kind of hint from `defaultBaseProblem` (final review M1): it was `origin/HEAD` the old placeholder invited, and a stored `origin/` prefix is
 * a value the tool refuses at every Start, so the row says `base is a branch name, without origin/` as it is typed rather than after the first failed run.
 *
 * **A path's worktrees** (M7, the repo/branch final review; DESIGN.md §8.9.3): under the same first row, every tree the path has open beside its own checkout
 * (`repoWorktrees`), ticket or not, as the issue modal's `WorktreeRow` — branch, `~` path, a `Remove` that copies the command. The card and the modal find a
 * tree by the key its branch carries, so a Continue on `develop` or `hotfix/login` makes a tree neither ever shows; this is the one place it is still seen
 * and still removable. `GET /api/jira/worktrees` is read once on mount and again only when the set of mapped paths or of live keys changes (the moments a
 * tree can appear), never on a status reload; the last answer is kept while a re-read is out, so a mapping write does not blank every list for a frame. A
 * failed read draws no list anywhere, as on the card: the defaults row above already says when a path cannot be read. A row is disabled while a live key's
 * session is on it (`treeLiveKey`), which only a key-carrying branch can show — a key-less tree's `Remove` keeps the title that says so.
 *
 * **A write replaces one project's whole list** (`POST /api/jira/repos` `{ project, paths }`, spec §5), so `×` sends the list minus that path and `Add` the
 * list plus the typed one. An emptied list removes the key, which is how a project becomes unmapped again. The typed path goes out TRIMMED but otherwise as
 * typed — `~/ops` stays `~/ops`: the SERVER expands `~` and normalises, so the browser holds no second normaliser to drift from it, and the one spelling
 * the server stores is what the status then reads back. A refusal (400 with the path's sentence, 409 for a `jira.json` that cannot be read, 503) is shown
 * under the add row in the server's words and changes nothing locally: the typed path stays in the field and a refused `×` removes no row — the card only
 * ever draws what the status says is stored. A landed write reloads the status even if this page has gone (`reload` is the shell's, which outlives it),
 * for the reason `JiraBoardSheet`'s save does.
 */
export function JiraReposGroup({ projects }: { projects: JiraProjectList }) {
  const { data, reload } = useJiraContext();
  const mounted = useMountedRef();
  const [project, setProject] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repos = data?.repos ?? {};
  const names = new Map((data?.projects ?? []).map((p) => [p.key, p.name]));
  const mapped = Object.keys(repos)
    .sort()
    .map((key) => ({ key, paths: listOf(repos, key) }));
  const unmapped = data === null ? [] : unmappedProjects(data);
  const home = data?.home ?? null;
  const shownDefaults = new Set<string>();

  const distinctPaths = [...new Set(mapped.flatMap((m) => m.paths))].sort().join('\n');
  const liveKeys = Object.keys(data?.live ?? {}).sort();
  const trees = useFetched(data === null ? null : () => fetchJiraWorktrees(), [distinctPaths, liveKeys.join(',')]);
  const keptTrees = useRef<JiraWorktreesPayload | null>(null);
  if (trees.status === 'ok' && trees.value !== null) keptTrees.current = trees.value;
  else if (trees.status === 'failed') keptTrees.current = null;
  const kept = keptTrees.current;

  /** POST the project's whole new list. Resolves `true` when the server stored it. */
  async function write(key: string, paths: string[]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const answer = await postJson('/api/jira/repos', { project: key, paths });
      if (answer.ok) reload();
      if (!mounted.current) return answer.ok;
      if (!answer.ok) setError(errorOf(answer.body, `the repositories were not saved (HTTP ${answer.status})`));
      return answer.ok;
    } catch {
      if (mounted.current) setError('the repositories were not saved — the server did not answer');
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** POST one path's two defaults. Resolves `true` when the server stored them; the refusal is the server's sentence, in the same slot as the path writes'. */
  async function saveDefaults(target: string, base: string | null, namePattern: string | null): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await saveRepoDefaults(target, base, namePattern);
      reload();
      return true;
    } catch (e) {
      if (mounted.current) setError(defaultsFailure(e));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function add(): Promise<void> {
    const typed = path.trim();
    if (project === '' || typed === '') return;
    if (await write(project, [...listOf(repos, project), typed]) && mounted.current) setPath('');
  }

  const options = [{ value: '', label: 'project…' }, ...(projects.list ?? []).map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }))];

  return (
    <SettingsGroup
      title="Repositories"
      scope="this machine · which local checkouts a Jira project's tickets are worked in · set up front, before any ticket is on a board"
    >
      {mapped.flatMap(({ key, paths }) =>
        paths.flatMap((p, i) => {
          const row = (
            <SettingsRow key={`${key}\n${p}`} name={i === 0 ? projectLabel(key, names) : key} hint={displayPath(p, home)}>
              <button
                type="button"
                className="jira-setup-x"
                aria-label={`Remove ${displayPath(p, home)}`}
                disabled={busy}
                onClick={() => void write(key, paths.filter((q) => q !== p))}
              >
                ×
              </button>
            </SettingsRow>
          );
          // The defaults belong to the PATH: only its first appearance, in project-key order, draws the line.
          if (shownDefaults.has(p)) return [row];
          shownDefaults.add(p);
          const own = kept === null ? [] : repoWorktrees(p, kept);
          return [
            row,
            <RepoDefaultsRow key={`defaults\n${p}`} path={p} home={home} stored={data?.repoDefaults?.[p]} busy={busy} onSave={saveDefaults} />,
            ...(own.length === 0 ? [] : [<RepoWorktreesRow key={`trees\n${p}`} trees={own} home={home} liveKeys={liveKeys} />])
          ];
        })
      )}
      {unmapped.map((p) => (
        <SettingsRow
          key={`unmapped ${p.key}`}
          name={projectLabel(p.key, names)}
          hint={<span className="jira-setup-warn">no repository yet — {p.key} cards cannot Start until a path is mapped</span>}
        />
      ))}
      <div className="set-row jira-setup-add">
        <Select label="Jira project" value={project} options={options} disabled={projects.list === null || busy} onChange={setProject} />
        <input
          className="set-text jira-setup-add-path"
          type="text"
          aria-label="Repository path"
          placeholder="~/work/payments-api"
          value={path}
          disabled={busy}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <Chip size={28} disabled={busy || project === '' || path.trim() === ''} onClick={() => void add()}>
          Add
        </Chip>
      </div>
      {error !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">{error}</span>
        </div>
      )}
      {projects.error !== null && (
        <div className="set-row set-error-row">
          <span className="set-error">{projects.error}</span>
        </div>
      )}
      <div className="set-row">
        <span className="set-hint">a path the dashboard cannot see is refused at dispatch, not here</span>
      </div>
    </SettingsGroup>
  );
}

/** One project's stored list, or none for a hand-edited entry that is not an array — the card says less rather than throwing inside a render. */
function listOf(repos: JiraStatusPayload['repos'], key: string): string[] {
  const list: unknown = repos[key];
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

function projectLabel(key: string, names: Map<string, string>): string {
  const name = names.get(key);
  return name === undefined ? key : `${key} · ${name}`;
}

/** The sentence a refused defaults write carries: the server's own, `HTTP <n>` dressed like the path writes' fallback, a dropped request said as such. */
function defaultsFailure(e: unknown): string {
  if (e instanceof TypeError) return 'the defaults were not saved — the server did not answer';
  const message = e instanceof Error ? e.message : String(e);
  return /^HTTP \d+$/.test(message) ? `the defaults were not saved (${message})` : message;
}

/**
 * One path's defaults line (see the group's header). The drafts are this row's state, seeded from the stored values at mount and set to what was SENT after a
 * landed save (so a trimmed ` develop ` reads `develop` again); the row is keyed on the path, so another path's row never inherits them. `Save` is off until a
 * draft differs from what is stored, trimmed, and a refused save leaves the drafts as typed.
 */
function RepoDefaultsRow({
  path,
  home,
  stored,
  busy,
  onSave
}: {
  path: string;
  home: string | null;
  stored: JiraRepoDefaults | undefined;
  busy: boolean;
  onSave: (path: string, base: string | null, namePattern: string | null) => Promise<boolean>;
}) {
  const mounted = useMountedRef();
  const listId = useId();
  const shown = displayPath(path, home);
  const [base, setBase] = useState(stored?.base ?? '');
  const [pattern, setPattern] = useState(stored?.namePattern ?? '');
  // The refs are read ONCE per mount of this row (deps: the path), so a status reload — a save, a focus, the poll — never costs the host a git call.
  const refs = useFetched(() => fetchJiraRefs(path, null), [path]);
  const listed = refs.status === 'ok' && refs.value !== null && refs.value.available ? refs.value : null;
  const unavailable =
    refs.status === 'failed'
      ? `branches unavailable — ${shown}: ${refs.error instanceof Error ? refs.error.message : String(refs.error)}`
      : refs.status === 'ok' && refs.value !== null && !refs.value.available
        ? `branches unavailable — ${shown} ${refs.value.reason}`
        : null;

  const sentBase = base.trim() === '' ? null : base.trim();
  const sentPattern = pattern.trim() === '' ? null : pattern.trim();
  const changed = sentBase !== (stored?.base ?? null) || sentPattern !== (stored?.namePattern ?? null);
  const problem = sentPattern === null ? null : patternProblem(sentPattern);
  // Prefixed with the field's name, as the server's 400 is, because the base's own rule reads as nothing on its own (`is a branch name, without origin/`).
  const baseProblem = sentBase === null ? null : defaultBaseProblem(sentBase);

  async function save(): Promise<void> {
    if (!(await onSave(path, sentBase, sentPattern)) || !mounted.current) return;
    setBase(sentBase ?? '');
    setPattern(sentPattern ?? '');
  }

  return (
    <div className="set-row jira-setup-defaults">
      <input
        className="set-text jira-setup-defaults-base"
        type="text"
        aria-label={`Default base for ${shown}`}
        placeholder="e.g. develop"
        list={listed === null ? undefined : listId}
        value={base}
        disabled={busy}
        onChange={(e) => setBase(e.target.value)}
      />
      {listed !== null && (
        <datalist id={listId}>
          {listed.branches.map((b) => (
            <option key={b.name} value={b.name} />
          ))}
        </datalist>
      )}
      <input
        className="set-text jira-setup-defaults-pattern"
        type="text"
        aria-label={`Branch name pattern for ${shown}`}
        placeholder="{key}-{slug}"
        value={pattern}
        disabled={busy}
        onChange={(e) => setPattern(e.target.value)}
      />
      <Chip size={28} disabled={busy || !changed} aria-label={`Save defaults for ${shown}`} onClick={() => void save()}>
        Save
      </Chip>
      {baseProblem !== null && <span className="set-hint jira-setup-warn jira-setup-defaults-hint">base {baseProblem}</span>}
      {problem !== null && <span className="set-hint jira-setup-warn jira-setup-defaults-hint">{problem}</span>}
      {unavailable !== null && <span className="set-hint jira-setup-defaults-hint">{unavailable}</span>}
    </div>
  );
}

/** One path's open trees (see the group's header): a `worktrees` head with a count, then the modal's own rows, without the repository — the row above. */
function RepoWorktreesRow({ trees, home, liveKeys }: { trees: readonly JiraWorktree[]; home: string | null; liveKeys: readonly string[] }) {
  return (
    <div className="set-row set-row-stacked jira-setup-trees">
      <div className="jira-setup-trees-head">
        <span className="set-hint">worktrees</span>
        <Pill tone="neutral">{trees.length}</Pill>
      </div>
      <ul className="jira-wt-list">
        {trees.map((t) => (
          <WorktreeRow key={t.path} tree={t} home={home} liveKey={treeLiveKey(t, liveKeys)} showRepo={false} />
        ))}
      </ul>
    </div>
  );
}
