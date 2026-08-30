---
id: idea-1
title: Record tokens spent per item, per phase
created: 2026-08-30
tags: skills, stats
---

## Problem

Elapsed time (task-1) says how long an item took in wall clock. It says
nothing about how hard it was. A rough token count per groom and per execute
would give a second, independent read on complexity, and would be the more
interesting axis once a statistics view exists.

Deferred from docs/superpowers/specs/2026-08-30-board-growth-design.md rather
than dropped: it is feasible, and the investigation is written down below so
grooming this does not have to rediscover it.

## Rough shape

Findings from the spike:

- The session transcript at `~/.claude/projects/<slug>/<session-id>.jsonl`
  carries a `usage` object on every assistant message — `input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` —
  each with a timestamp. Summing over the `started:` → now window is
  straightforward, and task-1 already establishes exactly that window.
- No environment variable hands a skill its own transcript path.
  `CLAUDE_CODE_HOST_SESSION_ID` exists but does not match the transcript's
  session id.
- A `SessionStart` hook *does* receive `transcript_path`. This repo is a
  plugin and ships no hooks yet, so adding `hooks/hooks.json` would be its
  first — the hook writes the path somewhere `stop` can read it.
- The unavoidable caveat: the sum bills the **whole session** inside that
  window, not the item alone. Groom item 3, then chat about something else in
  the same session, and the chat is counted. Fine for "roughly how hard was
  this", wrong for anything claiming precision.

Storage would mirror task-1's buckets: `groom-tokens:` and `execute-tokens:`,
integers, accumulated. Frontmatter is a flat scalar line splitter, so no
nested breakdown — one number per phase.

Rejected alternative, recorded so it is not re-proposed: sourcing this from
claude-agents-dashboard. It already tracks sessions and has hook config, but
items get groomed by running `/backlog-groom` in a plain terminal and the
dashboard never sees those sessions — and `BM_AGENTS` defaults to off. The
result would be a dataset silently biased toward whatever happened to be
dispatched, which is worse than no dataset for statistics. It would also
invert a dependency this repo deliberately avoids: shared/types.ts
re-declares `PermissionMode` rather than importing it, precisely so this repo
builds without the sibling checkout.

## Open questions

- Which number is the useful one — total, or output tokens alone? Cache reads
  dominate a raw sum and are the least related to difficulty.
- Is whole-session attribution good enough, or does this need the model to
  bracket its own work more tightly than `start`/`stop` already does?
- Should the hook be part of this plugin at all, given a hook is a new class
  of moving part for this repo?
