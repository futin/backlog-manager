/**
 * @jest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { render } from '@testing-library/react';

import { Chevron } from '../client/src/components/ui/Chevron';

/**
 * Guards the one disclosure mark (dashboard-redesign-ports task 2): every fold, caret and open/closed cue draws `Chevron`, never a text triangle. The glyphs
 * (`▸ ▾`) were a few pixels tall and hard to see, and a component that reintroduces one fails here by FILE NAME. Ported from the dashboard's
 * `test/chevrons.test.ts`, which is a hand-rolled runner there; the render cases are new, because here the component is the contract and not only the ban.
 *
 * It reads source for the two ban cases because a behavioural test only sees the components it happens to render, and a triangle added to a rarely drawn
 * surface next month would pass it — the same reason `design-guards.test.ts` reads the sheet as text.
 */

const ROOT = join(__dirname, '..');
const COMPONENTS = join(ROOT, 'client', 'src', 'components');
const STYLES = join(ROOT, 'client', 'src', 'styles.css');
const TRIANGLES = ['▸', '▾', '▴', '◂', '▶', '▼'];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsxFiles(p) : e.name.endsWith('.tsx') ? [p] : [];
  });
}

/** Drops block comments and `//` line comments; the line pass skips `://` so a URL inside a string survives. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('chevrons', () => {
  it('no component draws a text triangle outside a comment', () => {
    const files = tsxFiles(COMPONENTS);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      const hit = TRIANGLES.find((g) => code.includes(g));
      return hit === undefined ? [] : [`${relative(ROOT, file)} draws the text triangle ${hit}; use <Chevron />`];
    });
    expect(offenders).toEqual([]);
  });

  it('styles.css draws no text triangle through content:', () => {
    const offenders = readFileSync(STYLES, 'utf8')
      .split('\n')
      .flatMap((line, i) => {
        const m = /content\s*:\s*("[^"]*"|'[^']*')/.exec(line);
        const hit = m ? TRIANGLES.find((g) => m[1].includes(g)) : undefined;
        return hit === undefined ? [] : [`client/src/styles.css:${i + 1} draws the text triangle ${hit} through content:; use <Chevron />`];
      });
    expect(offenders).toEqual([]);
  });

  it('has no rule that turns a caret a second time, and cancels the turn under reduced motion', () => {
    const css = readFileSync(STYLES, 'utf8');
    // The removed `.tracker-chip[aria-expanded="true"] .tracker-caret { rotate(180deg) }`: on an element already carrying `.chev-up` it turns the mark back down.
    expect(css).not.toMatch(/\.tracker-caret\s*\{[^}]*transform/);
    expect(css).not.toMatch(/aria-expanded[^{]*\.tracker-caret/);
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{ \.chev-down \{ transition: none \}[^\n]*\}/.exec(css)?.[0] ?? '';
    for (const dir of ['down', 'up', 'right']) expect(reduced).toContain(`.chev-${dir} { transition: none }`);
  });

  it('draws an aria-hidden svg carrying chev and chev-right for dir="right"', () => {
    const { container } = render(createElement(Chevron, { dir: 'right' }));
    const svg = container.firstElementChild as Element;
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('chev')).toBe(true);
    expect(svg.classList.contains('chev-right')).toBe(true);
  });

  it('points down by default, and draws the one path whatever the direction', () => {
    const { container } = render(createElement(Chevron));
    const svg = container.firstElementChild as Element;
    expect(svg.classList.contains('chev-down')).toBe(true);
    expect(svg.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(svg.querySelector('path')?.getAttribute('d')).toBe('M2 4l3 3 3-3');
  });

  it('appends className to the chev classes rather than replacing them', () => {
    const { container } = render(createElement(Chevron, { dir: 'up', className: 'x' }));
    const svg = container.firstElementChild as Element;
    expect(svg.getAttribute('class')).toBe('chev chev-up x');
  });
});
