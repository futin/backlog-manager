import { SettingsGroup, SettingsRow } from './SettingsRow';
import { Band } from '../ui/Band';
import { Pill } from '../ui/Pill';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { TrackersGroup } from './TrackersGroup';
import { WatchdogGroup } from './WatchdogGroup';
import { useAgents } from '../../hooks/useAgents';
import { useSettings } from '../../hooks/useSettings';
import { FONT_SCALES, STALE_WINDOWS, THEMES, type ContentWidth, type Landing, type ThemeId } from '../../lib/settings';
import { EFFORTS, MODELS } from '../../../../shared/agent';
import type { AgentsStatus, MergeMode, QuestionMode } from '../../../../shared/types';

/**
 * Preview colors per theme — board / strip / accent, in that order. A mirror of
 * the `[data-theme]` blocks in shared/theme.css, kept here because it is
 * presentation: the swatch has to paint a palette that is NOT currently applied,
 * so it cannot read the live custom properties.
 */
const SWATCHES: Record<ThemeId, [string, string, string]> = {
  midnight: ['#0c1220', '#182238', '#55d0dd'],
  graphite: ['#111214', '#1f2124', '#6fc5cf'],
  amber: ['#0a0805', '#1a150c', '#ffb03a'],
  nightshift: ['#07120d', '#12251b', '#4fe09a'],
  daylight: ['#e8e3d7', '#fbf8f1', '#136d78']
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
  { value: 'board', label: 'Board' },
  { value: 'runs', label: 'Runs' },
  { value: 'archive', label: 'Archive' },
  { value: 'settings', label: 'Settings' }
];

/**
 * The dot's three colors answer one question — "can I dispatch right now?" —
 * not the whole gate ladder `dispatchGate` walks: `spawnAvailable` (no
 * CLAUDE_BIN) still surfaces as gap text below, it just doesn't change the
 * color. `green` needs the dashboard reachable AND remote answers on;
 * anything short of reachable (off, unreachable, still checking) is `gray`
 * rather than a fourth color, since none of those name a fixable dashboard
 * setting the way "remote answers off" does.
 */
type DotTier = 'green' | 'amber' | 'gray';

function dispatchDotTier(status: AgentsStatus | null): DotTier {
  if (status === null || !status.enabled || !status.reachable) return 'gray';
  return status.remoteAnswer ? 'green' : 'amber';
}

function Dot({ tier }: { tier: DotTier }) {
  return <span className={`set-dot set-dot-${tier}`}>●</span>;
}

/**
 * One line per gate, in the order dispatchBlock (shared/agent.ts) checks
 * them, so the first red dot named here is also the thing worth fixing
 * first. Read-only: every one of these gates lives on a host — in this
 * API's env or in the dashboard's — and a switch here that wrote to a
 * browser's localStorage would just be a lie about where the setting is.
 */
// No wrapping `<span className="set-hint">` here on purpose: every caller
// passes this straight into `SettingsRow`'s `hint` prop, which already wraps
// its child in that exact span (`SettingsRow.tsx`). Wrapping it again here
// nested a `.set-hint` inside a `.set-hint` — harmless (the class sets no
// compounding properties) but redundant, so this returns bare content and
// lets the row supply the class once.
function AgentsStatusLines({ status }: { status: AgentsStatus | null }) {
  const dot = <Dot tier={dispatchDotTier(status)} />;
  if (status === null) return <>checking…</>;
  if (!status.enabled) return <>{dot} off — dispatch is not enabled on the API</>;
  if (!status.reachable) {
    return (
      <>
        {dot} unreachable{status.error ? ` — ${status.error}` : ''}
      </>
    );
  }
  const gaps = [status.spawnAvailable ? null : 'no CLAUDE_BIN', status.remoteAnswer ? null : 'remote answers off'].filter((g): g is string => g !== null);
  return (
    <>
      {dot} connected{gaps.length > 0 ? ` — ${gaps.join(', ')}` : ' · spawn on'}
      {' · '}ceiling: {status.spawnMaxPermission ?? 'unknown'}
      {' · '}
      {status.projectPaths.length} projects
    </>
  );
}

/**
 * The Settings section (`.claude/DESIGN.md` §8.6): this device only
 * (localStorage), plus the one card that is not — the watchdog's, which says so
 * in its own scope subtitle.
 *
 * `onOpenWatchdog` is the rail's own navigation, threaded down for the watchdog
 * group's `Live view` link (DESIGN.md §8.6), exactly as `BoardView` takes
 * `onOpenRuns` for its run chip and for the same reason: the link and the
 * rail's Watchdog sub-nav entry have to mean the same thing by construction,
 * and the section lives in `App`'s shell. Optional, because every suite that
 * renders this view bare predates the link and none of them needs a
 * destination for it.
 */
export default function SettingsView({ onOpenWatchdog }: { onOpenWatchdog?: () => void }) {
  const { settings, update } = useSettings();
  const shared = settings.settingsScope === 'shared';

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
        sub={
          shared
            ? 'What the API reads off the host — the watchdog file beside the registry, and the environment the server was started with. Change one here and it changes for everyone.'
            : 'How this board looks and behaves on this device. These live in this browser and never leave it.'
        }
      >
        <Pill tone="neutral">{shared ? 'this machine' : 'this browser'}</Pill>
      </Band>

      {/* One of two card sets, never both — the page IS the scope (§8.6), so a
          card that mixed backends would make the pill above a lie. That is why
          `Claude Agents` is two cards: its status lines report the HOST's
          environment while its model, effort and link rows were this browser's
          localStorage all along, and the split is what let each half sit under
          a truthful heading.

          There is no in-page control that moves between these two, at any
          width. The rail's tree is the only one, the same rule Runs' two pages
          follow since task-38; a second control here would be a second wording
          free to disagree with the tree's. */}
      {shared ? <SharedPage onOpenWatchdog={onOpenWatchdog} /> : <LocalPage />}
    </div>
  );
}

/**
 * The Shared page: the watchdog's file beside the registry, the host
 * environment `Claude Agents` reports on, and — since task-45 — what this
 * machine can currently see of each project's tracker.
 *
 * Three cards, and the hand-balanced columns hold up for a different reason
 * here than on Local: this is the watchdog's long card against two shorter
 * reports stacked in one column, rather than Local's two short cards over two
 * taller ones. Both of the right column's cards report on the HOST and neither
 * sets anything, which is what makes them one column rather than two halves of
 * the page.
 */
function SharedPage({ onOpenWatchdog }: { onOpenWatchdog?: () => void }) {
  return (
    <div className="set-cols">
      <div className="set-col">
        <WatchdogGroup onOpenWatchdog={onOpenWatchdog} />
      </div>

      <div className="set-col">
        <AgentsGroup />
        {/* Beside Claude Agents (spec §5.6), under it in the same column: both
            report on the HOST — one on the dispatch environment, one on the
            tracker connection — and both are read-only reports rather than
            controls, so they read as one column of "what this machine can
            currently reach". */}
        <TrackersGroup />
      </div>
    </div>
  );
}

/** The Local page: everything in this browser's localStorage, and nothing else. */
function LocalPage() {
  const { settings, update } = useSettings();

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
       entirely: the watchdog's long card against the agents report, one tall
       column each (see `SharedPage`).

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
                options={FONT_SCALES.map((v) => ({ value: v, label: `${v}%` }))}
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
              <Select label="Opens on" value={settings.landing} options={LANDINGS} onChange={(landing) => update({ landing })} />
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
                options={STALE_WINDOWS.map((v) => ({ value: v, label: `${v}d` }))}
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

  return (
    <SettingsGroup title="Orchestrator" scope="this device">
      <SettingsRow
        name="Default merge mode"
        hint="Preselected in the Orchestrate sheet. “Merge to main” is what every run does today; “Leave branches for me” stops at a reviewed git branch per item instead. Overridable per launch."
      >
        <Select
          label="Default merge mode"
          value={settings.orchestrateDefaultMergeMode}
          options={[
            { value: 'merge' as MergeMode, label: 'Merge to main' },
            { value: 'branch' as MergeMode, label: 'Leave branches for me' }
          ]}
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
 * `Claude Agents`, Shared — a report on where the HOST's dispatch config
 * currently stands, and nothing this browser can change.
 *
 * task-42 took three rows out of this card. `Default model`, `Default effort`
 * and `Dashboard link` were this browser's localStorage sitting under a
 * heading that says `this machine`, which was tolerable while Settings was one
 * page and is not now that the page IS the scope: they are `DispatchGroup`
 * below, on Local. What is left is genuinely the host's — the status lines and
 * the conditional setup block — which is why this card has a status row with
 * nothing in its right slot at all. The `open dashboard ↗` link went with the
 * per-device field that supplies its href.
 *
 * The bearer token is not here and never was, on either page: it must never be
 * in a browser at all.
 */
function AgentsGroup() {
  const { status } = useAgents();
  const healthy = status !== null && status.enabled && status.reachable && status.spawnAvailable && status.remoteAnswer;

  return (
    <SettingsGroup title="Claude Agents" scope="this machine">
      {/* No control in the right slot, which is the shape of a card that
          reports rather than sets. Every gate named in the hint lives on a host
          — in this API's env or in the dashboard's — and a switch here that
          wrote to a browser's localStorage would just be a lie about where the
          setting is. */}
      <SettingsRow name="Dispatch" hint={<AgentsStatusLines status={status} />} />

      {/* Gated on an actual answer, not bare `!healthy`: `healthy` starts
          false the instant `status` is still `null` (its own `status !==
          null` check fails first), which would fold "not answered yet" into
          "broken" and tell the reader to go edit their .env while the status
          line above still correctly says "checking…". */}
      {status !== null && !healthy && (
        <div className="set-row set-row-stacked">
          <div className="set-label">
            <span className="set-name">Setting it up</span>
            <span className="set-hint">
              1 · <code>BM_AGENTS=on</code> and <code>BM_AGENTS_URL</code> in this app's <code>.env</code>, then restart the API.
              <br />2 · <code>CLAUDE_BIN</code> in the dashboard's <code>.env</code> — that is its spawn gate.
              <br />
              3 · Turn its remote-answer pill on; spawning is refused without it.
              <br />4 · Run its <code>pnpm hooks:install</code>, or a groom that asks you a question will stall with nowhere to ask.
              <br />5 · A project needs one Claude session inside the dashboard's <code>LOOKBACK_HOURS</code> before it can be dispatched to — open one there,
              or raise <code>LOOKBACK_HOURS</code> in the dashboard's <code>.env</code>.
            </span>
          </div>
        </div>
      )}
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
          key={settings.linkBase}
          onBlur={(e) => update({ linkBase: e.currentTarget.value })}
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
