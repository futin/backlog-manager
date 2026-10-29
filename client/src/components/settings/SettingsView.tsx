import { useState } from 'react';

import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Band } from '../ui/Band';
import { Pill } from '../ui/Pill';
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
import { FONT_SCALES, STALE_WINDOWS, THEMES, stopsWith, type ContentWidth, type Landing, type SettingsScope, type ThemeId } from '../../lib/settings';
import { EFFORTS, MODELS } from '../../../../shared/agent';
import { JIRA_BUILTIN_LABELS, MERGE_MODES } from '../../../../shared/types';
import type { QuestionMode } from '../../../../shared/types';

/**
 * Preview colors per theme — board / strip / accent, in that order. A mirror of
 * the `[data-theme]` blocks in shared/theme.css, kept here because it is
 * presentation: the swatch has to paint a palette that is NOT currently applied,
 * so it cannot read the live custom properties.
 *
 * The accent is each theme's `--cyan`, because `--accent` is `var(--cyan)` in every
 * theme — amber and nightshift override `--cyan`, not `--accent`. Those two once
 * mirrored `--amber` and `--green` instead and nothing noticed (#350); exported so
 * test/settings-view.test.tsx can hold all five against theme.css.
 */
export const SWATCHES: Record<ThemeId, [string, string, string]> = {
  midnight: ['#0c1220', '#182238', '#55d0dd'],
  graphite: ['#111214', '#1f2124', '#6fc5cf'],
  amber: ['#0a0805', '#1a150c', '#ffc76b'],
  nightshift: ['#07120d', '#12251b', '#54cfba'],
  daylight: ['#f4f4f3', '#ffffff', '#306c0f']
};

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
 * `onOpenGithubPage` and `onOpenJiraPage` are the same kind of pair, for the Sources card's two links (GitHub › Settings, Jira › Setup): built once in
 * `App` as page store first, then `change`, and threaded through Shared to the card rather than rebuilt here — the source-sections rule that a source's
 * pages are switched by the rail's tree or by that pair, never by an in-page control. Optional for the same reason.
 */
export default function SettingsView({
  onOpenWatchdog,
  onOpenGithubPage,
  onOpenJiraPage
}: {
  onOpenWatchdog?: () => void;
  onOpenGithubPage?: (p: GithubPage) => void;
  onOpenJiraPage?: (p: JiraPage) => void;
}) {
  const { settings, update } = useSettings();
  const scope = settings.settingsScope;

  return (
    <div className="set">
      {/* A band, like every other page on this board (DESIGN.md §8.2/§8.6):
          the 19/500 title over a 13 px line. Its right slot carries ONE thing
          and it is not a control — the scope pill, stating which backend this
          page's cards write to. Every control on this page still belongs to a
          row inside a card; one hoisted up here would be a setting with no
          group saying what it scopes.

          Both pages use `tone="neutral"` and let the WORD carry the
          distinction. Deliberately not a green-tinted Shared pill of the kind
          the dashboard this pattern came from draws: `PillTone`'s five members
          each name a reading — live, warn, bad, done, neutral — none of them
          means "shared", and minting a second pill look inside the settings
          block would be a second home for a primitive, which
          test/design-guards.test.ts's guard 7 exists to refuse.

          The subtitle changes with the page because the one-line summary is now
          the page's own, and it is the sentence that makes the pill mean
          something rather than decorate. */}
      <Band
        title="Settings"
        sub={BAND_SUB[scope]}
      >
        <Pill tone="neutral">{scope === 'local' ? 'this browser' : 'this machine'}</Pill>
      </Band>

      {/* One of three card sets, never both — the page IS the scope (§8.6), so a
          card that mixed backends would make the pill above a lie. That is why
          the old `Claude Agents` card was split: its status lines report the
          HOST's environment (now the Home row of `Dashboards`) while its model,
          effort and link rows were this browser's localStorage all along (now
          `Dispatch` on Local), and the split is what let each half sit under a
          truthful heading.

          There is no in-page control that moves between these three, at any
          width. The rail's tree is the only one, the same rule Runs' three pages
          follow since task-38; a second control here would be a second wording
          free to disagree with the tree's. */}
      {scope === 'shared' ? (
        <SharedPage onOpenWatchdog={onOpenWatchdog} onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
      ) : scope === 'dashboards' ? (
        <DashboardsPage />
      ) : (
        <LocalPage />
      )}
    </div>
  );
}

/**
 * The band's one-line summary per page — the sentence that makes the scope pill mean something rather than decorate. The Dashboards line is its own and not
 * the page's footer lead (`Listed in prefer order — move a machine with ↑ ↓…`), which stays where the reader has the list in front of them.
 */
const BAND_SUB: Record<SettingsScope, string> = {
  local: 'How this board looks and behaves on this device. These live in this browser and never leave it.',
  shared:
    'What the API reads off the host — the watchdog file beside the registry, and the environment the server was started with. Change one here and it changes for everyone.',
  dashboards:
    'The machines a launch can run on, in prefer order, and how the launch sheet picks one. Saved on the API host — change it here and it changes for everyone.'
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
  onOpenGithubPage,
  onOpenJiraPage
}: {
  onOpenWatchdog?: () => void;
  onOpenGithubPage?: (p: GithubPage) => void;
  onOpenJiraPage?: (p: JiraPage) => void;
}) {
  return (
    <div className="set-cols">
      <div className="set-col">
        {/* The host's one report on this page: what this machine has connected, per source, and whether it works (source-sections spec). */}
        <SourcesGroup onOpenGithubPage={onOpenGithubPage} onOpenJiraPage={onOpenJiraPage} />
      </div>

      <div className="set-col">
        <WatchdogGroup onOpenWatchdog={onOpenWatchdog} />
        {/* Under the watchdog, in its column: both are machine-wide CONTROLS — a number written to a file on the host — where the left column is the host
            REPORT. The breaker is the watchdog's sibling in subject too: one resumes a crashed run, the other stops a project that keeps failing. */}
        <TickGroup />
        {/* The third host CONTROL (#241): one zone every device reads the board in, written to a file beside the other two. Last in the column because it
            is the one control here that changes no machine behaviour — it only moves how readings are drawn. */}
        <TimeZoneGroup />
      </div>
    </div>
  );
}

/** The Local page: everything in this browser's localStorage, and nothing else. */
function LocalPage() {
  const { settings, update } = useSettings();
  const jiraConfigured = useJiraContext().data?.configured === true;
  const sources = useProjectsContext().drawn;

  return (
    /* Two hand-balanced columns (§8.6), placed by hand rather than reflowed: a
       masonry pass would move a card to the other side of the page as its
       neighbour above grew a row, so a reader who learnt where a card sits
       would find it somewhere else after a knob changed.

       Each page has its own balance, and both are hand-checked. Local is two
       short cards against two taller ones — `Display` over `Board` on the left,
       `Orchestrator` over `Dispatch` on the right — which keeps the adjacency
       that still carries meaning after the split: what a run is STARTED with,
       beside what a dispatch is started with. `Orchestrator watchdog` used to
       hang under `Orchestrator` for the same kind of reason, and that pairing
       is gone by design — the watchdog is the server's and this page is the
       browser's, and the split is what says so. Shared is the other shape
       entirely: the Sources report alone against the watchdog's long card,
       the tick breaker and the time zone (see `SharedPage`).

       Folds to one column under 1100 px, which is Settings' own breakpoint and
       deliberately NOT the 700 px phone break every other split on this board
       uses: these cards are a label-and-control row each, so they run out of
       width for a side-by-side row long before the columns do. */
    <div className="set-cols">
        <div className="set-col">
          <SettingsGroup title="Display" scope="this device">
            {/* Not a `SettingsRow`: the theme picker's control is a full-width
                track under its own label rather than a control sitting to the
                right of one, because five options with a swatch each cannot fit
                a row's right-hand slot at any width this page has. The hint is
                the SELECTED theme's own line, which is why it reads as a
                description rather than as an instruction. */}
            <div className="set-row set-row-stacked">
              <div className="set-label">
                <span className="set-name">Theme</span>
                <span className="set-hint">{THEMES.find((t) => t.id === settings.theme)?.hint}</span>
              </div>
              {/* The `Switch` primitive's own ground, restated as a page layout
                  rather than borrowed from its class family (§12.1 forbids the
                  borrowing, guard 7 pins it): a recessed `--steel` track under
                  raised `--strip` options. A raised option marks a STATE, which
                  is §8's standing rule and the whole reason the selected theme
                  is the one that lifts rather than the one that gains a colour.
                  `aria-pressed` rather than a radio group, unchanged from what
                  this picker always did — a pressed toggle is what a reader
                  hears, and the five are not a form field. */}
              <div className="set-themes" role="group" aria-label="Theme">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={t.id === settings.theme ? 'set-theme on' : 'set-theme'}
                    aria-pressed={t.id === settings.theme}
                    onClick={() => update({ theme: t.id })}
                  >
                    {/* 24 px at an 8 px radius — this design's own figure
                        (§8.6), not the 34 px strip at a 2 px corner this
                        carried before. Three bands: board, strip, accent. */}
                    <span className="set-swatch">
                      <i style={{ background: SWATCHES[t.id][0] }} />
                      <i style={{ background: SWATCHES[t.id][1] }} />
                      <i style={{ background: SWATCHES[t.id][2] }} />
                    </span>
                    <span className="set-theme-name">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <SettingsRow name="Density" hint="Compact tightens padding and the gaps between cards — more items per screen.">
              <Segmented value={settings.density} options={DENSITIES} onChange={(density) => update({ density })} label="Density" pill />
            </SettingsRow>

            <SettingsRow name="Text size" hint="Scales the whole board, not just type — the rail, the cards and the spacing move with it.">
              <Segmented
                value={settings.fontScale}
                options={stopsWith(FONT_SCALES, settings.fontScale).map((v) => ({ value: v, label: `${v}%` }))}
                onChange={(fontScale) => update({ fontScale })}
                label="Text size"
                pill
              />
            </SettingsRow>

            {/* Between Text size and Opens on, because the three rows above it
                are all "how big is this board" and this is the fourth reading
                of that same question — how wide. `Opens on` is a different
                subject (which section) and stays last. */}
            <SettingsRow
              name="Content width"
              hint="Fixed keeps the measure this board was drawn at, which is what every screenshot and every column width was tuned against. Full drops the cap so every section — the board, Runs, Archive and this page — spans the window."
            >
              <Segmented value={settings.contentWidth} options={CONTENT_WIDTH_OPTIONS} onChange={(contentWidth) => update({ contentWidth })} label="Content width" pill />
            </SettingsRow>

            <SettingsRow name="Opens on" hint="Which section this device lands on when you load the page.">
              <Select
                label="Opens on"
                value={settings.landing}
                options={landingOptions(jiraConfigured, sources, settings.landing)}
                onChange={(landing) => update({ landing })}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title="Board" scope="this device">
            <SettingsRow
              name="Archive after"
              hint={
                <>
                  How long an open item may go untouched before it leaves the Board for Archive. Grooming one brings it straight back — the stamp this reads is
                  written by every start and stop. Tasks never leave: a stale one keeps its column and is marked instead.
                </>
              }
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

        </div>

        <div className="set-col">
          <OrchestratorGroup />

          <DispatchGroup />
        </div>
    </div>
  );
}

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
    <SettingsGroup title="Orchestrator" scope="this device">
      <SettingsRow
        name="Default merge mode"
        hint={`Preselected in the Orchestrate sheet. “${labels.merge}” merges each item into the branch the run was started on, which is main unless the launch picked another; “${labels.branch}” stops at a reviewed git branch per item instead; “${labels.pr}” drains the run onto a branch of its own and opens one pull request for the lot (tracker projects only). Overridable per launch.`}
      >
        <Select
          label="Default merge mode"
          value={settings.orchestrateDefaultMergeMode}
          options={MERGE_MODES.map((m) => ({ value: m, label: labels[m] }))}
          onChange={(orchestrateDefaultMergeMode) => update({ orchestrateDefaultMergeMode })}
        />
      </SettingsRow>

      {/* The hint carries the whole doctrine, because this is one of the four
          places a reader can arrive at this feature first (the others are the
          sheet's own picker, SKILL.md §3 and CLAUDE.md's invariants). The two
          modes are IDENTICAL whenever `AskUserQuestion` is reachable — the ask
          itself is unchanged in both — so this setting only ever takes effect
          in a headless run, which is the only kind the board can start. */}
      <SettingsRow
        name="Default question mode"
        hint="What a run does with an item's open questions when nobody can answer them. Want control over a question, start the run from a harness that has AskUserQuestion; start it from the board and you are choosing between skipping the item and letting the runner answer. Overridable per launch."
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
    <SettingsGroup title="Dispatch" scope="this device">
      {/* The two picker defaults, copied from the dashboard's own "New sessions
          · this device" group. `Default merge mode` used to sit beside them as
          a third and moved out in task-19: it never answered this card's
          question, and once a second orchestrate default existed the mismatch
          stopped being cosmetic. */}
      <SettingsRow
        name="Default model"
        hint="Preselected in a card's launch sheet. “CLI default” sends no --model flag and lets Claude Code pick. Overridable per launch."
      >
        <Select
          label="Default model"
          value={settings.dispatchDefaultModel}
          options={[{ value: '', label: 'CLI default' }, ...MODELS.map((m) => ({ value: m as string, label: m }))]}
          onChange={(dispatchDefaultModel) => update({ dispatchDefaultModel })}
        />
      </SettingsRow>

      <SettingsRow name="Default effort" hint="Preselected in a card's launch sheet. “CLI default” sends no --effort flag.">
        <Select
          label="Default effort"
          value={settings.dispatchDefaultEffort}
          options={[{ value: '', label: 'CLI default' }, ...EFFORTS.map((f) => ({ value: f as string, label: f }))]}
          onChange={(dispatchDefaultEffort) => update({ dispatchDefaultEffort })}
        />
      </SettingsRow>

      {/* The board's execute sheet's Finish default, beside the two it shares that sheet with. Labels are the sheet's own, so the row and the picker it seeds
          read as one control; the hint is the whole doctrine of the PR option, since this is where a reader can meet it before any launch. */}
      <SettingsRow name="Execute finish" hint="PR mode works in its own worktree, reviews, pushes and opens a PR. It never merges.">
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
      <SettingsRow name="Groom finish" hint="PR mode writes the spec and plan in its own worktree, commits, pushes and opens a PR. It never merges.">
        <Select
          label="Groom finish"
          value={settings.groomDefaultFinish}
          options={EXECUTE_FINISH_OPTIONS}
          onChange={(groomDefaultFinish) => update({ groomDefaultFinish })}
        />
      </SettingsRow>

      <SettingsRow
        name="Auto-merge PRs"
        hint="Preselects Auto-merge on a PR launch. Armed only if the GitHub repo allows auto-merge — GitHub does the merge."
      >
        <Switch label="auto-merge PRs" checked={settings.prAutoMergeDefault} onChange={(prAutoMergeDefault) => update({ prAutoMergeDefault })} />
      </SettingsRow>

      <SettingsRow
        name="Fix if it fails"
        hint="Preselects Fix on a PR launch: the session stays and fixes failing checks and base conflicts, up to 3 rounds in 45 minutes."
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
          hint="Listed first in a Jira card's Run menu, marked default. A skill that has since been deleted reads as Work it end to end."
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
        hint="Where THIS device reaches the dashboard — the laptop on loopback, a phone on its tailnet name. Used only for the link; the API calls it over BM_AGENTS_URL."
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
