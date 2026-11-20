import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useDialogEscape } from '../../hooks/useDialogEscape';
import { useMountedRef } from '../../hooks/useMountedRef';
import { useSettings } from '../../hooks/useSettings';
import { jiraSettingOf, resolveJiraAction, skillCommand } from '../../lib/jira';
import { JIRA_BUILTIN_LABELS } from '../../../../shared/types';
import type { JiraSkill, JiraSkillGroup, JiraStatusPayload } from '../../../../shared/types';
import { Chevron } from '../ui/Chevron';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { GlyphTile } from '../ui/GlyphTile';
import type { GlyphName } from '../ui/Glyphs';
import { Segmented } from '../ui/Segmented';
import { SettingsGroup } from '../ui/SettingsRow';
import { errorOf, postJson } from '../../lib/http';

/**
 * The six names the server substitutes into a template (spec §6.4, and §5.4 for the last three, which carry the branch choice made on Run), in the order the
 * hint lists them. The ticket's text is not one: a skill reads it.
 */
const PLACEHOLDERS = ['{key}', '{url}', '{repo}', '{branch}', '{base}', '{worktree}'];

/**
 * What a review skill's template is told it can name (spec §3) — the mock's six, in its order. The run placeholders still fill in a review skill (one widened
 * regex on the server, not a second set), but the hint names only what is new to the group, as `Review-Skills.dc.html`'s `Fills in:` line does.
 */
const REVIEW_PLACEHOLDERS = ['{key}', '{mr.url}', '{mr.iid}', '{mr.source}', '{mr.target}', '{mr.project}'];

/** Per group, everything the card words differently (spec §Copy): the explainer under the switch (its `▾` is the menu's own `Chevron`, the one disclosure
 *  mark — `test/guards/chevrons.test.ts` bans the text triangle), the head, the add row's placeholders and the remove confirm's
 *  consequence — kept in one table so the two segments cannot drift into different shapes. */
const GROUP_COPY: Record<JiraSkillGroup, { explainer: ReactNode; head: string; name: string; prompt: string; stops: string }> = {
  run: {
    explainer: (
      <>
        Run skills show in a ticket's{' '}
        <b>
          Run <Chevron />
        </b>
        .
      </>
    ),
    head: 'Your run skills',
    name: 'Groom ticket',
    prompt: '/jira-groom {key}',
    stops: "A card's Run menu stops offering it."
  },
  review: {
    explainer: (
      <>
        Review skills show in an MR's{' '}
        <b>
          Review <Chevron />
        </b>{' '}
        and start on that MR's source branch, never a new one.
      </>
    ),
    head: 'Your review skills',
    name: 'Claude code review',
    prompt: '/code-review high {mr.url}',
    stops: "An MR's Review menu stops offering it."
  }
};

const GROUP_OPTIONS: { value: JiraSkillGroup; label: string }[] = [
  { value: 'run', label: 'Run' },
  { value: 'review', label: 'Review' }
];

const ORDER_HINT = '↑↓ to reorder · order = menu order';

/** The two built-ins, as the Run menu words them (`JiraRunMenu`'s `builtIns`): label, sub-line, glyph. */
const BUILT_INS: { id: 'execute' | 'context'; label: string; sub: string; glyph: GlyphName }[] = [
  { id: 'execute', label: JIRA_BUILTIN_LABELS.execute, sub: 'Work the ticket end to end', glyph: 'play' },
  { id: 'context', label: JIRA_BUILTIN_LABELS.context, sub: 'A session, you drive', glyph: 'document' }
];

/**
 * Jira › Setup › Skills (Jira phase 5, spec §6.4; DESIGN.md §8.9.3, and §8.6 for the card language) — the named prompts a Jira card's `Run ▾` or an MR's
 * `Review ▾` can start a session with, beside the built-ins the board always has. It is `jira.json`'s `skills` list, written by the server alone
 * (`POST /api/jira/skills`, `/skills/delete`, `/skills/order`).
 *
 * - **Run | Review** (2026-11-20 review-skills spec §2, mock `Review-Skills.dc.html`): a `Segmented` switch counts each group and shows ONE — Run on every
 *   mount, never persisted. Everything below it is that group's: an explainer, `Built in`, `Your run skills · N` / `Your review skills · N` (no head at
 *   zero; an empty Review says `No review skills yet.`), the order hint while the group has two or more, the rows, the add row, and the placeholder hint.
 *   One list holds both groups on the server; the card only filters it, so a run skill and a review skill can sit interleaved in the stored order.
 * - **The Run menu's rows** (restyle spec §4.4): a `GlyphTile` (play and document for the two built-ins, sparkle for a skill), the label over a command
 *   sub-line, and on the right `default` on the row `resolveJiraAction(settings.jiraDefaultAction, skills)` names, `Make default` on every other. Under
 *   `Built in` come `Work it end to end` and `Open with the ticket loaded` — from `JIRA_BUILTIN_LABELS`, the one place those names live, so the menu, the
 *   Dispatch row's options and this card cannot disagree on a word; then `Your run skills · N`, the same grouping the menu draws. Review's one
 *   built-in is `Review bot`, the split's left half on an MR, with no default slot — the bot is always that half; no review skill draws one either, because
 *   the default is what a card's split `Run` starts and a review needs an MR.
 *   `Make default` writes `jiraDefaultAction` — the per-BROWSER Local setting Settings › Local shows as `Jira default action` — through `useSettings`; this
 *   card's server scope does not change that, and the stored `jira.json` is never touched by it.
 * - **A skill's row** keeps its `×`, which asks through `ui/Confirm` inline in its place — a skill is a name other people's `Run ▾` menus and a stored default
 *   may already point at, and the confirmation says what is lost — which menu stops offering it, per group — rather than "are you sure". Only one row
 *   asks at a time, and asking closes an open editor. The sub-line is the template's
 *   first word when it is a slash command (`skillCommand`, as the menu draws it); the whole template is the row's title, for a long one.
 * - **↑ and ↓** (2026-11-17 skill-order spec) sit on every skill row before the default slot, never on a built-in — those stay pinned above. A click
 *   swaps the skill with its neighbour and POSTs the WHOLE order to `/api/jira/skills/order`; the server refuses (409) a set that is not exactly what it stores,
 *   so a stale tab cannot drop or invent a skill. The order is built from the DISTINCT ids, first occurrence winning, so a hand-duplicated id is sent once
 *   and its repeated row draws the same arrows as its first. The arrows move a skill WITHIN its group: the group's slice is permuted and written back
 *   into the slots that group holds, every other id keeping its own, so the route still gets the whole list. `↑` is disabled on the group's first skill, `↓`
 *   on its last, both while a write is in flight, while
 *   that row's remove `Confirm` is open, and after a landed move until `GET /api/jira` answers anew: `reload()` is not awaited and `busy` clears first, so
 *   without that wait a second click would act on the list drawn BEFORE the move — posting the stored order again or undoing it. The wait is on the `data`
 *   object the move was made against; a new object ends it, and so does `error`, so a failed reload cannot lock the arrows for good.
 * - **The add row**: a name field, a template textarea and `Add`, which stays disabled until both hold something after trim. The template is sent trimmed
 *   and otherwise as typed — placeholders are the SERVER's to expand, so this card holds no second parser to drift from it. It adds to the segment
 *   on screen (`group` in the body), and its placeholders are that group's example.
 * - **`Edit`** opens `SkillEditor` in the row's place — inline, not the mock's sheet: name, template, a `Group` toggle, `Save` / `Cancel`. Save is an
 *   update (the id keeps the skill's place); a group change moves it to the other segment, which the card does not follow. A refusal shows in the alert row
 *   and the editor stays. One editor at a time, and Escape cancels it through `useDialogEscape` (see `SkillEditor`).
 * - **Run's hint** names the six placeholders and says what the list does NOT do: a skill has to exist in the repo or the Claude install, and this list only
 *   names it. A second line says what the last three are: `{branch}` and `{base}` are the choice made on Run, `{worktree}` is the path the board EXPECTS the
 *   tree at — the one `jira.mjs worktree` prints, once the tree exists, is the one that counts. A template that points at nothing is refused by Claude when the
 *   session starts, not here — the card has no way to see a repo's skills. Review's one line is `Fills in:` with the mock's six — `{key}` and the
 *   five `{mr.*}` names.
 *
 * **Every landed write reloads `GET /api/jira`** and the card draws only what that says is stored, never its own optimistic copy, the rule
 * `JiraReposGroup` follows. A refusal (400 with the field's sentence, 404 for a skill another tab removed, 409 for a `jira.json` that cannot be read) is
 * shown under the add row in the server's words and changes nothing locally: the typed name and template stay in their fields, and a refused `×` removes
 * no row. A landed write reloads even if this page has gone (`reload` is the shell's, which outlives it), for the reason `JiraBoardSheet`'s save does.
 */
export function JiraSkillsGroup() {
  const { data, error: unreadable, reload } = useJiraContext();
  const mounted = useMountedRef();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  // The segment on screen. Local and per-render, never persisted — like the Delivery tab's fold (spec §2): the card opens on Run every time.
  const [shown, setShown] = useState<JiraSkillGroup>('run');
  // The ROW KEY whose editor is open, not the skill id: a hand-duplicated id draws two rows, and keying on the id would open an editor in both.
  const [editing, setEditing] = useState<string | null>(null);
  // The GUARD is a ref and `busy` is the RENDERING, the split `useAction` makes (bug-19): `setBusy(true)` does not change what `busy` holds in this render's
  // closure, so a second click dispatched before React re-renders reads `false` and would POST again — and each POST mints its own `s_` id, so the result is
  // two identical skills. One guard serves Add, Save and `×` alike, as one `busy` does.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The `data` object the last LANDED move was made against. While the context still holds that very object the reload has not answered, and the list
  // drawn is the pre-move one — see the header's ↑/↓ bullet.
  const [movedAgainst, setMovedAgainst] = useState<JiraStatusPayload | null>(null);

  const skills: JiraSkill[] = data?.skills ?? [];
  const { settings, update } = useSettings();
  const preferred = jiraSettingOf(resolveJiraAction(settings.jiraDefaultAction, skills));
  const ready = name.trim() !== '' && prompt.trim() !== '';
  const order = [...new Set(skills.map((k) => k.id))];
  // Each distinct id's group, its FIRST row's — the same first-occurrence rule `order` follows, so a hand-duplicated id is one slot in one group.
  const groupOf = new Map<string, JiraSkillGroup>();
  for (const k of skills) if (!groupOf.has(k.id)) groupOf.set(k.id, k.group === 'review' ? 'review' : 'run');
  const slice = order.filter((id) => groupOf.get(id) === shown);
  const counts = { run: skills.filter((k) => k.group !== 'review').length, review: skills.filter((k) => k.group === 'review').length };
  const copy = GROUP_COPY[shown];
  const stale = movedAgainst !== null && data === movedAgainst && !unreadable;

  /** POST one write. Resolves `true` when the server stored it; the sentence for a refusal goes in the card's alert row. */
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
    // `group` is the segment on screen: the add row sits under one group and adds to it (spec §2).
    if ((await write('/api/jira/skills', { name: name.trim(), prompt: prompt.trim(), group: shown }, 'the skill was not saved')) && mounted.current) {
      setName('');
      setPrompt('');
    }
  }

  /** An update: the id makes the server keep the skill's place in the list, and a changed `group` moves it to the other segment — which this card does not
   *  follow (spec §2), so the editor closes on a segment that no longer draws the row. A refusal leaves the editor open with what was typed. */
  async function save(skill: JiraSkill, draft: { name: string; prompt: string; group: JiraSkillGroup }): Promise<void> {
    const body = { id: skill.id, name: draft.name.trim(), prompt: draft.prompt.trim(), group: draft.group };
    if ((await write('/api/jira/skills', body, 'the skill was not saved')) && mounted.current) setEditing(null);
  }

  async function remove(skill: JiraSkill): Promise<void> {
    setAsking(null);
    await write('/api/jira/skills/delete', { id: skill.id }, 'the skill was not removed');
  }

  /**
   * Swap skill `id` with its neighbour `by` places away WITHIN the shown group and store the whole order. The route takes every id the server stores, so the
   * group's permuted slice is written back into the slots the group already holds and every other group's id keeps its slot — run A, review R1, run B,
   * review R2 with ↓ on R1 posts A, R2, B, R1.
   */
  async function move(id: string, by: -1 | 1): Promise<void> {
    const at = slice.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= slice.length) return;
    const permuted = [...slice];
    [permuted[at], permuted[to]] = [permuted[to], permuted[at]];
    let next = 0;
    const ids = order.map((x) => (groupOf.get(x) === shown ? permuted[next++] : x));
    const against = data;
    if ((await write('/api/jira/skills/order', { ids }, 'the order was not saved')) && mounted.current) setMovedAgainst(against);
  }

  /** The ↑/↓ pair for one skill row; a repeated id gets its first row's pair, since both act on the same place in the group's slice. */
  function arrows(skill: JiraSkill): ReactNode {
    const at = slice.indexOf(skill.id);
    const locked = busy || stale || asking === skill.id;
    return (
      <span className="jira-setup-move">
        <Chip variant="flat" size={28} aria-label={`Move ${skill.name} up`} disabled={locked || at <= 0} onClick={() => void move(skill.id, -1)}>
          ↑
        </Chip>
        <Chip
          variant="flat"
          size={28}
          aria-label={`Move ${skill.name} down`}
          disabled={locked || at >= slice.length - 1}
          onClick={() => void move(skill.id, 1)}
        >
          ↓
        </Chip>
      </span>
    );
  }

  /** Switch segment. An open editor or remove question belongs to a row the other segment does not draw, so both close rather than wait off screen. */
  function show(group: JiraSkillGroup): void {
    setShown(group);
    setEditing(null);
    setAsking(null);
  }

  /**
   * One row in the Run menu's shape. `setting` is the string `jiraDefaultAction` stores for it: a built-in's id or the skill's own — or `null` for a row that
   * can never be the default (the review bot and every review skill: the default is what a card's split `Run` starts, and a review needs an MR), which then
   * draws neither `default` nor `Make default`.
   */
  function row(
    key: string,
    label: string,
    sub: string,
    glyph: GlyphName,
    setting: string | null,
    { title, leading, trailing, code = false }: { title?: string; leading?: ReactNode; trailing?: ReactNode; code?: boolean } = {}
  ) {
    const isDefault = setting !== null && setting === preferred;
    return (
      <div key={key} className="set-row jira-setup-skill" title={title}>
        <GlyphTile glyph={glyph} tone={isDefault ? 'green' : 'neutral'} />
        <span className="jira-run-text">
          <span className="jira-run-label">{label}</span>
          {sub !== '' && <span className={code ? 'jira-run-sub jira-setup-code' : 'jira-run-sub'}>{sub}</span>}
        </span>
        {leading}
        {setting === null ? null : isDefault ? (
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

  const shownRows = skills.flatMap((skill, i) => {
    if ((skill.group === 'review' ? 'review' : 'run') !== shown) return [];
    // A hand-duplicated id would give two rows one key; the repeat is keyed by its index, the first keeps the id.
    const key = skills.findIndex((k) => k.id === skill.id) === i ? skill.id : `${skill.id}#${i}`;
    if (editing === key) {
      return [
        <SkillEditor
          key={key}
          skill={skill}
          busy={busy}
          onSave={(draft) => void save(skill, draft)}
          onCancel={() => {
            // The alert row may hold this editor's refusal; with the editor gone it would speak about nothing on screen.
            setEditing(null);
            setError(null);
          }}
        />
      ];
    }
    const trailing =
      asking === skill.id ? (
        <Confirm
          label={`Remove ${skill.name}`}
          acceptLabel="Remove"
          dismissLabel="Keep"
          testId={`jira-skill-delete-${skill.id}`}
          onAccept={() => void remove(skill)}
          onDismiss={() => setAsking(null)}
        >
          Remove {skill.name}? {copy.stops}
        </Confirm>
      ) : (
        <button
          type="button"
          className="jira-setup-x"
          aria-label={`Remove ${skill.name}`}
          disabled={busy}
          onClick={() => {
            // One open thing per card: the question replaces any editor, as opening an editor replaces the question.
            setEditing(null);
            setAsking(skill.id);
          }}
        >
          ×
        </button>
      );
    const leading = (
      <>
        {arrows(skill)}
        <Chip
          variant="flat"
          size={28}
          aria-label={`Edit ${skill.name}`}
          disabled={busy}
          onClick={() => {
            // A refusal left by the previous editor would otherwise read as this one's.
            setAsking(null);
            setEditing(key);
            setError(null);
          }}
        >
          Edit
        </Chip>
      </>
    );
    return [
      row(key, skill.name, skillCommand(skill.prompt) ?? '', 'sparkle', shown === 'run' ? skill.id : null, {
        title: skill.prompt,
        leading,
        trailing,
        code: true
      })
    ];
  });

  return (
    <SettingsGroup title="Skills" scope="this machine · the prompts a card's Run menu and an MR's Review menu can start a session with">
      <div className="set-row">
        <Segmented
          pill
          label="Skill group"
          value={shown}
          options={GROUP_OPTIONS.map((o) => ({ value: o.value, label: o.label, count: counts[o.value] }))}
          onChange={show}
        />
      </div>
      <div className="set-row">
        <span className="set-hint">{copy.explainer}</span>
      </div>
      <div className="jira-run-head">Built in</div>
      {shown === 'run'
        ? BUILT_INS.map((r) => row(r.id, r.label, r.sub, r.glyph, r.id))
        : row('review-bot', 'Review bot', 'request a review, or fix what it found', 'robot', null)}
      {shownRows.length > 0 ? (
        <div className="jira-run-head jira-skill-head">
          <span>
            {copy.head} · {shownRows.length}
          </span>
          {slice.length >= 2 && <span className="jira-skill-order-hint">{ORDER_HINT}</span>}
        </div>
      ) : (
        shown === 'review' && (
          <div className="set-row">
            <span className="set-hint">No review skills yet.</span>
          </div>
        )
      )}
      {shownRows}
      <div className="set-row set-row-stacked jira-skill-add">
        <input
          className="set-text jira-skill-add-name"
          type="text"
          aria-label="Skill name"
          placeholder={copy.name}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          className="sheet-prompt jira-skill-add-prompt"
          aria-label="Skill prompt template"
          placeholder={copy.prompt}
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
      {shown === 'run' ? (
        <>
          <div className="set-row">
            <span className="set-hint">
              placeholders:{' '}
              {PLACEHOLDERS.map((p, i) => (
                <span key={p}>
                  {i > 0 && ', '}
                  <code>{p}</code>
                </span>
              ))}
              {' · '}a template without <code>{'{key}'}</code> gets the ticket key on a line after it · a skill has to exist in the repo or the Claude
              install; this list only names it
            </span>
          </div>
          <div className="set-row">
            <span className="set-hint">
              <code>{'{branch}'}</code>, <code>{'{base}'}</code>, <code>{'{worktree}'}</code> — the branch and base chosen on Run;{' '}
              <code>{'{worktree}'}</code> is the expected path; the one <code>jira.mjs worktree</code> prints wins
            </span>
          </div>
        </>
      ) : (
        <div className="set-row">
          <span className="set-hint">
            Fills in:{' '}
            {REVIEW_PLACEHOLDERS.map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <code>{p}</code>
              </span>
            ))}
            {' · '}a template without <code>{'{key}'}</code> gets the ticket key on a line after it
          </span>
        </div>
      )}
    </SettingsGroup>
  );
}

/**
 * The inline editor (spec §2 — inline, not the mock's sheet): drawn in place of the row it edits, the add row's two fields pre-filled, a `Group` toggle with
 * Review's sub-line while Review is pressed, then `Save` / `Cancel`. Its own component so its draft lives and dies with it — a cancelled edit leaves nothing
 * behind for the next one — and so `useDialogEscape` is called exactly while it is open: Escape has one owner (bug-23), and this editor joins the stack as
 * `ui/Confirm` does, a non-dialog entry with no listener of its own, cancelling itself and nothing under it.
 */
function SkillEditor({
  skill,
  busy,
  onSave,
  onCancel
}: {
  skill: JiraSkill;
  busy: boolean;
  onSave: (draft: { name: string; prompt: string; group: JiraSkillGroup }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(skill.name);
  const [prompt, setPrompt] = useState(skill.prompt);
  const [group, setGroup] = useState<JiraSkillGroup>(skill.group === 'review' ? 'review' : 'run');
  useDialogEscape(onCancel);
  const ready = name.trim() !== '' && prompt.trim() !== '';
  return (
    <div className="set-row set-row-stacked jira-skill-add jira-skill-edit">
      <input
        className="set-text jira-skill-add-name"
        type="text"
        aria-label="Edited skill name"
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        className="sheet-prompt jira-skill-add-prompt"
        aria-label="Edited skill prompt template"
        rows={3}
        value={prompt}
        disabled={busy}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="jira-skill-edit-group">
        <span className="jira-setup-field-name">Group</span>
        <Segmented pill label="Group" value={group} options={GROUP_OPTIONS} disabled={busy} onChange={setGroup} />
        {group === 'review' && <span className="set-hint">Review: shows on an open MR, works on its source branch</span>}
      </div>
      <div className="jira-skill-edit-actions">
        <Chip size={28} disabled={busy || !ready} onClick={() => onSave({ name, prompt, group })}>
          Save
        </Chip>
        <Chip variant="flat" size={28} disabled={busy} onClick={onCancel}>
          Cancel
        </Chip>
      </div>
    </div>
  );
}
