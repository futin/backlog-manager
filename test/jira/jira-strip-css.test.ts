import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The summary strip spreads its cells across the band (spec "Spread strip"). jsdom never lays anything out, so the contract is read from the sheet: the cell
 * grows, and nothing on the strip or the page frame becomes a container — a container would be the containing block of `Run ▾`'s and the Move-to panel's
 * `position: fixed` phone-shape panels.
 */
const css = readFileSync(join(__dirname, '../../client/src/styles.css'), 'utf8');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] }));

describe('Jira summary strip spread', () => {
  it('lets each .jira-strip-cell grow with flex: 1 1 auto', () => {
    const cell = rules.find((r) => r.selector === '.jira-strip-cell');
    expect(cell).toBeDefined();
    expect(cell!.body).toContain('flex: 1 1 auto');
  });

  it('sets no container-type on the strip, its frame or the ticket page', () => {
    const hits = rules.filter((r) => /jira-strip|jira-page/.test(r.selector) && /container-type/.test(r.body));
    expect(hits).toEqual([]);
  });
});
