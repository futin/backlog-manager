# Board growth: sections, Archive, and time tracking

Design for the second structural pass over the board. The first pass
(2026-08-26) built four fixed type columns and a registry; this one answers
what happens when five projects become fifteen and the columns stop being
enough.

## The problem

`Section` conflates three orthogonal things: **type** (bug / idea / task),
**lifecycle** (open → done), and **verdict** (out-of-scope). Every new type
therefore costs a column, and the board is already four columns wide at
~250px each. Meanwhile nothing ever leaves the board: a rejected item and a
bug filed in June sit at the same visual weight as the thing you are working
on this afternoon.

The fix is not more columns. It is a second surface — Archive — that takes
everything still *actionable in principle* but not actionable *now*, and a
staleness signal that moves items there without anyone deciding to.

## The model

Two board surfaces, each four columns.

| Surface | Columns | Holds |
|---|---|---|
| **Board** | Refactoring · Ideas · Bugs · Tasks | open items touched within the staleness window |
| **Archive** | Refactoring · Ideas · Bugs · Out of scope | open items past the window, plus every rejection |

Three rules fall out of that table and are worth stating on their own:

- **Done items appear in no default view.** There is no action to take on a
  finished item. Precisely: the Board's `Open` and `In progress` filter values
  exclude them, `Done` renders them in the Board's own four columns, and `All`
  includes them. `Done` is never the default and is not what the board opens
  on. That is enough to answer "did I already fix this?" without grepping the
  repo, and it costs one filter value rather than a fifth column.
- **The Status filter belongs to the Board.** Archive's contents are defined
  by staleness and rejection, not by status, so it carries no status filter of
  its own — only the project filter and search.
- **Tasks never archive.** A task is committed work: it was groomed, planned,
  and accepted. One rotting for six weeks is a fact you should be made to
  look at, not one the board should tidy away. A stale task keeps its place
  in the Tasks column and gains a `stale` marker instead.
- **Archive is not a graveyard.** Everything in it can come back, and the two
  paths back are different (below).

### Staleness

An item is stale when its `updated:` stamp is older than the window (default
30 days; a client setting, since Board-versus-Archive is a view decision and
the server already returns the whole corpus for client-side narrowing).

`updated:` is written by `writeItemFile`, which is reached by `start` and
`stop` and deliberately **not** by `move`: `moveItem` is a `renameSync` that
never reads content, and that byte-for-byte guarantee is worth more than a
stamp it would have to become a read-modify-write to add. Coverage survives
anyway, from two directions. Groom edits item bodies with the Edit tool
rather than through the CLI, but every groom and every execute session
brackets its work with `start` … `stop`, so the stamp lands on the way out
regardless of who wrote the body — and every skill path that calls `move`
calls `stop` immediately before it. A raw hand-edit
with no `start`/`stop` is missed, and that failure is safe — the item drifts
to Archive and a single groom brings it back.

Items with no `updated:` key fall back to `created`. Every file on disk today
is in that state, so the first load after this ships will move genuinely old,
never-touched items into Archive. That is the correct answer rather than a
migration accident, but it will look abrupt and should be called out in the
release note.

### Promotion out of Archive

Two mechanics, because the two populations differ:

- **A stale open item** is promoted by dispatching a groom session against
  it. Groom's own `start`/`stop` refreshes `updated:`, and the item is on the
  Board at the next load. No new write path: the board still never writes,
  the spawned agent does. Requiring a groom to bring something back is a
  feature — six weeks of silence is reason enough to look again.
- **An out-of-scope item** is promoted by capturing a **new** item that cites
  it (`from: oos-N`), exactly as idea → task promotion already works. The
  original stays in `out-of-scope/`. `moveItem` refuses every move out of
  out-of-scope, deliberately and with a comment defending it; this design
  does not lift that. The rejection record is the point, and a new id is a
  small price for keeping it.

### Refactoring

A new peer section, not a facet on ideas. The distinction the user drew and
this design adopts: **ideas are new** (a feature, an optimisation);
**refactors are existing things that should be improved** — not new, not
broken, so neither an idea nor a bug.

- directory `refactors/`, id prefix `ref` — short because the card's meta
  line is nowrap-with-ellipsis in roughly 118px at real column width, and
  `refactor-12` does not fit beside a date there.
- `kind: chore | debt` in frontmatter, rendered as a sub-badge. A third kind
  later is one enum value, not a new directory.
- Lifecycle matches ideas exactly: `open/` → `done/`, promotable to a task,
  rejectable to out-of-scope. `groomed` is `null` for refactors, as it is for
  ideas — groomed is not a state they have; being promoted is.

### Time and phase

`start` already refuses a second `start` while `started:` is set, so "one
actor at a time" is enforced today. What is missing is *which* actor, so
`stop` cannot bill the right bucket.

- `start <id> --as groom|execute` writes `started:` **and** `phase:`.
- `stop <id>` reads `phase:`, computes elapsed seconds, adds them into
  `groom-elapsed:` or `execute-elapsed:` (integer seconds, accumulated across
  sessions), then removes `phase:` and stamps `updated:` — and removes
  `started:` too, unless the caller passes `--keep-started`, which
  `backlog-execute`'s successful archive uses so a done item still records
  when the work began.

`phase:` is not a status and does not weaken the `status:` ban. A status
would say where the item is in its lifecycle — that remains the directory,
and only the directory. `phase:` says which activity currently holds the
in-progress marker, and it exists only while that marker does: `stop` removes
both together. It also earns its place in the UI, where the live bar can say
*grooming* rather than the ambiguous *in progress*.

Storing seconds rather than a human duration keeps accumulation trivial and
sorting honest; formatting is the client's job, as it already is for
`started`.

### Deliberately deferred

- **`finished:`** — it existed in an earlier draft only to date-cut done
  items for Archive. Done items now appear nowhere, so nothing needs it until
  statistics do. Deferring it also preserves `moveItem`'s byte-for-byte
  guarantee: it renames and never reads content, and stamping a completion
  date would make it a read-modify-write.
- **Tokens per item.** Feasible and investigated, not scheduled. Findings, so
  the eventual groom does not have to rediscover them: the session transcript
  at `~/.claude/projects/<slug>/<session>.jsonl` carries per-message `usage`
  (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens`) with timestamps, so a `started`→`stop` window sums cleanly;
  no environment variable hands a skill its own transcript path, but a
  `SessionStart` hook receives `transcript_path` and this plugin ships no
  hooks yet; the unavoidable caveat is that the sum bills the *whole session*
  in that window, not the item alone. Delegating this to
  claude-agents-dashboard was considered and rejected: manual
  `/backlog-groom` runs never reach the dashboard and `BM_AGENTS` defaults
  off, so the dataset would be silently biased toward whatever happened to be
  dispatched — worse than none for statistics.
- **Prune of done items.** File deletion, so it needs its own design. The
  sane shape rolls each pruned item into a statistics line before removing
  the file; that ordering makes it a Stats-chunk problem, not a cleanup one.
- **Priority, grouping, and a low-priority `later` section.** Cut. Priority is
  a judgement no signal on disk supplies, grouping duplicates the project
  filter, and `later` collides with the store directory's own name.
- **Renaming `tasks` to `tickets`.** Unnecessary once the nav says Board:
  the collision it solved no longer exists.

## Chunks

Independent units of work, each shippable alone.

| # | Chunk | Touches | Depends on |
|---|---|---|---|
| A | Nav: `Projects` → `Board`, add `Archive` slot | client | — |
| B | `refactors/` section end to end | skills · shared · server · client | — |
| C1 | Board column reorder, evict out-of-scope | client | B |
| C2 | Board/Archive split on staleness, `stale` marker | client | E |
| D | Archive view: four columns, promotion affordances | client | A · C2 |
| E | `--as`, `phase:`, elapsed buckets, `updated:` | backlog.mjs · skills · client | — |
| F | File the deferred work as backlog items | this repo's `backlog/` | — |

Suggested order: **E → B → A → C1 → C2 → D**, with F at any point. E is the
gate that matters: `updated:` is what C2 and D both read.

## Testing

Per the repo's conventions — jest for server and client, node's own runner for
skill tools.

- **E**: `start --as` round-trips `phase:`; `stop` accumulates into the right
  bucket across two sessions; `stop` on a `phase`-less file (written by an
  older build) still clears `started:` without billing; `updated:` lands on
  every `writeItemFile` path; unknown keys and the body survive byte-for-byte.
- **B**: `SECTIONS`/`LEAF_DIRS`/`PREFIX_TO_SECTION` agree; `ref-N` ids mint and
  resolve; `kind:` round-trips; a refactor's `groomed` is `null`; the server's
  allowlist reaches `refactors/`.
- **C2**: an item one second inside the window is on the Board and one second
  outside it is in Archive; a stale task stays on the Board and carries the
  marker; an item with no `updated:` falls back to `created`.
- **D**: out-of-scope renders only in Archive; a done item renders in neither
  surface's columns but is reachable through the Status filter.

## Open questions

None blocking. The staleness window's default of 30 days is a guess worth
revisiting once the Archive has real contents.
