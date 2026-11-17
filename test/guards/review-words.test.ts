import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Pins the Reviewer label words to one home (#533): `reviewWord` in `shared/agent.ts` is what both the Reviewer pickers (`client/src/lib/agents.ts`) and the
 * Run detail line (`reviewerLabel`) read, so a specially-spelled word lands in both surfaces at once. Before it, each side carried its own `{ xhigh: 'XHigh' }`
 * map and nothing tied them together — a word added to one would have rendered one way in Settings and another on the run that used it.
 *
 * It reads source because behaviour cannot catch a second copy: a duplicated map renders the same text as the shared one until the day the two drift, and the
 * render suites (`settings-reviewer.test.tsx`, `run-detail-model.test.ts`) are green right up to that day. `'XHigh'` is the map's one special spelling, so
 * counting it counts copies of the map.
 */

const ROOT = join(__dirname, '..', '..');
const DIRS = [join(ROOT, 'client', 'src'), join(ROOT, 'shared')];
const SPECIAL = "'XHigh'";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('review words', () => {
  it(`spells ${SPECIAL} once, in shared/agent.ts`, () => {
    const files = DIRS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (line.includes(SPECIAL) ? [`${relative(ROOT, file)}:${i + 1}`] : []))
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^shared\/agent\.ts:\d+$/);
  });
});
