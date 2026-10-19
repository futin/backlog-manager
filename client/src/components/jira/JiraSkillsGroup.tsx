import { useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useMountedRef } from '../../hooks/useMountedRef';
import { JIRA_BUILTIN_LABELS } from '../../../../shared/types';
import type { JiraSkill } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { Pill } from '../ui/Pill';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { errorOf, postJson } from './JiraBoardSheet';

/** The five names the server substitutes into a template (spec §6.4), in the order the hint lists them. */
const PLACEHOLDERS = ['{key}', '{summary}', '{url}', '{repo}', '{description}'];

/**
 * Jira › Setup › Skills (Jira phase 5, spec §6.4; DESIGN.md §8.9.3, and §8.6 for the card language) — the named prompts a Jira card's `Run ▾` can start a
 * session with, beside the two the board always has. It is `jira.json`'s `skills` list, written by the server alone (`POST /api/jira/skills`, `/skills/delete`).
 *
 * - **Two locked rows first**, `Work it end to end` and `Open with the ticket loaded`, each reading `built-in` where a skill row carries its ×. They come
 *   from `JIRA_BUILTIN_LABELS`, the one place those two names live, so the menu, the Dispatch row's options and this card cannot disagree on a word. They
 *   have no control because there is nothing to change: a built-in is code, not a stored row.
 * - **One row per skill**: the name over its template in mono, clamped to two lines (the whole template is the title, for a long one), and a `×` that
 *   asks through `ui/Confirm` inline in its place — a skill is a name other people's `Run ▾` menus and a stored default may already point at, and the
 *   confirmation says what is lost rather than "are you sure". Only one row asks at a time.
 * - **The add row**: a name field, a template textarea and `Add`, which stays disabled until both hold something after trim. The template is sent trimmed
 *   and otherwise as typed — placeholders are the SERVER's to expand, so this card holds no second parser to drift from it.
 * - **The hint** names the five placeholders and says what the list does NOT do: a skill has to exist in the repo or the Claude install, and this list only
 *   names it. A template that points at nothing is refused by Claude when the session starts, not here — the card has no way to see a repo's skills.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skills: JiraSkill[] = data?.skills ?? [];
  const ready = name.trim() !== '' && prompt.trim() !== '';

  /** POST one write. Resolves `true` when the server stored it; the sentence for a refusal goes under the add row. */
  async function write(url: string, body: unknown, fallback: string): Promise<boolean> {
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

  return (
    <SettingsGroup title="Skills" scope="this machine · the prompts a card's Run ▾ can start a session with">
      {(['execute', 'context'] as const).map((id) => (
        <SettingsRow key={id} name={JIRA_BUILTIN_LABELS[id]}>
          <Pill>built-in</Pill>
        </SettingsRow>
      ))}
      {skills.map((skill) => (
        <SettingsRow key={skill.id} name={skill.name} hint={<span className="jira-skill-prompt" title={skill.prompt}>{skill.prompt}</span>}>
          {asking === skill.id ? (
            <Confirm
              label={`Remove ${skill.name}`}
              acceptLabel="Remove"
              dismissLabel="Keep"
              testId={`jira-skill-delete-${skill.id}`}
              onAccept={() => void remove(skill)}
              onDismiss={() => setAsking(null)}
            >
              Remove {skill.name}? A card's Run ▾ stops offering it.
            </Confirm>
          ) : (
            <button type="button" className="jira-setup-x" aria-label={`Remove ${skill.name}`} disabled={busy} onClick={() => setAsking(skill.id)}>
              ×
            </button>
          )}
        </SettingsRow>
      ))}
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
          {' · '}a skill has to exist in the repo or the Claude install; this list only names it
        </span>
      </div>
    </SettingsGroup>
  );
}
