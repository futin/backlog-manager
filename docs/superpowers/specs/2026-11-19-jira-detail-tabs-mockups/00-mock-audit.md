# Mock audit — Jira Detail tabs

The mocks in this folder are copies of the Design-canvas artifact "Jira Detail" (<https://claude.ai/artifact/DPpfcBD3A4RDu1dq83fcjt>, Version 6). Where a
mock and [the spec](../2026-11-19-jira-detail-tabs-design.md) differ, the spec wins. Every such place:

| Mock | Where | Mock draws | Spec says |
| ---- | ----- | ---------- | --------- |
| Main | tab row | — | tab names Ticket · Delivery · Agent · Children & comments (the mock's generator once said Development; Version 6 says Delivery) |
| Main | target row, draft | Pipeline step green, pill `draft · pipeline passed` | a draft's Pipeline stays `off` and its chip `draft` — `deliveryLook`'s rule (§4.5) |
| Main | target row, Review | `▶ Review ▾` with a menu of review skills | today's CodeRabbit play-button split only; the menu is the review-skills spec (§4.4) |
| Main | facts (Ticket tab) | Status with `Move to` in the Details list, `Resolved` row | Status, Assignee, Sprint, Parent are the strip's only; no `Resolved` (§1.4, §3) |
| Main | strip | no `Assign to me` | `Assign to me` beside the assignee, today's rules (§1.2) |
| Main | top bar | `← Board` | `← <origin>` — the page that opened it (§2.3) |
| Main | Worktrees fold | shows `clean` per row | today's `JiraWorktreeRow` (branch, path, repo, `Remove`) |
| B-Modal | live card | `Review the MR · Claude code review`, model `opus high` | today's `JiraSessionCard` content without Stop (§5.1); the review-skills label is that spec's |
| B-Modal | head | `Open full page ↗`, `Jira ↗`, `Run ▾`, close | same, `Open in Jira ↗` wording kept (§7.1) |
| Review-Skills | whole board | Settings › Jira › Skills with Run/Review groups | not this spec |
