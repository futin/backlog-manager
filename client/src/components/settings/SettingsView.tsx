import { useState } from 'react';

import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Band } from '../ui/Band';
import { GlyphTile } from '../ui/GlyphTile';
import { Glyph, type GlyphName } from '../ui/Glyphs';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';
import { DashboardsPage } from './DashboardsPage';
import { TickGroup } from './TickGroup';
import { TimeZoneGroup } from './TimeZoneGroup';
import { SourcesGroup } from './SourcesGroup';
import { WatchdogGroup } from './WatchdogGroup';
import { useJiraContext } from '../../hooks/JiraContext';
import { useProjectsContext } from '../../hooks/ProjectsContext';
import type { DrawnSources } from '../../lib/sources';
import type { GithubPage } from '../../lib/source-page';
import type { JiraPage } from '../../lib/jira-page';
import { useSettings } from '../../hooks/useSettings';
import { EXECUTE_FINISH_OPTIONS } from '../../lib/agents';
import { jiraSettingOf, resolveJiraAction } from '../../lib/jira';
import { mergeModeOptionLabels } from '../../lib/merge-mode';
import { FONT_SCALES, JIRA_DEFAULT_PERMISSIONS, STALE_WINDOWS, THEMES, stopsWith, type ContentWidth, type JiraDefaultPermission, type Landing, type SettingsScope } from '../../lib/settings';
import { EFFORTS, MODELS } from '../../../../shared/agent';
import { JIRA_BUILTIN_LABELS, MERGE_MODES } from '../../../../shared/types';
import type { MergeMode, QuestionMode } from '../../../../shared/types';

const DENSITIES = [
  { value: 'comfortable' as const, label: 'Comfortable' },
  { value: 'compact' as const, label: 'Compact' }
];

/**
 * The two measures, labelled for what they do rather than for the numbers
 * behind them: `Fixed` is the measure this board was drawn at and `Full` is
 * the window. Written out rather than mapped over `CONTENT_WIDTHS` for the
 * same reason `LANDINGS` below is — these are a settings row's copy, not the
 * union's members — and `clampSettings` is what keeps the values in step.
 */
const CONTENT_WIDTH_OPTIONS = [
  { value: 'fixed' as ContentWidth, label: 'Fixed' },
  { value: 'full' as ContentWidth, label: 'Full' }
];

/**
 * The landing choices, with copy rather than section ids. "Last used" is
 * first because it is the default and reads as the absence of a choice; the
 * named sections below it are the override, in rail order so the list reads as
 * the rail does.
 *
 * Still written out rather than mapped over `SECTIONS`: these are labels for a
 * settings row, not the rail's own labels, and the day one of them needs to
 * read differently here ("Board (all projects)") a derived list would have to
 * be unpicked. `clampSettings` is what guarantees the *values* stay in step —
 * its `LANDINGS` is the derived one.
 */
const LANDINGS: { value: Landing; label: string }[] = [
  { value: 'last', label: 'Last used' },
  { value: 'files', label: 'Files' },
  { value: 'github', label: 'GitHub' },
  { value: 'jira', label: 'Jira' },
  { value: 'runs', label: 'Runs' },
  { value: 'settings', label: 'Settings' }
];

/**
 * The `Opens on` list this machine can honour (Jira phase 2, spec §6.1): `Jira` only while `GET /api/jira` says `configured: true`, because the rail draws no
 * Jira row otherwise and a pin to it would open elsewhere anyway — `App` falls a `jira` section to the first drawn source row (Runs when there is none) on that
 * same answer. Before the status has answered the option is withheld too: offering it on a guess would let a reader pin a section this machine may not have.
 *
 * One exception, and it is not an offer: a STORED `jira` landing keeps its option on an unconfigured machine. A native select whose value matches no option
 * renders blank (the reason `lib/settings.ts` clamps the dispatch defaults rather than keeping an unknown name), so the row would hide the very preference
 * that is in force; drawn, it says what is stored and can be changed. Nothing is rewritten — the machine may get its credentials back, and the pin with them.
 *
 * `Files` and `GitHub` (source-sections spec) take the same rule over the shell's projects answer: offered while a registered project has that source, the
 * rows the rail draws, withheld while the answer is unknown (`drawn` null), and a stored pin keeps its option for the same blank-select reason. A legacy
 * `board`/`archive` pin reaches here already clamped to `github`, so it shows as `GitHub` — the section it settles on when this machine has one.
 */
function landingOptions(jiraConfigured: boolean, drawn: DrawnSources | null, current: Landing): { value: Landing; label: string }[] {
  return LANDINGS.filter((o) => {
    if (o.value === 'jira') return jiraConfigured || current === 'jira';
    if (o.value === 'files' || o.value === 'github') return drawn?.[o.value] === true || current === o.value;
    return true;
  });
}

/**
 * The Settings section (`.claude/DESIGN.md` §8.6): three pages, and the page is the scope. Local is this device only (localStorage); Shared is what the API
 * reads off the host (the sources this machine has connected, the watchdog file, the tick breaker, the time zone); Dashboards is the machines a launch can
 * run on, also the host's.
 *
 * `onOpenWatchdog` is the rail's own navigation, threaded down for the watchdog
 * group's `Live view` link (DESIGN.md §8.6), exactly as `BoardView` takes
 * `onOpenRuns` for its run chip and for the same reason: the link and the
 * rail's Watchdog sub-nav entry have to mean the same thing by construction,
 * and the section lives in `App`'s shell. Optional, because every suite that
 * renders this view bare predates the link and none of them needs a
 * destination for it.
 *
 * `onOpenFilesPage`, `onOpenGithubPage` and `onOpenJiraPage` are the same kind of pair, for the Sources card's three links (Files › Open, GitHub page, Jira setup): built once in
 * `App` as page store first, then `change`, and threaded through Shared to the card rather than rebuilt here — the source-sections rule that a source's
 * pages are switched by the rail's tree or by that pair, never by an in-page control. Optional for the same reason.
 */
export default function SettingsView({
  onOpenWatchdog,
  onOpenFilesPage,
  onOpenGithubPage,
  onOpenJiraPage
}: {
  onOpenWatchdog?: () => void;
  onOpenFilesPage?: () => void;
  onOpenGithubPage?: (p: GithubPage) => void;
  onOpenJiraPage?: (p: JiraPage) => void;
}) {
  const { settings, update } = useSettings();
  const scope = settings.settingsScope;

  return (
    <div className="set">
      {/* The page switch lives in the band (spec §3, §4.10), overriding the old "the rail is the only switch" rule: Local | Shared | Dashboards writes
          `settingsScope` through `update`, the same field the rail's Settings tree writes, so the two can never disagree — both read the one stored value.
          The sub-line says where THIS page saves, which is what the old band pill said in one word; the pill moved onto each card, where a card that wrote
          somewhere else would say so. */}
      <Band title="Settings" sub={BAND_SUB[scope]}>
        <Segmented value={scope} options={SCOPE_OPTIONS} onChange={(settingsScope) => update({ settingsScope })} label="Settings page" pill />
      </Band>

      {/* One of three pages, never a mix — the page IS the scope, so a card that mixed backends would make its pill a lie. */}
      {scope === 'shared' ? (
        <SharedPage onOpenWatchdog={onOpenWatchdog} onOpenFilesPage={onOpenFilesPage} onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
      ) : scope === 'dashboards' ? (
        <DashboardsPage />
      ) : (
        <LocalPage />
      )}
    </div>
  );
}

const SCOPE_OPTIONS: { value: SettingsScope; label: string }[] = [
  { value: 'local', label: 'Local' },
  { value: 'shared', label: 'Shared' },
  { value: 'dashboards', label: 'Dashboards' }
];

/**
 * The band's sub-line per page: where the page saves. Local lives in this browser's localStorage; Shared and Dashboards are the API host's files, so a change
 * there is a change for everyone who opens this board.
 */
const BAND_SUB: Record<SettingsScope, string> = {
  local: 'saves in this browser only',
  shared: 'saved on this machine',
  dashboards: 'saved on this machine'
};

/**
 * The Shared page: what this machine has connected — the Sources card, since the source-sections change, which took the old Trackers card's reports — the
 * watchdog's file beside the registry, since the tick breaker the tick halt threshold under the watchdog, and, since #241, the shared time zone under that.
 *
 * Four cards, and the hand-balanced columns hold up for a different reason than on Local: one column is the one host REPORT, `Sources`, the other the three
 * machine-wide CONTROLS (the watchdog's long card over the tick breaker's and the shared time zone's one-row cards). The report is the LEFT column now: the
 * spec puts `Sources` at the page's top, and a report that says what the machine has is what a reader of the controls beside it presumes — so it comes
 * first in reading order, and first when the columns fold under 1100 px. The old Trackers card's one control, each repo's sync interval, is GitHub ›
 * Settings' now. The machines a launch can run on were a fourth card here
 * (`Dashboards`, which had absorbed the old `Claude Agents` dispatch report as its Home row) until its list, its selection and its per-machine detail outgrew
 * a card: they are the Dashboards page now, so Shared draws no dispatch line at all and a reader looking for one is one rail entry away.
 */
function SharedPage({
  onOpenWatchdog,
  onOpenFilesPage,
  onOpenGithubPage,
  onOpenJiraPage
}: {
  onOpenWatchdog?: () => void;
  onOpenFilesPage?: () => void;
  onOpenGithubPage?: (p: GithubPage) => void;
  onOpenJiraPage?: (p: JiraPage) => void;
}) {
  return (
    <div className="set-col">
      {/* SHARED PAGE — Task 9 restyles these four cards in place. One column since Task 8; the order is the old reading order, report first. */}
      <SourcesGroup onOpenFilesPage={onOpenFilesPage} onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
      <WatchdogGroup onOpenWatchdog={onOpenWatchdog} />
      <TickGroup />
      <TimeZoneGroup />
    </div>
  );
}

/** The Local page: everything in this browser's localStorage, and nothing else. */
function LocalPage() {
  const { settings, update } = useSettings();
  const jiraConfigured = useJiraContext().data?.configured === true;
  const sources = useProjectsContext().drawn;

  return (
    /* One readable column (spec §4.10). The old two hand-balanced columns and their 1100 px fold are gone: a row is a label, a one-line description and a
       control, and a single column of those reads top to bottom at every width. */
    <div className="set-col">
      <SettingsGroup title="Display" pill="this browser">
        {/* Not a `SettingsRow`: the theme picker's control is a full-width track of picture cards under its own label, because five previews cannot fit a
            row's right-hand slot at any width this page has. The hint is the SELECTED theme's own line. */}
        <div className="set-row set-row-stacked">
          <div className="set-label">
            <span className="set-name">Theme</span>
            <span className="set-hint">{THEMES.find((t) => t.id === settings.theme)?.hint}</span>
          </div>
          {/* `aria-pressed` buttons rather than a radio group, as this picker always was: they apply at once and there is no form to submit. */}
          <div className="set-themes" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.id === settings.theme ? 'set-theme on' : 'set-theme'}
                aria-pressed={t.id === settings.theme}
                onClick={() => update({ theme: t.id })}
              >
                {/* A mini board that carries THAT theme's `data-theme`, so board, card and accent resolve from the theme's own custom properties
                    (shared/theme.css `[data-theme]` blocks) — no hex lives here, and a palette change in theme.css moves the preview with it. The
                    previews that used to mirror those hexes by hand drifted once already (#350). */}
                <span className="set-theme-board" data-theme={t.id} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="set-theme-name">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        <SettingsRow name="Density" hint="tighter padding, more cards per screen">
          <Segmented value={settings.density} options={DENSITIES} onChange={(density) => update({ density })} label="Density" pill />
        </SettingsRow>

        <SettingsRow
          name="Text size"
          hint="scales the whole board"
          more="Scales the whole board, not just type — the rail, the cards and the spacing move with it."
        >
          <Segmented
            value={settings.fontScale}
            options={stopsWith(FONT_SCALES, settings.fontScale).map((v) => ({ value: v, label: `${v}%` }))}
            onChange={(fontScale) => update({ fontScale })}
            label="Text size"
            pill
          />
        </SettingsRow>

        {/* Between Text size and Opens on: "how big is this board" has a fourth reading, how wide. `Opens on` is a different subject and stays last. */}
        <SettingsRow
          name="Content width"
          hint="fixed keeps the measure the board was drawn at"
          more="Fixed keeps the measure this board was drawn at, which is what every screenshot and every column width was tuned against. Full drops the cap so every section — the board, Runs, Archive and this page — spans the window."
        >
          <Segmented value={settings.contentWidth} options={CONTENT_WIDTH_OPTIONS} onChange={(contentWidth) => update({ contentWidth })} label="Content width" pill />
        </SettingsRow>

        <SettingsRow name="Opens on" hint="the section this browser lands on">
          <Segmented
            value={settings.landing}
            options={landingOptions(jiraConfigured, sources, settings.landing)}
            onChange={(landing) => update({ landing })}
            label="Opens on"
            pill
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Board" pill="this browser">
        <SettingsRow
          name="Archive after"
          hint="how long an open item may go untouched before it leaves the Board"
          more="Grooming one brings it straight back — the stamp this reads is written by every start and stop. Tasks never leave: a stale one keeps its column and is marked instead."
        >
          <Segmented
            value={settings.staleDays}
            options={stopsWith(STALE_WINDOWS, settings.staleDays).map((v) => ({ value: v, label: `${v}d` }))}
            onChange={(staleDays) => update({ staleDays })}
            label="Archive after"
            pill
          />
        </SettingsRow>
      </SettingsGroup>

      <OrchestratorGroup />

      <DispatchGroup />
    </div>
  );
}

/**
 * The three merge modes as icon cards: the title, the glyph and the one line are the brief's own words, in `MERGE_MODES` order, so a mode added to the union
 * without a card here is a type error rather than a silent gap.
 */
const MERGE_CARDS: Record<MergeMode, { title: string; line: string; glyph: GlyphName }> = {
  merge: { title: 'Merge into base', line: "each item lands on the run's base", glyph: 'merge' },
  branch: { title: 'Leave branches', line: 'stop at a reviewed branch per item', glyph: 'branch' },
  pr: { title: 'Open a PR', line: 'one PR per run, tracker projects', glyph: 'pull-request' }
};

/**
 * The two run-scoped defaults the Orchestrate sheet seeds its own pickers
 * from. A group of its own rather than more rows on `AgentsGroup` below: that
 * group answers "how does dispatch behave on this device", and neither of
 * these is a dispatch default. `Default model` and `Default effort` stayed
 * there for exactly that reason — they genuinely are dispatch defaults, and
 * the orchestrate sheet borrowing them is not a reason to move them.
 *
 * Placed above `WatchdogGroup` because the two are the same subject read at
 * two scopes and in the order a person meets them: this one is what a run is
 * started with, per device; the watchdog's is what happens to a run that has
 * already crashed, per server. Both say which in their titles, because the
 * distinction decides whether changing it here affects anyone else.
 */
function OrchestratorGroup() {
  const { settings, update } = useSettings();

  /*
   * bug-36. `null`, and emphatically not `'main'`: this row picks a DEFAULT,
   * at a moment when no run and therefore no base exists, so there is no
   * destination for the label to name and the base-less wording is the honest
   * one. The same function serves the Orchestrate sheet, where a base IS
   * known and the label names it — which is the whole reason the words live
   * in one place now. The hint interpolates these same two values rather than
   * quoting them by hand; the hand-typed quote below is how the stale string
   * came to exist in four independent copies, one of which task-44 could not
   * have found by searching for the other.
   */
  const labels = mergeModeOptionLabels(null);

  return (
    <SettingsGroup title="Orchestrator" pill="this browser">
      {/* Three icon cards in place of the old select (spec §4.10): a choice that changes what a run DOES is worth seeing whole before it is made. The long
          doctrine moved behind `ⓘ more`; the labels in it still come from `mergeModeOptionLabels`, so the sheet's picker and this text cannot disagree. */}
      <SettingsRow
        stacked
        name="Default merge mode"
        hint="preselected in the Orchestrate sheet · overridable per launch"
        more={`“${labels.merge}” merges each item into the branch the run was started on, which is main unless the launch picked another; “${labels.branch}” stops at a reviewed git branch per item instead; “${labels.pr}” drains the run onto a branch of its own and opens one pull request for the lot (tracker projects only).`}
      >
        <div className="set-merge-cards" role="group" aria-label="Default merge mode">
          {MERGE_MODES.map((m) => {
            const on = settings.orchestrateDefaultMergeMode === m;
            const card = MERGE_CARDS[m];
            return (
              <button
                key={m}
                type="button"
                className={on ? 'set-merge-card on' : 'set-merge-card'}
                aria-pressed={on}
                // The name is the title alone; the one-liner is the description, so a reader's tool says "Open a PR, button, pressed" and then the line.
                aria-label={card.title}
                aria-describedby={`set-merge-${m}`}
                onClick={() => update({ orchestrateDefaultMergeMode: m })}
              >
                <span className="set-merge-card-top">
                  <GlyphTile glyph={card.glyph} tone={on ? 'green' : 'neutral'} />
                  {on && <Glyph name="tick" size={16} />}
                </span>
                <span className="set-merge-card-title">{card.title}</span>
                <span className="set-merge-card-line" id={`set-merge-${m}`}>
                  {card.line}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsRow>

      {/* The doctrine lives behind `more`, because this is one of the four places a reader can arrive at this feature first (the others are the sheet's
          own picker, SKILL.md §3 and CLAUDE.md's invariants). The two modes are IDENTICAL whenever `AskUserQuestion` is reachable, so this setting only
          ever takes effect in a headless run, which is the only kind the board can start. */}
      <SettingsRow
        name="Default question mode"
        hint="what a run does with a question nobody can answer · headless runs only"
        more="Want control over a question, start the run from a harness that has AskUserQuestion; start it from the board and you are choosing between skipping the item and letting the runner answer. Overridable per launch."
      >
        <Select
          label="Default question mode"
          value={settings.orchestrateDefaultQuestionMode}
          options={[
            { value: 'decide' as QuestionMode, label: 'Decide and continue' },
            { value: 'park' as QuestionMode, label: 'Skip the item for me' }
          ]}
          onChange={(orchestrateDefaultQuestionMode) => update({ orchestrateDefaultQuestionMode })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * `Dispatch`, Local — the per-device half of what `Claude Agents` used to hold.
 *
 * A card of its own rather than three rows appended to `Orchestrator` above it:
 * that group answers "what is a RUN started with" and none of these is a run
 * default. This one answers "how does dispatch behave on this device", which is
 * the question the Agents card's own comment always said a reader arrives with
 * — the question just turned out to have a per-device answer and a per-machine
 * one, and only the page split forced them apart.
 *
 * Deliberately NOT gated on the integration being healthy: a default is worth
 * setting before dispatch works at all, and hiding the rows while it is down
 * would read as the setting having been lost. It also cannot be gated here even
 * in principle any more — health is the Shared page's reading, and this card
 * does not mount `useAgents`.
 */
function DispatchGroup() {
  const { settings, update } = useSettings();
  /* Bumped on a Dashboard link commit of new text, so the input's key moves even when the commit clamps back to the value already stored (#350). */
  const [linkCommits, setLinkCommits] = useState(0);
  const jira = useJiraContext().data;
  /* The row exists only while Jira does (§8.9.2's rule for the rail entry): a default for a menu nobody can open is a setting with no reader. `jira` is
     null until the status answers, and that is not "configured" either. The shown value goes through `resolveJiraAction` so a stored skill id that has
     since been deleted reads as `Work it end to end` — the same fall-back the card's own menu applies — while the stored string is left alone: a skill
     re-added under the same id (a hand-restored `jira.json`) takes the setting back without anyone re-picking it. */
  const jiraSkills = jira?.configured === true ? jira.skills : null;

  return (
    <SettingsGroup title="Dispatch" pill="this browser">
      {/* The two picker defaults, copied from the dashboard's own "New sessions
          · this device" group. `Default merge mode` used to sit beside them as
          a third and moved out in task-19: it never answered this card's
          question, and once a second orchestrate default existed the mismatch
          stopped being cosmetic. */}
      <SettingsRow
        name="Default model"
        hint="a card's launch sheet starts from this"
        more="“CLI default” sends no --model flag and lets Claude Code pick. Overridable per launch."
      >
        <Select
          label="Default model"
          value={settings.dispatchDefaultModel}
          options={[{ value: '', label: 'CLI default' }, ...MODELS.map((m) => ({ value: m as string, label: m }))]}
          onChange={(dispatchDefaultModel) => update({ dispatchDefaultModel })}
        />
      </SettingsRow>

      <SettingsRow name="Default effort" hint="a card's launch sheet starts from this" more="“CLI default” sends no --effort flag.">
        <Select
          label="Default effort"
          value={settings.dispatchDefaultEffort}
          options={[{ value: '', label: 'CLI default' }, ...EFFORTS.map((f) => ({ value: f as string, label: f }))]}
          onChange={(dispatchDefaultEffort) => update({ dispatchDefaultEffort })}
        />
      </SettingsRow>

      {/* The board's execute sheet's Finish default, beside the two it shares that sheet with. Labels are the sheet's own, so the row and the picker it seeds
          read as one control; the hint is the whole doctrine of the PR option, since this is where a reader can meet it before any launch. */}
      <SettingsRow name="Execute finish" hint="how an execute launch ends" more="PR mode works in its own worktree, reviews, pushes and opens a PR. It never merges.">
        <Select
          label="Execute finish"
          value={settings.executeDefaultFinish}
          options={EXECUTE_FINISH_OPTIONS}
          onChange={(executeDefaultFinish) => update({ executeDefaultFinish })}
        />
      </SettingsRow>

      {/* The groom sheet's Finish default and the two PR defaults both PR launches (groom and execute) seed from, directly under the execute one so the four
          read as one cluster (§8.6: rows on the pill `Switch`/`Select` primitives). Fix is a refinement of auto-merge, so its switch is dead — and says why in
          its title — while auto-merge is off; turning auto-merge off leaves the stored fix value alone, since the launch sheet seeds Fix off itself. */}
      <SettingsRow name="Groom finish" hint="how a groom launch ends" more="PR mode writes the spec and plan in its own worktree, commits, pushes and opens a PR. It never merges.">
        <Select
          label="Groom finish"
          value={settings.groomDefaultFinish}
          options={EXECUTE_FINISH_OPTIONS}
          onChange={(groomDefaultFinish) => update({ groomDefaultFinish })}
        />
      </SettingsRow>

      <SettingsRow
        name="Auto-merge PRs"
        hint="preselects Auto-merge on a PR launch"
        more="Armed only if the GitHub repo allows auto-merge — GitHub does the merge."
      >
        <Switch label="auto-merge PRs" checked={settings.prAutoMergeDefault} onChange={(prAutoMergeDefault) => update({ prAutoMergeDefault })} />
      </SettingsRow>

      <SettingsRow
        name="Fix if it fails"
        hint="preselects Fix on a PR launch"
        more="The session stays and fixes failing checks and base conflicts, up to 3 rounds in 45 minutes."
      >
        <Switch
          label="fix if it fails"
          checked={settings.prFixDefault}
          disabled={!settings.prAutoMergeDefault}
          title={settings.prAutoMergeDefault ? undefined : 'Needs Auto-merge PRs on'}
          onChange={(prFixDefault) => update({ prFixDefault })}
        />
      </SettingsRow>

      {jiraSkills !== null && (
        <SettingsRow
          name="Jira default action"
          hint="listed first in a Jira card's Run menu"
          more="Marked default. A skill that has since been deleted reads as Work it end to end. Saved in this browser."
        >
          <Select
            label="Jira default action"
            value={jiraSettingOf(resolveJiraAction(settings.jiraDefaultAction, jiraSkills))}
            options={[
              { value: 'execute', label: JIRA_BUILTIN_LABELS.execute },
              { value: 'context', label: JIRA_BUILTIN_LABELS.context },
              ...jiraSkills.map((k) => ({ value: k.id, label: k.name }))
            ]}
            onChange={(jiraDefaultAction) => update({ jiraDefaultAction })}
          />
        </SettingsRow>
      )}

      {/* Beside the action it seeds alongside, and drawn on the same condition: both are Jira launch-sheet defaults, and neither means anything while Jira
          is not configured. Not clamped to the ceiling here — this page is per device and the ceiling is the host's; the sheet clamps at render, so the
          hint says so rather than this select hiding modes a raised ceiling would give back. */}
      {jiraSkills !== null && (
        <SettingsRow
          name="Jira default permission"
          hint="what a Jira launch's Permissions starts on"
          more="Per action is plan for Open with the ticket loaded, acceptEdits for the rest; a mode applies to every action. Capped by the host's ceiling at launch."
        >
          <Select<JiraDefaultPermission>
            label="Jira default permission"
            value={settings.jiraDefaultPermission}
            options={JIRA_DEFAULT_PERMISSIONS.map((m) => ({ value: m, label: m === '' ? 'Per action' : m }))}
            onChange={(jiraDefaultPermission) => update({ jiraDefaultPermission })}
          />
        </SettingsRow>
      )}

      {/* The link RIDES this row since task-42, rather than sitting on the
          status row a card away. A link driven by a per-device value had no
          business on the page that promises everything on it is the host's —
          and beside the field that supplies its href it also becomes
          self-explaining, which it never was up on a status row.

          Two controls in one right slot, the field and the link, which is the
          only row on this page with two: they are one setting read and one
          setting used. */}
      <SettingsRow
        name="Dashboard link"
        hint="where this browser reaches the dashboard"
        more="The laptop on loopback, a phone on its tailnet name. Used only for the link; the API calls it over BM_AGENTS_URL."
      >
        <input
          type="text"
          className="set-text"
          aria-label="Dashboard link"
          defaultValue={settings.linkBase}
          // Re-seed on commit, same idiom and same reason as `NumberField`
          // (`components/ui/NumberField.tsx`): this field's own commit path can rewrite
          // what was typed into a different canonical value — `clampOrigin`
          // (client/src/lib/settings.ts) strips a trailing slash, or falls
          // back to the default outright on a rejected scheme. Without this
          // key the box is a `defaultValue`-only input React never touches
          // again after mount, so it would go on showing the untouched
          // keystrokes forever — silently disagreeing with what is actually
          // stored and about to be used as the "open dashboard" href.
          // The commit counter is half the key because the stored value alone
          // does not move when `clampOrigin` maps the typed text back to what
          // is already stored — a trailing slash on the current origin, or a
          // refused scheme while the default is stored — and an unchanged key
          // kept the stale node (#350). It moves only when the typed text
          // differs from what is stored, the one case there is anything to
          // re-seed; NumberField follows the same rule.
          key={`${settings.linkBase}:${linkCommits}`}
          onBlur={(e) => {
            const typed = e.currentTarget.value;
            update({ linkBase: typed });
            if (typed !== settings.linkBase) setLinkCommits((n) => n + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        {/* The button member of §8.6's 36 px control family, and an `<a>`
            rather than a `<button>` because it navigates: `.set-link` is
            Settings' own class, not `.sheet-link`'s second caller, so
            restyling a settings control to this page's figures cannot reach
            into the launch sheet that still draws the other one. */}
        <a className="set-link" href={settings.linkBase} target="_blank" rel="noreferrer">
          open dashboard ↗
        </a>
      </SettingsRow>
    </SettingsGroup>
  );
}
