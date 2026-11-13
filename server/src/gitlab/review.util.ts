import type { GitlabReview, ReviewSeverity } from '../../../shared/types';

/**
 * The pure fold of a merge request's GitLab discussions into CodeRabbit review FACTS (spec §4.1, §4.2). No state is computed here and no clock is read:
 * the state is `reviewState` in `shared/review.ts`, derived from these facts against the clock at the moment of drawing, so a frozen state can never
 * outlive the minute it was true. Nothing here touches the network; `GitlabClient.mergeRequestDiscussions` reads, this folds.
 *
 * Every rule below is an observation of how CodeRabbit behaves on Timify's GitLab (spec §4.1), not a documented API — which is why each is a small,
 * separately exported function a test can pin.
 */

/** The subset of a GitLab discussion note this fold reads (spec §4.3). */
export interface RawNote {
  id: number;
  body: string;
  author: { username: string };
  system: boolean;
  resolvable: boolean;
  resolved?: boolean;
  created_at: string;
  updated_at: string;
}

/** The subset of a GitLab discussion this fold reads. `individual_note` discussions carry one loose note and are never resolvable. */
export interface RawDiscussion {
  id: string;
  individual_note: boolean;
  notes: RawNote[];
}

const ms = (iso: string): number => Date.parse(iso);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A trigger is a person's note with a LINE that begins `@<bot> review` or `@<bot> full review` (spec §4.1): it is how CodeRabbit is asked, since it never
 * reviews on its own. Line-anchored because a person can quote the command mid-sentence ("please run @bot review later") without asking for it, and
 * because real triggers sometimes carry text above the command. `\b` after `review` keeps `reviewer` out while letting `review chnages` (sic) in. The bot's
 * own notes and system notes are never triggers: the bot echoes the command in its help text.
 */
export function isTrigger(note: Pick<RawNote, 'body' | 'author' | 'system'>, bot: string): boolean {
  if (note.system) return false;
  if (note.author.username.toLowerCase() === bot.toLowerCase()) return false;
  return new RegExp(`^[ \\t]*@${escapeRe(bot)}[ \\t]+(?:full[ \\t]+)?review\\b`, 'im').test(note.body);
}

/**
 * The severity of a finding (spec §4.1): a bold run `**<emoji> Major**` (the emoji is INSIDE the bold) on the note's FIRST line only. A word further down
 * is the finding's prose, not its badge, so it never counts. Anything that does not parse is `other`, counted but never the `worst`.
 */
export function parseSeverity(body: string): ReviewSeverity | 'other' {
  const first = body.split('\n', 1)[0] ?? '';
  const m = /\*\*(?:[^\s*]+\s+)?(Critical|Major|Minor|Trivial)\*\*/i.exec(first);
  return m ? (m[1].toLowerCase() as ReviewSeverity) : 'other';
}

/** N from a system note `added N commit(s)`, else `null` (spec §4.2 `commitsSince`). */
export function countAddedCommits(body: string): number | null {
  const m = /^added (\d+) commits?\b/i.exec(body.trim());
  return m ? Number(m[1]) : null;
}

const ORDER: ReviewSeverity[] = ['critical', 'major', 'minor', 'trivial'];

/**
 * Folds discussions into the facts (spec §4.2). `capped` is copied through (the discussions ran past the page budget); `readAt` is the caller's clock.
 *
 * - **Findings** are discussions whose FIRST note is the bot's (non-system) and which carry at least one resolvable note: a person's trigger discussion is
 *   resolvable too but is not a finding, and a bot note nobody can resolve is not one either. A finding is resolved only when EVERY resolvable note in it
 *   is resolved; a half-resolved thread is still open.
 * - **Landing, per round**: the earlier of (a) the bot's first non-system `Actionable comments posted:` note created after the trigger and before the
 *   next trigger, and (b) the `updated_at` of the bot's first reply in the trigger's own discussion, when it was edited after it was created. (a) is the
 *   round with findings; (b) is the only signal of a round with none; taking the earlier tolerates either arriving late. `landedAt` is the latest landing
 *   over all rounds, `triggeredAt` the latest trigger, so a round that never lands leaves the previous landing in place.
 * - **`commitsSince`** sums N over `added N commit(s)` system notes created strictly after `landedAt`; with no landing there is nothing to be out of date
 *   against, so 0.
 */
export function foldReview(discussions: RawDiscussion[], bot: string, capped: boolean, readAt: string): GitlabReview {
  const isBot = (n: RawNote): boolean => n.author.username.toLowerCase() === bot.toLowerCase();

  type Trigger = { at: string; discussion: RawDiscussion };
  const triggers: Trigger[] = [];
  for (const d of discussions) for (const n of d.notes) if (isTrigger(n, bot)) triggers.push({ at: n.created_at, discussion: d });
  triggers.sort((a, b) => ms(a.at) - ms(b.at));

  const landingNotes = discussions
    .flatMap((d) => d.notes)
    .filter((n) => !n.system && isBot(n) && n.body.includes('Actionable comments posted:'))
    .map((n) => n.created_at);

  let landedAt: string | null = null;
  triggers.forEach((t, i) => {
    const from = ms(t.at);
    const until = i + 1 < triggers.length ? ms(triggers[i + 1].at) : Infinity;
    const candidates: string[] = landingNotes.filter((c) => ms(c) > from && ms(c) < until);
    const reply = t.discussion.notes.find((n) => !n.system && isBot(n) && ms(n.created_at) >= from);
    if (reply && ms(reply.updated_at) > ms(reply.created_at)) candidates.push(reply.updated_at);
    if (candidates.length === 0) return;
    const round = candidates.reduce((a, b) => (ms(b) < ms(a) ? b : a));
    if (landedAt === null || ms(round) > ms(landedAt)) landedAt = round;
  });

  const bySeverity: GitlabReview['bySeverity'] = { critical: 0, major: 0, minor: 0, trivial: 0, other: 0 };
  let open = 0;
  let resolved = 0;
  for (const d of discussions) {
    const first = d.notes[0];
    if (!first || first.system || !isBot(first)) continue;
    const resolvable = d.notes.filter((n) => n.resolvable);
    if (resolvable.length === 0) continue;
    if (resolvable.every((n) => n.resolved === true)) {
      resolved += 1;
    } else {
      open += 1;
      bySeverity[parseSeverity(first.body)] += 1;
    }
  }
  const worst = ORDER.find((s) => bySeverity[s] > 0) ?? null;

  let commitsSince = 0;
  if (landedAt !== null) {
    const after = ms(landedAt);
    for (const d of discussions)
      for (const n of d.notes) {
        if (!n.system || ms(n.created_at) <= after) continue;
        commitsSince += countAddedCommits(n.body) ?? 0;
      }
  }

  return {
    open,
    resolved,
    worst,
    bySeverity,
    triggeredAt: triggers.length > 0 ? triggers[triggers.length - 1].at : null,
    landedAt,
    commitsSince,
    capped,
    readAt,
    failed: false
  };
}
