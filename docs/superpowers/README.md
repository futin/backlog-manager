# docs/superpowers

What the brainstorm → plan → review loop leaves behind, and which of it stays in the tree.

| Directory    | Kept?                     | Why                                                                                                     |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `specs/`     | yes                       | The _why_ behind the code: comments in `server/`, `client/`, `shared/`, `skills/` and `test/` cite spec sections. |
| `decisions/` | yes                       | Rulings made while a plan ran, and the CLAUDE.md fence audit `test/claude-rules.test.ts` cites.          |
| `plans/`     | only while in flight      | A plan is read by the session that executes it. Once its PR merges, the code, the spec and git hold it. |
| `reviews/`   | never (gitignored)        | Reviewer reports are spent the moment their findings are applied or ruled on.                          |

A plan or review that left the tree is still in git. Every one that existed on 2026-11-13 is readable at commit `fc1d5422`:

```bash
git show fc1d5422:docs/superpowers/plans/<file>.md
```

or on GitHub at `https://github.com/futin/backlog-manager/blob/fc1d5422/docs/superpowers/<plans|reviews>/<file>.md`. For a later one, `git log --all
--diff-filter=D -- 'docs/superpowers/plans/<file>.md'` names the commit that removed it; its parent still has it.

A spec that mentions a plan or review by path (in backticks, as a record of the moment it was written) is pointing at one of these — the path is not a
broken link to fix.
