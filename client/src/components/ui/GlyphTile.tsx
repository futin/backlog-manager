import { Glyph, type GlyphName } from './Glyphs';

export type GlyphTileTone = 'neutral' | 'green' | 'red' | 'amber' | 'ink';

/**
 * GlyphTile — a glyph on a small tinted square, the leading mark of a row, a sheet header or a launch option. Decorative: `aria-hidden`, like `Glyph`, because
 * the text beside it carries the name. The glyph is 14 px, or 10 at the 18 px size where 14 would fill the tile edge to edge.
 */
export function GlyphTile({ glyph, tone = 'neutral', size = 28 }: { glyph: GlyphName; tone?: GlyphTileTone; size?: 18 | 28 | 32 }) {
  return (
    <span className="ui-glyph-tile" data-tone={tone} data-size={size} aria-hidden="true">
      <Glyph name={glyph} size={size === 18 ? 10 : 14} />
    </span>
  );
}
