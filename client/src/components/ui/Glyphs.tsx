export type GlyphName =
  | 'play'
  | 'document'
  | 'sparkle'
  | 'robot'
  | 'person'
  | 'flag'
  | 'branch'
  | 'tag'
  | 'calendar'
  | 'ring'
  | 'grid'
  | 'tick'
  | 'up'
  | 'down'
  | 'equals'
  | 'cross'
  | 'clock'
  | 'pull-request'
  | 'merge'
  | 'refresh'
  | 'external'
  | 'pause'
  | 'cpu'
  | 'coin';

/*
  One 16-unit grid, outline only, 1.5 px stroke with round caps and joins, `currentColor` — the wrapper's ink decides the colour, so a glyph never takes an
  accent of its own (.claude/DESIGN.md §6: icons never take accent colour). Fills are always `none`: a filled shape would read as a second weight beside the
  Chevron and the type icons. Paths are plain data so a name that is added cannot change how the others draw.
*/
const PATHS: Record<GlyphName, string[]> = {
  play: ['M5.5 3.5v9l7-4.5z'],
  document: ['M4 2h5.5L12.5 5v9h-8.5z', 'M9.5 2v3h3', 'M6 8.5h4.5M6 11h4.5'],
  sparkle: ['M8 2v3.5M8 10.5V14M2 8h3.5M10.5 8H14', 'M8 5.5c.4 1.6.9 2.1 2.5 2.5-1.6.4-2.1.9-2.5 2.5-.4-1.6-.9-2.1-2.5-2.5C7.1 7.6 7.6 7.1 8 5.5z'],
  robot: ['M3 5.5h10v7H3z', 'M8 5.5V3M6 9v.5M10 9v.5', 'M1.5 8.5v1.5M14.5 8.5v1.5'],
  person: ['M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M3 13.5c.4-2.5 2.4-4 5-4s4.6 1.5 5 4'],
  flag: ['M4 14V2.5', 'M4 3h8l-1.8 2.8L12 8.5H4'],
  branch: ['M5 3.5v9', 'M5 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M5 13.5a2 2 0 1 0 0-.01', 'M11 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M11 6.5c0 3-6 2-6 6'],
  tag: ['M2.5 2.5h5.5l5.5 5.5-5.5 5.5L2.5 8z', 'M5.5 5.5h.01'],
  calendar: ['M2.5 3.5h11v10h-11z', 'M2.5 6.5h11', 'M5.5 2v3M10.5 2v3'],
  ring: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z'],
  grid: ['M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9H7v4.5H2.5zM9 9h4.5v4.5H9z'],
  tick: ['M3 8.5l3.2 3.2L13 4.8'],
  up: ['M8 13V3.5M4 7.5l4-4 4 4'],
  down: ['M8 3v9.5M4 8.5l4 4 4-4'],
  equals: ['M3 6h10M3 10h10'],
  cross: ['M4 4l8 8M12 4l-8 8'],
  clock: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M8 5v3.2l2 1.3'],
  'pull-request': ['M4.5 5v6', 'M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M11.5 11V6.5a2 2 0 0 0-2-2H8', 'M11.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],
  merge: ['M4.5 5v6', 'M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M11.5 11a1.5 1.5 0 1 0 0-.01', 'M4.5 5c0 3 7 2 7 6'],
  refresh: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13 2.5v3h-3'],
  external: ['M9 2.5h4.5V7', 'M13.5 2.5L7.5 8.5', 'M11.5 9.5v3.5h-9v-9H6'],
  pause: ['M5.5 3.5v9M10.5 3.5v9'],
  cpu: ['M4.5 4.5h7v7h-7z', 'M6.5 6.5h3v3h-3z', 'M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14'],
  coin: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M9.8 6.2C9.4 5.7 8.8 5.5 8 5.5c-1 0-1.7.5-1.7 1.2 0 1.8 3.5.8 3.5 2.6 0 .7-.8 1.2-1.8 1.2-.8 0-1.5-.3-1.9-.9', 'M8 4.2v1.3M8 10.5v1.3']
};

/**
 * Glyph — the outline glyph set the Jira board's chips and card facts share. `aria-hidden` always: like `Chevron`, a glyph is a cue beside text or a control
 * that already carries its own name. 14 px by default; 16 for a larger control and 10 for a caret-sized mark. The size is the box only — the 1.5 stroke is
 * in viewBox units, so it scales with the box rather than staying 1.5 px at 10 and 16.
 */
export function Glyph({ name, size = 14 }: { name: GlyphName; size?: 14 | 16 | 10 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
