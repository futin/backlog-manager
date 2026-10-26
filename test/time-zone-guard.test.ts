import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * #241's source guard: no client file but `client/src/lib/time-zone.ts` reads a date in the BROWSER's zone.
 *
 * A `Date`'s local getters and setters and the locale formatters silently answer in whatever zone the browser runs in, so one left anywhere on the board
 * reintroduces exactly the disagreement the shared time zone removes — a phone and a laptop drawing two clocks for one run — and nothing on screen would say
 * which reading is the odd one out. Behaviour cannot catch it: every jsdom suite runs under one pinned `TZ` (`test/helpers/global-setup.ts`), where the
 * browser's zone and the shared one are the same zone and a regression is green. So the guard reads source, the same footing as `test/fixture-clock.test.ts`.
 *
 * Comments are scanned too, deliberately: a comment that names one of these as the way a reading is taken is a recipe the next edit copies, and the
 * comments in this codebase are read as instructions. The UTC getters (`getUTCDay`, `getUTCDate` …) are not on the list — they read no zone at all, which is
 * exactly what a bare calendar date wants.
 */

const CLIENT = join(__dirname, '..', 'client', 'src');
const HOME = join(CLIENT, 'lib', 'time-zone.ts');

const FORBIDDEN: readonly RegExp[] = [
  /\.getHours\(/,
  /\.getMinutes\(/,
  /\.getDate\(/,
  /\.getDay\(/,
  /\.getMonth\(/,
  /\.getFullYear\(/,
  /\.setHours\(/,
  /\.setDate\(/,
  /toLocaleTimeString/,
  /toLocaleDateString/
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('time-zone guard', () => {
  it('finds the client sources it means to scan', () => {
    // A guard that silently scanned nothing would pass forever.
    const files = sources(CLIENT);
    expect(files).toContain(HOME);
    expect(files.length).toBeGreaterThan(50);
  });

  it('no client file but lib/time-zone.ts reads a date in the browser zone', () => {
    const hits: string[] = [];
    for (const file of sources(CLIENT)) {
      if (file === HOME) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const re of FORBIDDEN) if (re.test(line)) hits.push(`${relative(CLIENT, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
