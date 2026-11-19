# Mock audit — Jira Detail tabs

The mocks in this folder are copies of the Design-canvas artifact "Jira Detail" (<https://claude.ai/artifact/DPpfcBD3A4RDu1dq83fcjt>, Version 9). Where a
mock and [the spec](../2026-11-19-jira-detail-tabs-design.md) differ, the spec wins. Every such place:

| Mock | Where | Mock draws | Spec says |
| ---- | ----- | ---------- | --------- |
| Main | tab row | — | tab names Ticket · Delivery · Agent · Children & comments (the mock's generator once said Development; Version 6 says Delivery) |
| Main | target row, draft | Pipeline step green, pill `draft · pipeline passed`, Review grey `skipped` | a draft's Pipeline stays `off`; `skipped` is replaced by the next-step ring (§4.5, `States.dc.html`) |
| Main | target row, Review | `▶ Review ▾` with a menu of review skills | today's review play-button split only; the menu is the review-skills spec (§4.4) |
| Main | facts (Ticket tab) | Status with `Move to` in the Details list, `Resolved` row | Status, Assignee, Sprint, Parent are the strip's only; `Resolved <date>` drawn from `JiraIssue.resolved` when set (§1.4, §3) |
| Main | strip | no `Assign to me` | `Assign to me` beside the assignee, today's rules (§1.2) |
| Main | top bar | `← Board` | `← <origin>` — the page that opened it (§2.3) |
| Main | Worktrees fold | shows `clean` per row | today's `JiraWorktreeRow` (branch, path, repo, `Remove`) |
| B-Modal | live card | `Review the MR · Claude code review`, model `opus high` | today's `JiraSessionCard` content without Stop (§5.1); the review-skills label is that spec's |
| B-Modal | head | `Open full page ↗`, `Jira ↗`, `Run ▾`, close | same, `Open in Jira ↗` wording kept (§7.1) |
| Review-Skills | whole board | Settings › Jira › Skills with Run/Review groups | not this spec |
| States | rows 5, 16, 17 and the two expanded panes | `Open session` on findings; `Ignore` after a Review/Pipeline row button; rows 16–17 ignored; `ignored` word on the step | as drawn (§4.5 row 5, §4.5.1); the small "no live review session: review split, fix half" line under `Open session` is the spec's fallback, not a second button |
| all | review copy | no product name: `Review ·`, `review bot` | as drawn (§4.7) |
| Main, B-Modal | compact target row | review word beside the pill (`not reviewed`), no button | as drawn: the summary line only folds; the button is the expanded pane's next row (§4.2, §4.5) |
| Main | head line | the "open full page" hint under the title | not drawn: the hint is each surface's `title` (§2.3) |
| States | ringed step label | `next` under the ringed dot | `next · <word>` when the row has a Next word, else `next` (§4.5) |
| Main | strip Agent cell | one live pill | lead live session by attention order, then `+N` (§1.2) |
| B-Modal | Agent tab live card | `Review live · 4m` | today's session card label and age, as drawn (§5.1) |
| Main | Children & comments | comments copy in the fold | today's `Comments stay in Jira …` line instead (§5.2) |
| States | row 15 (clean draft) | `GitLab ↗` | `next: mark ready`, sentence `Still a draft — mark it ready in GitLab.` (§4.5) |
