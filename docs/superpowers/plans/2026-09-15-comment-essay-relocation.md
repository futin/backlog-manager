# Relocating the design essays out of four hot files

Provenance: chosen 2026-09-15 after measuring that 93% of this tree's comment reasoning (4,439 sentences, 7-word shingles) appears nowhere in `docs/`, which
killed the "replace comments with docs" option outright. What survived that measurement is a much narrower claim: four files carry design _essays_ rather than
local _why_, they sit on the hottest read path in the repo, and the essay half has a home that already exists.

## The problem this solves, stated as a number

| File                              | Comment lines | Share of file | ~tokens of comment |
| --------------------------------- | ------------- | ------------- | ------------------ |
| `shared/types.ts`                 | 951 / 1171    | 81%           | ~14,200            |
| `client/src/lib/run-stats.ts`     | 658 / 849     | 77%           | ~10,500            |
| `shared/agent.ts`                 | 518 / 639     | 81%           | ~7,600             |
| `client/src/lib/run-authority.ts` | 88 / 94       | 93%           | ~900               |

`shared/types.ts` and `shared/agent.ts` are imported by both halves of the app, so every `codegraph_explore` that touches a shared type pays for the prose
whether the question was about that prose or not. This is the cost the move is being made against — it is not a tidiness exercise, and nothing here is being
deleted.

## The rule that decides each block

A block MOVES when it is any of:

- **Historical narrative** — what a previous version of this code did, and why it stopped doing it. `run-stats.ts`'s `itemWallMs` paragraph is the type
  specimen: it describes code that no longer exists, in a file whose readers are editing the code that replaced it.
- **A rejected alternative** — a design the spec or a review considered and turned down. Valuable, and valuable to someone reading the design, not someone
  reading the function.
- **Cross-file rationale** — reasoning whose subject is the relationship between two or more modules rather than the lines underneath it.
- **An admitted restatement** — any paragraph that says in its own words that it is repeating another file. `run-stats.ts`'s KNOWN BLUR opens with "carried over
  from `RunQueueItem.stageAt`'s own doc comment and restated here", which is a duplicate the author flagged and we should collapse.

A block STAYS when it explains why THIS line, parameter or branch is the way it is — the reader who needs it is the one editing the line, and no pointer reaches
them reliably. `runStageTotals`'s "`status` is a REQUIRED field, not optional with a default" is the type specimen for staying: delete it and a future caller
adds the default.

Anything that stays is capped at roughly 8 lines and ends with a `docs/subsystems/invariants.md#anchor` pointer to the moved essay.

## Destinations

No new doc is created. Every essay lands in `docs/subsystems/invariants.md` under the anchor that already discusses its subject — the file already names
`runClaimBlock`, `aggregateRuns`, `runStageTotals`, `MACHINE_STAGES` and `pickAuthority`'s tiers across 15 places, so the seams exist and are the reason this
option was chosen over inventing a fifth subsystem doc. Where an essay has no existing anchor, it is appended to the nearest section and the section's heading
is left alone, so no CLAUDE.md link and no `.claude/rules/` pointer goes stale.

## Verification, which is the part that actually matters

A docs move can silently lose prose, and prose loss is invisible to every test in this repo. Three mechanical guards, all of which must pass before the commit:

1. **Pre-measure the overlap.** Before moving a block, shingle it against `invariants.md` exactly as the 93% measurement was taken. A block that already
   overlaps heavily is a collapse, not a move, and its ledger entry must say so.
2. **Token survival.** Extract the distinctive tokens (identifiers, numbers, run ids such as `run-20260901-112815`, quoted phrases) from every moved block and
   assert each one appears in the destination after the move. A dropped `136 minutes` or a dropped run id means the evidence for a claim went missing while the
   claim survived, which is worse than losing both.
3. **Sentence ledger.** Every sentence of the four files' original comments is accounted for as `moved`, `kept`, `collapsed-into-existing-doc-text`, or
   `dropped-deliberately`, with the last category itemised in the commit message rather than summarised. A sentence that matches no category fails the move.

Ordinary gates on top of those, all of which are expected to pass untouched because no executable line changes: `pnpm test` (1708 jest + 538 node),
`pnpm run typecheck`, `pnpm run build`.

## What this explicitly does not do

- It does not touch `test/`, which holds 8,287 comment lines of its own. Test comments explain why a case exists and are read by whoever is editing the case.
- It does not touch the other ~50 files whose comments are dense but local.
- It does not change `CLAUDE.md`'s "the existing density is deliberate" convention into a licence to strip comments generally. If anything the convention gets
  narrower and better stated: density is deliberate for local why, and an essay belongs in the essay file.
- It does not reflow any comment that stays. The 160-column rule is still new-text-only.

## Order of work

One file per commit, smallest first, so a bad call is cheap to revert and the sentence ledger stays reviewable:

1. `client/src/lib/run-authority.ts` — one 88-line block, the cleanest test of the rule.
2. `shared/agent.ts` — 16 blocks, the 70-line `runClaimBlock` essay is the bulk.
3. `client/src/lib/run-stats.ts` — 15 blocks, including the 150-line `runStageTotals` block and the admitted KNOWN BLUR restatement.

`shared/types.ts` was audited and then dropped from scope on 2026-09-15, which is a finding rather than a concession. Its 951 comment lines are 26 blocks
averaging 21 lines, and each one sits against the field it describes — `started:`, `lastCommit`, `phase`, `groomTokens`, `driver`. Under the rule above almost
all of that stays, because a per-field doc IS the local-why case: the reader who needs it is the one adding a field beside it. Dropping it costs the biggest
single token figure in the table (~14,200) and buys back the honesty of the rule — applying the move to a file the rule says to leave alone would have been
churn dressed as a principle.
