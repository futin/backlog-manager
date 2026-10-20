import { useState, type Dispatch, type SetStateAction } from 'react';

import { useFetched, type Fetched } from '../../hooks/useFetched';
import { branchChoiceOf, branchDraft, displayPath, draftRefusal, fetchAgeLine, fetchJiraRefs, type BranchDraft } from '../../lib/jira';
import { jiraActionParam } from '../../../../shared/types';
import type { JiraAction, JiraBranchChoice, JiraRepoDefaults, JiraRepoRefs } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';

/** What the launch sheet reads off the Branch section: the choice Start and the preview carry, and whether it may be sent yet. */
export interface BranchState {
  refs: Fetched<JiraRepoRefs>;
  /** The refs to judge the draft against: the 200's, or `null` for a failed request — which the helpers read as "unread", the unavailable form's rules. */
  known: JiraRepoRefs | null;
  /** The draft was seeded from THIS repository's settled refs: before that the section shows `loading branches…` and nothing goes out. */
  ready: boolean;
  draft: BranchDraft;
  setDraft: Dispatch<SetStateAction<BranchDraft>>;
  choice: JiraBranchChoice;
  refusal: { text: string; offerContinue: boolean } | null;
}

/**
 * The Branch section's state, held by the launch sheet (it sends the choice) and drawn by `JiraBranchSection` below.
 *
 * **When the defaults are recomputed.** On an action change, and on the first time the SELECTED repository's refs settle after it was picked — `ok` or
 * `failed`, since a failed read is the unavailable form and still has defaults (the stored base and pattern). Never otherwise: the person's edits are the
 * state from then on, and a later answer for the same repository must not overwrite what they picked.
 *
 * The seed is keyed on a VISIT, not on the repository's name: `visit` counts every change of the picked repository, and `seed.visit` is the visit whose
 * SETTLED refs fed the draft. The name would not do (Task 8 review, I1): A → B → A while B's refs are still out leaves the name where it was, so A's refs
 * landing again would not count as a change — an edit made in A would survive the round trip, and an action change inside the window (which seeds from no
 * refs and B's stored defaults) would leave B's pattern and base on A. Counting visits makes every null → loaded transition after a repo change re-seed,
 * however fast the switch, while a re-read of the SAME repository — same visit — never does. An action change while the refs are out seeds from no refs and
 * leaves `seed.visit` alone, so the refs landing still re-seed.
 *
 * The re-seed is a `setState` during render, React's own idiom for state derived from a changed input, rather than an effect: an effect would commit one frame
 * with the old draft, and the preview's `useFetched` would already have asked the server about the previous repository's branch by then.
 */
export function useBranchState(
  action: JiraAction,
  repo: string,
  key: string,
  summary: string,
  defaults: JiraRepoDefaults | undefined
): BranchState {
  const actionKey = jiraActionParam(action);
  const refs = useFetched(repo === '' ? null : () => fetchJiraRefs(repo, key), [repo, key]);
  const settled = refs.status === 'ok' || refs.status === 'failed';
  const known = refs.status === 'ok' ? refs.value : null;

  const [draft, setDraft] = useState<BranchDraft>(() => branchDraft(action, null, key, summary, defaults));
  const [visit, setVisit] = useState({ repo, n: 0 });
  if (visit.repo !== repo) setVisit({ repo, n: visit.n + 1 });
  const [seed, setSeed] = useState<{ action: string; visit: number | null }>({ action: actionKey, visit: null });
  if (seed.action !== actionKey || (settled && seed.visit !== visit.n)) {
    setDraft(branchDraft(action, known, key, summary, defaults));
    setSeed({ action: actionKey, visit: settled ? visit.n : seed.visit });
  }

  const ready = repo !== '' && settled && seed.visit === visit.n;
  return {
    refs,
    known,
    ready,
    draft,
    setDraft,
    choice: branchChoiceOf(draft, action),
    refusal: ready ? draftRefusal(draft, action, key, known) : null
  };
}

/**
 * JiraBranchSection — where the launch sheet's session will work (Jira repo/branch, spec §5.3, §5.6; DESIGN.md §8.7 Sheet for the `.sheet-*` field family
 * it sits in, §8.6 for its controls — `Segmented`, `Select`, `Switch` and `.set-text`, the 36 px family — and §8.9.5 for the sheet it is a field of).
 *
 * **Three modes, one draft.** New, Continue and No branch are a `Segmented` (three options seen at once are worth the width), and every mode keeps its own
 * fields in the draft, so flipping away and back returns what the person typed. No branch is not offered for `execute`: an execute with no worktree would
 * commit on whatever the mapped checkout holds, and the server refuses it.
 *
 * **The list is only as fresh as the last fetch, and the board never fetches** (the server writes no git), so the age of `FETCH_HEAD` is printed under the
 * modes. Refs the server could not read — or a request that failed — turn the selects into text fields under one `branches unavailable` line: the person
 * can still name a branch and a base, and `jira.mjs worktree` re-checks on the host what the board could not.
 *
 * **Refusals are said before Start.** `draftRefusal` is the same rules the server and the tool apply; its sentence is drawn here and the sheet disables Start
 * and Copy prompt on it. A New name that already exists offers `switch to Continue` on that branch, the server's own remedy, one click away.
 *
 * **Open MR when done** is `execute`'s with a branch only, off on every open (spec §5.6); with Continue it asks for the MR's target, opening on the repo's
 * default base. A skill's prompt is its template, with no commit rule for the switch to amend.
 */
export function JiraBranchSection({
  branch,
  action,
  repo,
  home
}: {
  branch: BranchState;
  action: JiraAction;
  repo: string;
  home: string | null;
}) {
  const { refs, known, ready, draft, setDraft, refusal } = branch;
  const set = (patch: Partial<BranchDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  const modes: { value: BranchDraft['mode']; label: string }[] = [
    { value: 'new', label: 'New' },
    { value: 'continue', label: 'Continue' },
    ...(action === 'execute' ? [] : [{ value: 'none' as const, label: 'No branch' }])
  ];
  const listed = known !== null && known.available ? known : null;
  const names = listed?.branches.map((b) => b.name) ?? [];
  const chosen = listed?.branches.find((b) => b.name === draft.continueBranch) ?? null;
  const unavailable =
    !ready || listed !== null
      ? null
      : refs.status === 'failed'
        ? `branches unavailable — ${displayPath(repo, home)}: ${refs.error instanceof Error ? refs.error.message : String(refs.error)}`
        : known !== null && !known.available
          ? `branches unavailable — ${displayPath(repo, home)} ${known.reason}`
          : null;

  /** A select over the listed names that can also show a value the list lacks — `''` as `choose…`, a stored base the repo no longer has by its name. */
  const withValue = (value: string, options: { value: string; label: string; group?: string }[]) =>
    options.some((o) => o.value === value) ? options : [{ value, label: value === '' ? 'choose…' : value }, ...options];

  const textField = (label: string, value: string, onChange: (v: string) => void, placeholder?: string) => (
    <input className="set-text" type="text" aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  );

  return (
    <div className="sheet-field">
      <span className="set-name">Branch</span>
      <Segmented<BranchDraft['mode']> label="Branch mode" value={draft.mode} options={modes} onChange={(mode) => set({ mode })} disabled={!ready} />

      {!ready ? (
        <div className="sheet-note">{repo === '' ? 'choose a repository first' : 'loading branches…'}</div>
      ) : unavailable !== null ? (
        <div className="sheet-blocked">{unavailable}</div>
      ) : listed !== null ? (
        <div className="sheet-note">{fetchAgeLine(listed.fetchedAt, Date.now())}</div>
      ) : null}

      {ready && draft.mode === 'continue' && (
        <div className="jira-branch-line">
          {listed !== null ? (
            <Select
              label="Branch"
              value={draft.continueBranch}
              onChange={(continueBranch) => set({ continueBranch })}
              options={withValue(draft.continueBranch, [
                ...listed.branches.filter((b) => b.ticket).map((b) => ({ value: b.name, label: b.name, group: 'this ticket' })),
                ...listed.branches.filter((b) => !b.ticket).map((b) => ({ value: b.name, label: b.name, group: 'other branches' }))
              ])}
            />
          ) : (
            textField('Branch', draft.continueBranch, (continueBranch) => set({ continueBranch }))
          )}
          {/* Where the local copy stands against origin as of the last fetch — the session starts from the local tip, so a stale one is worth a word. */}
          {chosen !== null && (chosen.sync === 'behind' || chosen.sync === 'diverged') && (
            <span className="sheet-static" title={`the local copy against origin/${chosen.name}, as of the last fetch`}>
              {chosen.sync}
            </span>
          )}
        </div>
      )}
      {/* A tree other than the mapped checkout holding the branch is not a refusal: the session enters it (spec §5.3), and the person should know where. */}
      {ready && draft.mode === 'continue' && chosen !== null && chosen.worktree !== null && listed !== null && chosen.worktree !== listed.repo && (
        <div className="sheet-note" title={chosen.worktree}>
          will work in {displayPath(chosen.worktree, home)}
        </div>
      )}

      {ready && draft.mode === 'new' && (
        <div className="sheet-row">
          <label className="sheet-field">
            <span className="set-name">Base</span>
            {listed !== null ? (
              <Select
                label="Base"
                value={draft.base}
                onChange={(base) => set({ base })}
                options={withValue(
                  draft.base,
                  names.map((n) => ({ value: n, label: n }))
                )}
              />
            ) : (
              textField('Base', draft.base, (base) => set({ base }))
            )}
          </label>
          <label className="sheet-field">
            <span className="set-name">Name</span>
            {textField('Name', draft.newBranch, (newBranch) => set({ newBranch }))}
          </label>
        </div>
      )}

      {ready && draft.mode === 'none' && <div className="sheet-note">works in the mapped checkout itself — no branch, no worktree</div>}

      {refusal !== null && (
        <div className="jira-branch-line">
          <div className="sheet-blocked">{refusal.text}</div>
          {refusal.offerContinue && (
            <Chip size={28} variant="flat" onClick={() => set({ mode: 'continue', continueBranch: draft.newBranch })}>
              switch to Continue
            </Chip>
          )}
        </div>
      )}

      {ready && action === 'execute' && draft.mode !== 'none' && (
        <div className="sheet-check">
          <Switch checked={draft.openMr} onChange={(openMr) => set({ openMr })} label="Open MR when done" />
          <span>open MR when done — push the branch and open one merge request</span>
        </div>
      )}
      {ready && action === 'execute' && draft.mode === 'continue' && draft.openMr && (
        <label className="sheet-field">
          <span className="set-name">Target</span>
          {listed !== null ? (
            <Select
              label="Target"
              value={draft.target}
              onChange={(target) => set({ target })}
              options={withValue(draft.target, [{ value: '', label: "the repository's default" }, ...names.map((n) => ({ value: n, label: n }))])}
            />
          ) : (
            textField('Target', draft.target, (target) => set({ target }), "the repository's default")
          )}
        </label>
      )}
    </div>
  );
}
