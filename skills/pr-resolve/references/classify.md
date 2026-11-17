# Mechanical or judgment — worked examples

Read in full by `pr-resolve` at step 5, before any hunk is resolved. Every conflicted hunk gets exactly one class. A **mechanical** hunk has one right
resolution that keeps everything both sides meant, and the session writes it. A **judgment** hunk needs a person to say which behaviour the code should have,
and **one judgment hunk aborts the whole resolve** — nothing is resolved, nothing is pushed, and the comment names every judgment hunk and why.

The test for every hunk: _after the resolution, does each side's change still do exactly what its author wrote it to do, with nothing of either side dropped or
reshaped?_ If the answer is yes and obviously so, it is mechanical. If it needs an argument, it is judgment. "It compiles and the tests pass" is not the test —
a merge that quietly drops one side's behaviour can do both, and it is the failure this skill exists to avoid.

`HEAD` below is the PR's head (ours), `origin/<base>` the base being merged in (theirs).

## Mechanical

### Both sides added independent entries to the same list, import block or registry

```
<<<<<<< HEAD
import { formatDate } from './dates';
import { readPull } from './pulls';
=======
import { formatDate } from './dates';
import { listReleases } from './releases';
>>>>>>> origin/main
```

Resolution: keep every entry from both sides, once each, in the file's own order (alphabetical here) — `formatDate`, `listReleases`, `readPull`. The same holds
for two new rows in a routes array, two new keys in a registry object, two new cases in a `switch` over unrelated values, two new lines in a `CHANGELOG` list.
It stops being mechanical the moment the two entries are not independent: the same key with two different values, two routes on the same path, two cases for the
same value — that is a choice between them (judgment).

### Non-overlapping edits git could not align

The head changed the function's guard clause; the base changed the log line three lines further down. git reports one hunk because the edits sit too close for
its context, but they touch different statements and neither reads what the other changed. Resolution: apply both edits. Check by reading the result against
each side's own diff (`git diff <merge-base> HEAD -- <file>` and `git diff <merge-base> origin/<base> -- <file>`): each side's lines must appear exactly as that
side wrote them.

### A rename on one side, an unrelated edit on the other

The base renamed `fetchItems` to `loadItems` everywhere; the head added a `limit` argument at one call site of `fetchItems`. Resolution: the head's edit, under
the base's new name — `loadItems(repo, { limit })`. A new call site the head added to the old name gets the new name too, or it would not compile. Mechanical
only while the rename is a pure rename: a base that renamed AND changed the signature or the behaviour makes the head's edit a question about the new function
(judgment).

### Formatting-only differences

One side reformatted the block (a wider print width, quotes, trailing commas, re-indented); the other changed a token inside it. Resolution: the other side's
token change, in the formatted shape — then run the project's formatter if it has one, so the result is exactly what it would produce. Mechanical only when one
side's change is provably formatting — the same tokens in the same order once whitespace and the formatter's choices are set aside.

### A lockfile or a generated file

`pnpm-lock.yaml` (or `package-lock.json`, `yarn.lock`) conflicts because both sides added a dependency. Resolution: never hand-merged. Resolve `package.json`
first — usually both sides' new entries, which is the list case above — then take either side's lockfile and regenerate it with the project's own install (step
5's lockfile case, which first replaces the `node_modules` symlink with the tree's own install). The same for a generated file — a schema dump, generated types,
a bundled client — regenerated with the generator the repo's own scripts name. A generator that cannot be found, or a regeneration that changes far more than
the two sides' inputs explain, makes the hunk one the session is not confident about (judgment). A `package.json` conflict that is not independent entries — the
same dependency at two different versions — is a version choice (judgment).

## Judgment

### Both sides changed the same logic

```
<<<<<<< HEAD
  if (pr.mergeable === 'CONFLICTING' && !pr.isCrossRepository) return 'resolve';
=======
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'resolve';
>>>>>>> origin/main
```

Each side changed the same condition for its own reason. Combining them (`(A || B) && !C`) is a new rule neither author wrote, and choosing one drops the
other's intent. Abort; the comment quotes both lines.

### A deletion on one side, an edit on the other

The base deleted `legacyPrStatus()` (its callers moved to `prStatus()`); the head fixed a bug inside `legacyPrStatus()`. Keeping the function revives code the
base removed on purpose; dropping it loses the head's fix, which may or may not also be needed in `prStatus()`. A file deleted on one side and modified on the
other (`deleted by them` / `deleted by us`) is the same case. Abort.

### A semantic choice between two behaviours

The head changed a timeout from 10 s to 30 s; the base changed it to 5 s. Or: the head made an error a warning, the base made it a hard failure. Both sides are
coherent and the result must pick one behaviour — which is a product decision, not a merge. Abort; the comment names both values.

### Not confident

Anything that does not fit a mechanical example above as obviously as the examples themselves do: a hunk whose intent on either side cannot be read from the
diff and its commit messages; a long hunk where the edits interleave; a test file where both sides changed the same expectation; a conflict in a migration or a
schema; a resolution that would need a new line neither side wrote (a new import, a changed argument) to make the two sides fit. Abort. A wrongly aborted
resolve costs a person one look at the PR; a wrongly guessed one ships a broken merge under a message that says it was proved.
