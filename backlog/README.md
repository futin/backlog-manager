# Backlog

A lightweight, file-based backlog for this repo. Every item is a single
Markdown file living under one of the sections below. Bugs, ideas, tasks and
refactors move from open/ to done/ as they are worked; out-of-scope holds items
that were considered and declined, and has no open/done split of its own. Each
section has a fixed id prefix used when naming its items.

| Section       | Prefix | Lifecycle     |
|---------------|--------|---------------|
| bugs          | bug    | open -> done  |
| ideas         | idea   | open -> done  |
| tasks         | task   | open -> done  |
| refactors     | ref    | open -> done  |
| out-of-scope  | oos    | flat          |

Ideas are new; refactors are existing things that should be improved. A refactor
may also carry `kind: chore` or `kind: debt` in its frontmatter, saying which
of the two it is; any other value is preserved but means nothing to the board.

An item's status is the directory it lives in, never a frontmatter key. The one
exception is not a status: a `started: YYYY-MM-DD` line means someone is working
that item right now. It is still an open item in `<section>/open/`; the date only
says when it was picked up. Set it with `start <id>`, clear it with `stop <id>`.
Archiving keeps it, so a done item records when the work began. `start --as
groom` or `--as execute` also writes a `phase:` line alongside `started:`,
naming which of the two `stop` bills the elapsed time to. `stop` always
clears `started:` and `phase:` together, and adds the seconds in between to
`groom-elapsed:` or `execute-elapsed:` — one running total per phase, kept
separate because grooming and executing are different work. It adds the tokens
that session spent over the same interval to `groom-tokens:` or
`execute-tokens:` alongside them: four totals, two per phase, saying how long
the work took and roughly how much model work it took. All four are never
cleared, only added to, session after session.
<!-- orchestration smoke test: task-25 -->
