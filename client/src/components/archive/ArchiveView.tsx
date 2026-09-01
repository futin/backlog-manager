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
 * scope. Task 5 landed the first half of that split ahead of this view — the
 * Board evicts those items now (`lib/item-stale.ts`), and until the columns
 * below exist they are listed nowhere at all. That gap is exactly why the
 * note names them: a card that left the Board with no surface admitting to
 * holding it is the one reading of this screen that would be alarming, and
 * it is the reading a stale `coming soon` would have left in place. Both halves can come back, by different routes — a stale item
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
        No columns here yet. The Board has already stopped showing open items
        nobody has touched inside the staleness window — they are still on
        disk, and this is where they will be listed, alongside everything
        already ruled out of scope. Tasks are never among them: a stale task
        keeps its column on the Board and is marked instead.
        <br />
        Neither half is a dead end: grooming a stale item brings it straight
        back to the Board, and an out-of-scope one comes back as a new item
        that cites it, leaving the original rejection on the record.
      </p>
    </div>
  );
}
