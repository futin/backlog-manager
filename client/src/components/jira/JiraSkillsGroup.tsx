import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useMountedRef } from '../../hooks/useMountedRef';
import { useSettings } from '../../hooks/useSettings';
import { jiraSettingOf, resolveJiraAction, skillCommand } from '../../lib/jira';
import { JIRA_BUILTIN_LABELS } from '../../../../shared/types';
import type { JiraSkill } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { GlyphTile } from '../ui/GlyphTile';
import type { GlyphName } from '../ui/Glyphs';
import { SettingsGroup } from '../ui/SettingsRow';
import { errorOf, postJson } from '../../lib/http';

/**
 * The six names the server substitutes into a template (spec §6.4, and §5.4 for the last three, which carry the branch choice made on Run), in the order the
 * hint lists them. The ticket's text is not one: a skill reads it.
 */
const PLACEHOLDERS = ['{key}', '{url}', '{repo}', '{branch}', '{base}', '{worktree}'];

/** The two built-ins, as the Run menu words them (`JiraRunMenu`'s `builtIns`): label, sub-line, glyph. */
const BUILT_INS: { id: 'execute' | 'context'; label: string; sub: string; glyph: GlyphName }[] = [
  { id: 'execute', label: JIRA_BUILTIN_LABELS.execute, sub: 'Work the ticket end to end', glyph: 'play' },
  { id: 'context', label: JIRA_BUILTIN_LABELS.context, sub: 'Open with the ticket loaded', glyph: 'document' }
];

/**
 * Jira › Setup › Skills (Jira phase 5, spec §6.4; DESIGN.md §8.9.3, and §8.6 for the card language) — the named prompts a Jira card's `Run ▾` can start a
 * session with, beside the two the board always has. It is `jira.json`'s `skills` list, written by the server alone (`POST /api/jira/skills`, `/skills/delete`).
 *
 * - **The Run menu's rows** (restyle spec §4.4): a `GlyphTile` (play and document for the two built-ins, sparkle for a skill), the label over a command
 *   sub-line, and on the right `default` on the row `resolveJiraAction(settings.jiraDefaultAction, skills)` names, `Make default` on every other. Under
 *   `Built in` come `Work it end to end` and `Open with the ticket loaded` — from `JIRA_BUILTIN_LABELS`, the one place those names live, so the menu, the
 *   Dispatch row's options and this card cannot disagree on a word; then `Skills on this machine · N` (no head at zero), the same grouping the menu draws.
 *   `Make default` writes `jiraDefaultAction` — the per-BROWSER Local setting Settings › Local shows as `Jira default action` — through `useSettings`; this
 *   card's server scope does not change that, and the stored `jira.json` is never touched by it.
 * - **A skill's row** keeps its `×`, which asks through `ui/Confirm` inline in its place — a skill is a name other people's `Run ▾` menus and a stored default
 *   may already point at, and the confirmation says what is lost rather than "are you sure". Only one row asks at a time. The sub-line is the template's
 *   first word when it is a slash command (`skillCommand`, as the menu draws it); the whole template is the row's title, for a long one.
 * - **The add row**: a name field, a template textarea and `Add`, which stays disabled until both hold something after trim. The template is sent trimmed
 *   and otherwise as typed — placeholders are the SERVER's to expand, so this card holds no second parser to drift from it.
 * - **The hint** names the six placeholders and says what the list does NOT do: a skill has to exist in the repo or the Claude install, and this list only
 *   names it. A second line says what the last three are: `{branch}` and `{base}` are the choice made on Run, `{worktree}` is the path the board EXPECTS the
 *   tree at — the one `jira.mjs worktree` prints, once the tree exists, is the one that counts. A template that points at nothing is refused by Claude when the
 *   session starts, not here — the card has no way to see a repo's skills.
 *
 * **Every landed write reloads `GET /api/jira`** and the card draws only what that says is stored, never its own optimistic copy, the rule
 * `JiraReposGroup` follows. A refusal (400 with the field's sentence, 404 for a skill another tab removed, 409 for a `jira.json` that cannot be read) is
 * shown under the add row in the server's words and changes nothing locally: the typed name and template stay in their fields, and a refused `×` removes
 * no row. A landed write reloads even if this page has gone (`reload` is the shell's, which outlives it), for the reason `JiraBoardSheet`'s save does.
 */
export function JiraSkillsGroup() {
  const { data, reload } = useJiraContext();
  const mounted = useMountedRef();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  // The GUARD is a ref and `busy` is the RENDERING, the split `useAction` makes (bug-19): `setBusy(true)` does not change what `busy` holds in this render's
  // closure, so a second click dispatched before React re-renders reads `false` and would POST again — and each POST mints its own `s_` id, so the result is
  // two identical skills. One guard serves Add and `×` alike, as one `busy` does.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skills: JiraSkill[] = data?.skills ?? [];
  const { settings, update } = useSettings();
  const preferred = jiraSettingOf(resolveJiraAction(settings.jiraDefaultAction, skills));
  const ready = name.trim() !== '' && prompt.trim() !== '';

  /** POST one write. Resolves `true` when the server stored it; the sentence for a refusal goes under the add row. */
  async function write(url: string, body: unknown, fallback: string): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const answer = await postJson(url, body);
      if (answer.ok) reload();
      if (!mounted.current) return answer.ok;
      if (!answer.ok) setError(errorOf(answer.body, `${fallback} (HTTP ${answer.status})`));
      return answer.ok;
    } catch {
      if (mounted.current) setError(`${fallback} — the server did not answer`);
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function add(): Promise<void> {
    if (!ready) return;
    if ((await write('/api/jira/skills', { name: name.trim(), prompt: prompt.trim() }, 'the skill was not saved')) && mounted.current) {
      setName('');
      setPrompt('');
    }
  }

  async function remove(skill: JiraSkill): Promise<void> {
    setAsking(null);
    await write('/api/jira/skills/delete', { id: skill.id }, 'the skill was not removed');
  }

  /** One row in the Run menu's shape. `setting` is the string `jiraDefaultAction` stores for it: a built-in's id or the skill's own. */
  function row(id: string, label: string, sub: string, glyph: GlyphName, setting: string, title?: string, trailing?: ReactNode) {
    const isDefault = setting === preferred;
    return (
      <div key={id} className="set-row jira-setup-skill" title={title}>
        <GlyphTile glyph={glyph} tone={isDefault ? 'green' : 'neutral'} />
        <span className="jira-run-text">
          <span className="jira-run-label">{label}</span>
          {sub !== '' && <span className="jira-run-sub">{sub}</span>}
        </span>
        {isDefault ? (
          <span className="jira-setup-default">default</span>
        ) : (
          <Chip variant="flat" size={28} aria-label={`Make ${label} the default action`} onClick={() => update({ jiraDefaultAction: setting })}>
            Make default
          </Chip>
        )}
        {trailing}
      </div>
    );
  }

  return (
    <SettingsGroup title="Skills" scope="this machine · the prompts a card's Run menu can start a session with">
      <div className="jira-run-head">Built in</div>
      {BUILT_INS.map((r) => row(r.id, r.label, r.sub, r.glyph, r.id))}
      {skills.length > 0 && <div className="jira-run-head">Skills on this machine · {skills.length}</div>}
      {skills.map((skill) =>
        row(
          skill.id,
          skill.name,
          skillCommand(skill.prompt) ?? '',
          'sparkle',
          skill.id,
          skill.prompt,
          asking === skill.id ? (
            <Confirm
              label={`Remove ${skill.name}`}
              acceptLabel="Remove"
              dismissLabel="Keep"
              testId={`jira-skill-delete-${skill.id}`}
              onAccept={() => void remove(skill)}
              onDismiss={() => setAsking(null)}
            >
              Remove {skill.name}? A card's Run menu stops offering it.
            </Confirm>
          ) : (
            <button type="button" className="jira-setup-x" aria-label={`Remove ${skill.name}`} disabled={busy} onClick={() => setAsking(skill.id)}>
              ×
            </button>
          )
        )
      )}
      <div className="set-row set-row-stacked jira-skill-add">
        <input
          className="set-text jira-skill-add-name"
          type="text"
          aria-label="Skill name"
          placeholder="Groom ticket"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          className="sheet-prompt jira-skill-add-prompt"
          aria-label="Skill prompt template"
          placeholder="/jira-groom {key}"
          rows={3}
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <Chip size={28} disabled={busy || !ready} onClick={() => void add()}>
          Add
        </Chip>
      </div>
      {error !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">{error}</span>
        </div>
      )}
      <div className="set-row">
        <span className="set-hint">
          placeholders:{' '}
          {PLACEHOLDERS.map((p, i) => (
            <span key={p}>
              {i > 0 && ', '}
              <code>{p}</code>
            </span>
          ))}
          {' · '}a template without <code>{'{key}'}</code> gets the ticket key on a line after it · a skill has to exist in the repo or the Claude install;
          this list only names it
        </span>
      </div>
      <div className="set-row">
        <span className="set-hint">
          <code>{'{branch}'}</code>, <code>{'{base}'}</code>, <code>{'{worktree}'}</code> — the branch and base chosen on Run;{' '}
          <code>{'{worktree}'}</code> is the expected path; the one <code>jira.mjs worktree</code> prints wins
        </span>
      </div>
    </SettingsGroup>
  );
}
