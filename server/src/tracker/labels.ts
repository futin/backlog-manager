/**
 * The eight labels a connected repo must carry (task-45, spec §5.2), and the
 * one home for that list.
 *
 * Four of them ARE the mapping: `section` is read off the one `type:*` label
 * an issue carries (spec §5.3), so an issue in a repo without them is untyped
 * by construction and every item lands in `ideas`. The other four are the
 * fields the file store keeps in frontmatter and a tracker has nowhere else to
 * put — a refactor's `kind:`, the orchestrator's `runner-fix:` marker, and the
 * `in-progress` flag phase 3's claim protocol sets.
 *
 * Created by the POLLER, the first time a repo syncs successfully and any is
 * missing, which is why `connect` needs no server and no network (spec §5.7):
 * the poller is the first thing that holds a token, and a `connect` that
 * created labels would need one too — a second place the credential lives.
 *
 * ## Why this list cannot simply be imported by `connect`
 *
 * `skills/backlog/tools/backlog.mjs` writes issue forms that pre-apply the
 * four `type:*` labels, so the two lists must agree. It cannot import this
 * file: a plugin skill's `tools/` is installed as a standalone copy of what
 * was pushed, with no build step and no path back into `server/`, and
 * CLAUDE.md forbids one skill's tools reaching into another's for the same
 * reason. So the agreement is enforced the other way round, mechanically:
 * `test/tracker-labels.test.ts` reads the skill's SOURCE and asserts the
 * `type:*` labels its forms apply are exactly the four named here. A test
 * rather than an import, because the boundary is real and a comment asking
 * two files to stay in step is what drifted in the first place.
 */

/** One label, as GitHub's create-label API wants it. Colours are the six-digit
 *  hex GitHub expects with no leading `#`; they are cosmetic, and chosen only
 *  so the four `type:*` labels read as a family in the web UI. */
export interface TrackerLabel {
  name: string;
  color: string;
  description: string;
}

/** The four labels that decide an item's section — one per store section that
 *  an issue can be filed into. `out-of-scope` is deliberately absent: it is a
 *  CLOSED state (`state_reason` other than `completed`), not a type, and the
 *  type label stays on a closed issue so the original type is recoverable. */
export const TYPE_LABELS = ['type:bug', 'type:idea', 'type:task', 'type:refactor'] as const;

/** The eight, in the order spec §5.2 lists them. */
export const TRACKER_LABELS: readonly TrackerLabel[] = [
  { name: 'type:bug', color: 'd73a4a', description: 'A defect — backlog section: bugs' },
  { name: 'type:idea', color: '0e8a16', description: 'Something new — backlog section: ideas' },
  { name: 'type:task', color: '1d76db', description: 'Planned work — backlog section: tasks' },
  { name: 'type:refactor', color: '5319e7', description: 'An existing thing to improve — backlog section: refactors' },
  { name: 'kind:chore', color: 'c5def5', description: "A refactor's flavour: tidying that carries no tracked risk" },
  { name: 'kind:debt', color: 'fbca04', description: "A refactor's flavour: a deliberate shortcut, now due" },
  { name: 'runner-fix', color: 'b60205', description: 'Executing this repairs machinery the orchestrator run itself depends on' },
  { name: 'in-progress', color: 'ededed', description: 'A session holds this item (set by the claim protocol)' }
];

/** The eight names alone — what the bootstrap compares the repo's existing
 *  labels against. Case-insensitive on purpose: GitHub label names are
 *  case-preserving but collide case-insensitively, so a repo that already has
 *  `Type:Bug` has the label, and creating it again is a 422. */
export const TRACKER_LABEL_NAMES: readonly string[] = TRACKER_LABELS.map((l) => l.name);
