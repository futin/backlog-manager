# Plan review 1 — recheck — `docs/superpowers/plans/2026-11-05-jira-rest-restyle.md` (plan 2 of 4)

Scope: only the lines e78d81e6 changed since review 1 (`docs/superpowers/reviews/2026-11-05-jira-rest-restyle-review-1.md`), read against the spec
(`docs/superpowers/specs/2026-11-05-app-restyle-design.md`), plan 1, the unchanged parts of this plan and the code at `main` (post-#472, b3c73fa5).
Every code claim below was grepped, not taken from the plan.

## Verdict: APPROVE WITH FIXES

All seven round-1 Important findings are resolved by the changed lines, and every code fact in them is true, with one exception: the new #472 line-shift
map (plan :22-23) is wrong in seven of its eight entries. One Important, seven Minor. No Critical.

## Round-1 findings, one by one

| Finding | Plan lines changed | Resolved? | Verified against |
| --- | --- | --- | --- |
| I-1 `Working · 2m` → `2h` | :187 | Yes | `test/jira-board.test.tsx:1293-1297` (`hoursAgo(h)`, `linkOn(..., h)` hours); `client/src/lib/tracker.ts:37-44` `pollAge` → `elapsedSince` |
| I-2 `develop (default)` → `main (default)` | :296 | Yes | `test/jira-setup.test.tsx:167` `defaultBase: 'main'`; `:773` `repoDefaults … base: 'develop'` is the stored value |
| I-3 once-per-path rule for the toggle and fields | :285-287 | Yes | `client/src/components/jira/JiraReposGroup.tsx:71` `shownDefaults = new Set`, `:144` `if (shownDefaults.has(p)) return [row]`; `test/jira-setup.test.tsx:899-928` maps `/home/ada/pay` under PAY and OPS and expects ONE `.jira-setup-trees` |
| I-4 Repository Segmented starts unpicked | :239-240 | Yes | `client/src/components/jira/JiraLaunchSheet.tsx:340` `{ value: '', label: 'choose…' }`; `test/jira-launch.test.tsx:246` (two paths, `pay` / `pay-web`, none picked) |
| I-5 scope loop deleted, `:978-1019` | :273 | Yes | `test/jira-setup.test.tsx:978-988`, loop at `:985`; scopes are a hint string today (`JiraConnectionGroup.tsx:46`), not served — `shared/types.ts:744` has only `JiraTokenKind`; spec :115 |
| I-6 `Meter` height | :117-119, :141-142 | Yes | `client/src/components/ui/Meter.tsx:23-36` has `label, value, fraction, tone, width`, no height; `.ui-meter-track { height: 3.5px }` at `styles.css:3538`; `grep -l "ui/Meter" test/` → `test/ui-meter.test.tsx`, `test/tracker-chip.test.tsx` |
| I-7 busy `href` half | :122-123 | Yes | plan 1 :61 `disabled?: boolean` (both halves) on two `<button>`s |
| M-7 space before the count span | :85 | Yes | `client/src/components/jira/JiraSessionList.tsx:109` `{CHIP_LABEL[c]} <span className="jira-list-count">` |
| M-1 stale line numbers | :22-23 | **No** — the new map is itself wrong (I-1 below) | see below |

## Checklist on the changed lines

- **Values match the spec** — `<site> · <tokenKind>` only (spec :115); `(default)` placeholder; `Start session` gate unchanged. ✓
- **Reality** — every path exists: `Meter.tsx`, `JiraSessionList.tsx:109`, `JiraLaunchSheet.tsx:340`, `JiraReposGroup.tsx:71,144`, `jira-setup.test.tsx:167`,
  `:773`, `:899-926`, `:978-1019`, `:985`, `jira-launch.test.tsx:246`. ✓ (The #472 map at :22-23 is the exception — I-1.)
- **Interfaces spelled identically** — `height?: 4` / `data-height="4"` is spelled the same at :117 (Files), :119 (Test) and :141 (behaviour); `href` /
  `variant` unchanged from :121. ✓
- **Guard 7** (`test/design-guards.test.ts:380-396`, block bounds `:347-359`) — the plan now puts the 4 px rule on `.ui-meter[data-height="4"]` inside the
  block and names the page-side `.jira-deck-ctx .ui-meter` as what the guard forbids; correct (every class token in a selector is checked, `:389-392`). ✓
- **Tests pin behaviour** — the two new behaviours (busy `href` half → `<button disabled>`; Segmented with no option pressed) have no Step-1 case (M-3, M-4).
- **Plan's own convention** — behaviour and cases, no literal code ✓; 160-column prose ✗ on eight of the changed lines (M-1).
- **Contradiction with unchanged lines** — :273 now says `:978-1019`, while the Task 8 Files line at :268 still says `test/jira-setup.test.tsx:982-1025` (M-2).

## Important

- **I-1** plan:22-23 — the #472 shift map, added to answer M-1, is wrong in seven of eight entries against `test/jira-board.test.tsx` at b3c73fa5: the List
  cases moved 28 lines, not 29 (`:1330` → `:1358` — the `—` lookup — not `:1355`, which is `Ada Lovelace`; `:1344` → `:1372`; `:1345` → `:1373`;
  `:1352` → `:1380`); the deck cases moved 27 (`:783-786` → `:810-813`, not `:804-815`; `:802` → `:829`, not `:830`); and `:979` (the modal's
  `Stop session` click) is at `:1007`, not `:981`, which is a comment. Only `jira-lib.test.ts:1593-1615` → `:1621-1644` is right. → Replace with the
  numbers above (or drop the numbers and keep only "List cases ~28 lower, deck cases ~27 lower, re-grep by case name").

## Minor

- **M-1** plan:85 (224 cols), :117 (210), :141 (232), :187 (218), :239 (174), :240 (190), :273 (288), :296 (210) — each changed line overruns the plan's own
  160-column rule (:28, and the global convention). Reflow the eight lines.
- **M-2** plan:273 vs :268 — the changed Step 1 cites `:978-1019`; the unchanged Task 8 Files line still cites `test/jira-setup.test.tsx:982-1025`. Make :268
  `:975-1026` (the whole `the Connection card` describe) or `:978-1019` to match.
- **M-3** plan:122-123 — the new "while `disabled`, an `href` main half renders as `<button disabled>` (no `href`)" has no case in T4 Step 1 (:147 covers
  only `href` → link). Add: `href` + `disabled` → main half is a disabled button, no link in the group.
- **M-4** plan:239-240 — "the Segmented starts with NO option pressed" has no case in T7 Step 1 (:245-249); `:246` pins the gate, not the control. Add: with
  two paths mapped and nothing picked, no Repository option has `aria-pressed="true"`. Also say that `:248`'s `combobox` lookup becomes the Segmented
  group (the "~13 lookups move" sentence at :245 covers it only implicitly for this case).
- **M-5** plan:187 — mixed line-number eras in one sentence: `:1344` is pre-#472 while "`hoursAgo(h)` at :1294-1297" is post-#472 (`hoursAgo` is `:1293`,
  `linkOn` `:1294-1297`; pre-#472 they were `:1265-1269`). Pick one era, or cite by name only.
- **M-6** plan:296 — two consecutive parentheticals ("… (`refsAnswer.defaultBase` :167; `develop` is the stored value) (`(default)` without)") read as one
  nested one; "… with the fixture refs — `refsAnswer.defaultBase` :167, `develop` at :773 is the stored value — and `(default)` without refs".
- **M-7** plan:119 — "the `Meter` suite (`grep -l "ui/Meter" test/` …)" resolves to two suites, `test/ui-meter.test.tsx` and `test/tracker-chip.test.tsx`; the
  new case belongs in `ui-meter.test.tsx`, and `tracker-chip` only needs a run. Name them so the implementer does not add the case to both.
