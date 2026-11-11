# Jira: run a sub-task's parent from the sub-task — design

Status: draft, 2026-11-11. Mocks: [`2026-11-11-jira-run-on-parent-mockups/`](2026-11-11-jira-run-on-parent-mockups/) — prototyped over the live Detail of
TIMIFY-28028 (`prototype.cjs` is the injection that drew them).

## 1. Intent

The user's team assigns work as **sub-tasks**, but the **parent story owns the branch**: every sub-task of TIMIFY-27763 is worked on TIMIFY-27763's branch.
Today the board makes that awkward. The sub-task's Detail shows its parent only as plain text (`in TIMIFY-27763 …` in the head, and the `Parent` fact), and the
parent is usually on none of the user's boards — their boards pull their own assigned sub-tasks, so TIMIFY-27763 has `boards: []` (checked against the live API).
There is no way to open the parent's Detail and press Run there. The only route is to Run the sub-task and pick the parent's branch with `Continue`, which the
launch sheet accepts as **off-ticket** (`continueOffTicket`, `JiraBranchSection.tsx`): a session filed under TIMIFY-28028 working on TIMIFY-27763's branch,
whose worktree does not show on either card. The user rejected that path explicitly: "it creates confusion".

What they want: from the sub-task, get to the **parent** and start the parent's own session — the parent's card, branch, worktree and link — with the
sub-task as nothing more than the doorway.

## 2. Goals, non-goals, anti-goals

Goals
- From a sub-task's Detail, open the parent's Detail in one click, with a way back to the sub-task.
- From a sub-task's `Run ▾`, start any action (built-ins and skills) **on the parent** without first opening it.
- See from the sub-task when the parent already has a live session, and reach it.

Non-goals
- No change to what a session on the parent does: it works the **whole parent story**, the same prompt, branch rules and link as pressing Run on the parent
  (user's answer). The sub-task is not mentioned in the parent's prompt.
- No server change. No new route, no new branch rule, no new setting. Everything needed already exists: `GET /api/jira/issue/:key`, the launch sheet,
  `runChipState`, the sessions payload.
- No "custom branch name for a different issue" mode. The existing off-ticket `Continue` stays exactly as it is; it is not removed and not promoted.
- Not for stories under an epic, or any issue whose parent is not the branch owner: the toggle appears on sub-tasks only (§4.2).

Anti-goals — it fails even if it works when:
- a session started through the toggle lands on the sub-task's card, link, or the sub-task's `{key}-{slug}` branch default — the whole point is that it is
  the parent's;
- the parent's one-run gate can be bypassed from the sub-task (two `run` sessions on TIMIFY-27763 because one was started from a sub-task);
- the sub-task's own Run gets harder: its left `Run` half, its menu rows and its default keep working exactly as today.

## 3. Decided by the user

1. The agent works the **whole parent story** (not the sub-task's scope on the parent's branch, and not a sub-task session pinned to the parent's branch).
2. **Both doorways**: the parent crumb becomes a link to the parent's Detail, AND the sub-task's `Run ▾` can run the parent directly.
3. The menu shape is **B — a `Run on` toggle** at the top of the menu (`run-on-toggle.png`); A, a `Parent · KEY` section of duplicated rows at the menu's
   foot (`rejected-parent-section.png`), was rejected.
4. The toggle **defaults to the sub-task every time the menu opens**, and the left `Run` half always runs the sub-task's default — the toggle lives only inside
   the menu.
5. **Keep** the parent-live line in the sub-task's Agent band (`parent-live-line.png`).

## 4. Behaviour

### 4.1 Doorway 1 — the parent is a link

In a sub-task's — and any issue's with a non-null `parent` — Detail:
- the head crumb `in <PARENT-KEY> <summary>` renders the key-and-summary part as a link (the look of the comments note's `<KEY> in Jira ↗` link, without the
  arrow: it navigates inside the board, not out to Jira);
- the `Parent` fact's value is the same link.

A click swaps the open Detail to the parent the way a Children row does: it **pushes** onto `JiraView`'s walk (`openChild`), so the head then offers
`← <SUB-TASK-KEY>` and Escape/close behave as for a child. The board's `childrenOf` snapshot is carried forward unchanged.

The walk holds a `JiraIssue`, and the sub-task only knows `{ key, summary }` of its parent. The parent is read with `GET /api/jira/issue/:key` (its answer is a
`JiraIssueDetail`, which is a `JiraIssue`). While that read is out the link is inert (no second read on a double click) and marked busy; a failure is shown in
the Detail's existing `role="alert"` line under the ticket's write row, with `failureOf`'s sentence, and the Detail stays on the sub-task. A parent already
held in a loaded board's cache may be used instead of the read — builder's call (§7).

This applies to every issue with a parent (a story's epic link too): a link to the parent is harmless everywhere and plain text was the gap.

### 4.2 Doorway 2 — `Run on` in the sub-task's menu

`JiraRunMenu` draws a `Run on` segmented control as the menu's first block when **`issue.type.subtask` is true and `issue.parent` is non-null**. Two
segments, each a key over a sub-line: `<SUB-TASK-KEY>` / `this sub-task`, and `<PARENT-KEY>` / `parent <type>` (`parent story` when the parent's type is
Story; the type name lower-cased otherwise; `parent` alone until the parent's type is known). Mock: `run-on-toggle.png`.

- Opening the menu always starts on the sub-task segment (§3.4). Closing and reopening resets it.
- With the sub-task picked, the menu is exactly today's.
- With the parent picked, every row — `Built in` and `Skills on this machine` — acts on the parent: a pick calls `onPick` with the **parent's `JiraIssue`**,
  so the launch sheet opens as the parent's (its title, its project's repos, its `{key}-{slug}` branch default, its link). This needs `onPick` (and
  `onRun` above it) to carry the issue, not only the action, wherever the menu currently closes over its own `issue`. The default row's sub-line names the
  target (`Work TIMIFY-27763 end to end`, as mocked); the `default` mark stays on the same row.
- Picking the parent segment reads the parent (§4.1's read, shared — one read per parent key per open Detail/menu, not one per click). Until it lands the
  rows are disabled with the title `loading TIMIFY-27763…`; a failed read disables them with the failure sentence as the title and in a one-line note under
  the toggle.
- The parent's gate is the parent's: `runChipState(parent, status, sessions)`. `live` disables every row, titled `a session is running on <PARENT-KEY>`;
  `no-repo` disables every row, titled as today's no-repo title for the parent's project. The sub-task's own gate does not apply to parent rows, and the
  parent's does not apply to sub-task rows.
- The toggle is drawn in both homes of `JiraRunMenu` (the card and the Detail): the component is one control on purpose (its header), and a sub-task card's
  menu is the shortest route. On a card the parent read happens only when the parent segment is picked — a board of sub-tasks must not fan out N reads.
- The whole split is disabled only by the sub-task's own `live` / `no-repo` state as today. Known consequence, accepted: while the sub-task itself has a live
  `run`, its menu cannot open, so the parent is reached through Doorway 1 instead.

### 4.3 The parent-live line

In a sub-task's Detail Agent band, when the sessions payload holds a live session on the parent key, draw one line under the band's sub-line:
`Parent <PARENT-KEY> · <state> · <elapsed> · <repo basename> →` (`parent-live-line.png`). It reuses `ChildSessionLine`'s look and tone dot — the
mirror of the existing "a child is underway" line on a parent. A click is Doorway 1 (open the parent's Detail). The sessions payload already carries every
key's links, so this line needs no parent read; it is drawn whether or not the parent is on a board. With several live sessions on the parent, show the
newest and `+N`, as `ChildSessionLine` does.

## 5. Constraints

- Server untouched; every Jira read through the existing route. Item files untouched (Jira is not the backlog store).
- `.claude/rules/board.md` governs `client/src/**` — read it before editing. CSP: the toggle's styles go in `styles.css` classes, never inline `style=`
  markup (the prototype's inline styles are a drawing aid only).
- `.claude/DESIGN.md` §8.9.1/§8.9.2 describe the Run menu and the Detail head; update them in the same change (the toggle is a new primitive use in the
  menu; the crumb and fact gain a link).
- One-write-at-a-time (`useAction`) in Detail is for writes; the parent read is a read and must not take that guard — a Move or Assign may be out while the
  parent loads.
- The key-swap rule in Detail (`keyRef`): a parent read that lands after the reader swapped to another issue is dropped, never pushed onto the walk.

## 6. Test expectations (cases, not code)

Jest, flat in `test/`, against the components and `lib/jira.ts` helpers:
1. Detail of a sub-task with `parent: { key: 'P-1', summary: 'S' }`: the head crumb and the `Parent` fact each render a link; clicking it reads
   `/api/jira/issue/P-1` once (a double click still once) and pushes the returned issue onto the walk (`onOpenIssue` called with it).
2. Same, read fails 500 `{ error: 'boom' }`: alert line reads `boom`, `onOpenIssue` not called.
3. Detail of an issue with `parent: null`: no link, no toggle.
4. `JiraRunMenu` on a non-sub-task with a parent (a story under an epic): no `Run on` control.
5. On a sub-task: menu opens on the sub-task segment; picking a row calls `onPick(subtask, action)` — today's behaviour.
6. Parent segment picked, parent read pending: rows disabled, title `loading P-1…`; read lands → picking `Work it end to end` calls `onPick(parentIssue,
   'execute')`; a skill row calls `onPick(parentIssue, { skill })`.
7. Parent segment, parent has a live `run` link in the sessions payload: every row disabled, titled `a session is running on P-1`; sub-task segment rows
   still enabled.
8. Parent segment, parent's project has no mapped repo: rows disabled with the no-repo title.
9. Close and reopen the menu: back on the sub-task segment.
10. On a card: no read until the parent segment is picked.
11. Parent-live line: sessions payload with a live session on `P-1` → the line shows key, state, repo basename; click → Doorway 1. No live session → no line.
12. Launch sheet opened through the parent segment has the parent's key in its title and `P-1-<slug>` as the new-branch default.

Before pushing, `grep -l` each symbol whose callers the diff adds (`JiraRunMenu`, `onRun`, `useJiraSessionsContext`, …) in `test/` and run every hit
(project CLAUDE.md). The last task is `/ui-verify` against the two picked mocks at 1440 px, daylight theme.

## 7. Calls I made (the user can overturn any)

- Toggle only on `type.subtask` issues; the link (Doorway 1) on every issue with a parent.
- Toggle in both homes (card and Detail); lazy parent read on a card.
- Parent read on demand through the existing route; reusing a board-cache hit instead is the builder's choice.
- The parent-live line shows only LIVE parent sessions, not ended history.
- The off-ticket `Continue` path is left as is.
- After a Start through the parent segment, the sub-task's Detail stays where it is (the sheet closes over it, the walk is not touched); the parent-live line
  (§4.3) then appears in its Agent band once the sessions payload reloads — `landed()` in `JiraView` already re-asks it.
- The parent's gate and no-repo title come from the **read parent's own `project`** (the read result), never the sub-task's: a parent may sit in another
  project, and `runChipState` already keys the repo mapping by `issue.project.key`.
- The parent read is one client-side, in-memory read per parent key shared by every home (card menu, Detail crumb, Detail menu, parent-live line): a
  pending read is joined, not repeated; a landed one is reused while the Detail or menu that asked is open; nothing is persisted. A card's menu with no
  Detail behind it uses the same read. The crumb, the `Parent` fact and the parent-live line share one busy state.
- Doorway 1 from the parent-live line carries the same `childrenOf` snapshot as the crumb (the board's, unchanged), even though the parent is not in it —
  the parent's Children tree then draws its direct children only, which is today's behaviour for an issue the snapshot lacks.

## 8. Left to the builder

- Where the shared parent read lives (a small hook keyed by parent key, or state in `JiraView`), as long as §4.2's "one read per parent per open" holds.
- Exact class names and the segmented control's markup — reuse an existing segmented primitive if `ui/` has one (the Board/List switch is one candidate).
- Whether `onPick`'s new signature is `(issue, action)` or the menu takes a `target` prop; the launch sheet must receive the parent `JiraIssue` either way.
