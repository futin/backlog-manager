import { useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useMountedRef } from '../../hooks/useMountedRef';
import { displayPath, unmappedProjects } from '../../lib/jira';
import type { JiraStatusPayload } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Select } from '../ui/Select';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { errorOf, postJson, type JiraProjectList } from './JiraBoardSheet';

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
        paths.map((p, i) => (
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
        ))
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
