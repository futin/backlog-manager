/**
 * Archive — the board's second surface, and for now only its name and a note
 * saying what is coming.
 *
 * The note is the point. An empty section reached from a rail tab reads as a
 * bug: the reader clicked something, got a blank main area, and has no way to
 * tell "nothing has been built here yet" from "the fetch failed" or "this
 * project has no items". Naming the contents is what separates those, and a
 * bare "coming soon" does not — it says a screen is missing without saying
 * which, so the reader still cannot decide whether to wait for it or go
 * looking for their data somewhere else.
 *
 * What it describes is the design's Archive (docs/superpowers/specs/
 * 2026-08-30-board-growth-design.md): open items whose `updated:` stamp has
 * fallen outside the staleness window, plus everything ever ruled out of
 * scope. Both halves can come back, by different routes — a stale item
 * through a groom session, which refreshes `updated:` and returns it to the
 * Board, and an out-of-scope one through a *new* item citing it, since
 * `moveItem` refuses every move out of `out-of-scope/` and the rejection
 * record is the reason it does. Saying so here is worth the four lines: the
 * fear an archive raises is that things fall into it and stop existing.
 *
 * Its own file, and lazy-loaded by App like BoardView and SettingsView, rather
 * than a few lines of JSX inlined into the shell — the surface it stands in
 * for is four filtered columns with its own promotion affordances, so this
 * file becomes that view rather than being replaced by it, and App's wiring
 * does not have to be revisited to land it.
 */
export default function ArchiveView() {
  return (
    <div className="board">
      <div className="board-bar">
        <div className="board-title">Archive</div>
      </div>
      <p className="board-note">
        Nothing here yet. Archive will hold open items nobody has touched in a
        while, alongside everything already ruled out of scope — so the Board
        can stay the things that are actually live.
        <br />
        Neither half is a dead end: grooming a stale item brings it straight
        back to the Board, and an out-of-scope one comes back as a new item
        that cites it, leaving the original rejection on the record.
      </p>
    </div>
  );
}
