/**
 * Runs — the board's third surface: history of every backlog-orchestrate run
 * across every registered project, not the single currently-running one the
 * board's own RunStrip already surfaces above the columns. RunStrip answers
 * "is anything running right now"; this section answers "what has this
 * project's orchestrator ever done" — today just Task 6's live poll, and
 * once Task 7 lands, every run archived to disk as well.
 *
 * Task 5 lands only the shell: a heading and the empty state, wired into the
 * rail and routable, with nothing behind it yet. That split — land the tab
 * before the data — is the same one ArchiveView shipped under, and for the
 * same reason: a rail entry that opens onto a blank main area reads as a
 * bug, not as "not built yet", because the reader who clicked it has no way
 * to tell a missing screen from a failed fetch. Naming the section and its
 * empty state is what a placeholder owes the reader in the meantime.
 *
 * "no runs yet" is not placeholder copy standing in for something better,
 * though — it is the final string for the genuinely-empty case (no run
 * recorded for any registered project), which Task 6 keeps verbatim once it
 * wires `useOrchestratorRuns` (already used by RunStrip) and the archive
 * hook in behind this heading and renders that check over both payloads
 * combined. Right now it is simply always shown, because this shell has no
 * other state to be in yet.
 *
 * No hook, no fetch, no `useState` here on purpose — unlike ArchiveView,
 * which already reads live board data to explain what it is temporarily
 * hiding, this shell has nothing on this branch to read from yet that would
 * change what it renders.
 *
 * Its own file, lazy-loaded by App like BoardView/ArchiveView/SettingsView,
 * rather than a few lines of JSX inlined into the shell — the surface this
 * stands in for is a stat-tile header plus a run list and detail pane
 * (docs/superpowers/specs/2026-09-01-orchestration-archive-design.md), so
 * this file becomes that view rather than being replaced by it, and App's
 * wiring does not have to be revisited to land it.
 *
 * `.board`/`.board-bar`/`.board-title`/`.board-note` are the same generic
 * section scaffold ArchiveView uses, not new classes of its own — the two
 * placeholders are the same shape of thing, so styling.css gains nothing new
 * on the way to Task 6 restyling this file's insides.
 */
export default function RunsView() {
  return (
    <div className="board">
      <div className="board-bar">
        <div className="board-title">Runs</div>
      </div>
      <p className="board-note">no runs yet</p>
    </div>
  );
}
