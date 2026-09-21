import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source guard, in the shape `test/supertest-bind.test.ts`, `test/server-bind.test.ts` and `test/compose-env.test.ts` already use: read the files,
 * assert on their text.
 *
 * bug-44 — the date-bomb. A jsdom suite that renders the Board has two clocks in it: the fixture's date, written the day the case was authored, and
 * the real clock `useNow` reads inside `BoardView`, which `leavesBoard` → `isStale` → `lastTouched` compare that date against. Nothing injects an
 * instant between them, so an absolute fixture date is not a constant — it is an expiry date. An item created `2026-08-20` with no `updated` falls to
 * `lastTouched`'s third rung, ages past the default `staleDays` of 30, leaves the Board for the Archive, and the `getByText` that wanted its card
 * starts throwing. Three cases across two suites went red exactly that way with nothing changed, and every orchestrator run on this repo parked at
 * `verify` until they were fixed.
 *
 * Behaviour cannot be the guard, which is the entire reason this file is a text scan. A fresh absolute date is green on the day it is written and for
 * thirty days afterwards, so the suite that introduces the next one passes every check on the way in — the same reason `supertest-bind.test.ts` reads
 * source rather than measuring a bind. The fix for a red here is a `daysAgo*` call from `test/helpers/dates.ts`, or an allowlist entry below saying
 * why this literal is load-bearing. That sentence is what the bug exists to force.
 *
 * Scope, and both halves of it are deliberate:
 *
 * - `test/*.test.tsx` only. The `.ts` suites (no `x`) are node/unit tests that pass `now` explicitly rather than rendering against the real clock —
 *   `item-age.test.ts:122` and `item-month.test.ts:117` are exactly that shape, and an absolute date is the clearer fixture there.
 * - The four item lifecycle keys only — `created`, `updated`, `lastCommit`, `started`. A run stage stamp, a `createdAt` on a project, a `polledAt` or
 *   an `anchor` never reaches `isStale`, and a guard that flagged them would be refused on its first red rather than obeyed.
 *
 * What it cannot catch, stated so nobody reads more into a green: the pattern is a date literal written as a fixture VALUE, so a literal behind a name
 * (`const CREATED = ...; created: CREATED`) passes. One exists on purpose — `board.test.tsx`'s `CREATED`, which its own comment explains and which is
 * safe only because that suite's default `updated` stamp outranks it. A name is a deliberate act with a place to write the reason; this guard is for
 * the accidental literal, which is the one that has actually happened.
 */
describe('no jsdom suite carries an absolute fixture date', () => {
  const TEST_DIR = __dirname;

  /*
   * Every lifecycle key whose value can decide whether a card renders at all. `lastTouched`'s three rungs are `updated ?? lastCommit ?? created`, and
   * `started` is here because `progressBlock` reads it and because a literal one drifts against the elapsed a card prints.
   */
  const KEYS = ['created', 'updated', 'lastCommit', 'started'];

  /*
   * A closed allowlist, one entry per file, and every entry carries the reason its literal is load-bearing — the reason IS the entry, because an
   * allowlist of bare filenames is a list of places the rule was switched off for no recorded cause.
   */
  const ALLOWED: { file: string; why: string }[] = [
    {
      file: 'item-modal.test.tsx',
      why: "asserts the stored dates are rendered verbatim — factValue('created') is expected to be exactly '2026-08-20' — and renders ItemModal directly, never through leavesBoard, so nothing here can age off a board"
    }
  ];

  /*
   * Comments are blanked before anything is matched, the same precaution `supertest-bind.test.ts` and `server-bind.test.ts` take: the suites this
   * scans explain at length why a literal date is forbidden, and several of those explanations quote one. A scan of the raw text would report the
   * warning as the offence. Newlines are preserved through the blanking so the line numbers this reports are the line numbers in the file.
   */
  function blankComments(src: string): string {
    const keepLines = (match: string): string => match.replace(/[^\n]/g, ' ');
    return src.replace(/\/\*[\s\S]*?\*\//g, keepLines).replace(/^[ \t]*\/\/.*$/gm, keepLines);
  }

  function scannedFiles(): { file: string; source: string }[] {
    return readdirSync(TEST_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.tsx'))
      .map((entry) => ({ file: entry.name, source: blankComments(readFileSync(join(TEST_DIR, entry.name), 'utf8')) }));
  }

  /* `file:line — created: '2026-08-20'`, so a red names the site rather than the rule. */
  function offendersIn(file: string, source: string): string[] {
    const pattern = new RegExp(`\\b(${KEYS.join('|')})\\s*:\\s*['"\`](\\d{4}-\\d{2}-\\d{2})`, 'g');
    return source.split('\n').flatMap((line, index) => {
      const hits = [...line.matchAll(pattern)];
      return hits.map((hit) => `${file}:${index + 1} — ${hit[1]}: '${hit[2]}…'`);
    });
  }

  /* A scan that finds nothing passes vacuously, so the count is asserted first: a rename, a move or a broken filter has to fail loudly here rather
     than turn the two cases below into no-ops. */
  it('finds the jsdom suites at all', () => {
    expect(scannedFiles().length).toBeGreaterThanOrEqual(20);
  });

  it('has no absolute created/updated/lastCommit/started literal outside the allowlist', () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.file));
    const offenders = scannedFiles()
      .filter((entry) => !allowed.has(entry.file))
      .flatMap((entry) => offendersIn(entry.file, entry.source));

    expect(offenders).toEqual([]);
  });

  /* The allowlist is closed in both directions. An entry whose file no longer carries a literal is an exemption nobody needs, and leaving it standing
     would let the next literal into that file unremarked — the dead entry would cover it. */
  it('keeps no allowlist entry that has stopped being load-bearing', () => {
    const scanned = new Map(scannedFiles().map((entry) => [entry.file, entry.source]));
    const stale = ALLOWED.filter((entry) => {
      const source = scanned.get(entry.file);
      return source === undefined || offendersIn(entry.file, source).length === 0;
    }).map((entry) => entry.file);

    expect(stale).toEqual([]);
    expect(ALLOWED.filter((entry) => entry.why.trim() === '')).toEqual([]);
  });
});
