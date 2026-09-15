import type { ReactNode } from 'react';

/**
 * ProgressRow — §7's progress row (.claude/DESIGN.md §7, §3's "progress bars:
 * 10 px tall").
 *
 * Name and value on one line, a 10 px bar under it, an optional caption under
 * that. The bar is a filled length over a flat `--steel` track: §2 says the
 * remainder is a track with no hatch, and the fill carries the design's 45°
 * hatch — which is why `hatch` is a flag here rather than the default. A
 * heartbeat meter is a reading, not a quantity of work done, and hatching it
 * would claim the same thing a filled sweep bar claims.
 *
 * `value` is clamped against `max` rather than trusted: every caller computes
 * it from live data (an elapsed over a budget), and a bar drawn past its own
 * track is the one failure that looks like a rendering bug rather than a
 * number being large.
 *
 * `role="progressbar"` with the real min/max/now is what makes the reading
 * available without the bar: the caption is optional and the bar itself is
 * decoration, so the numbers have to live on the element.
 */
export function ProgressRow({
  name, value, max, caption, hatch, height = 10, fill = 'progress', valueText
}: {
  name?: ReactNode;
  value: number;
  max: number;
  caption?: ReactNode;
  hatch?: boolean;
  height?: 10 | 6;
  fill?: 'progress' | 'ink';
  /** The right-hand half of §7's two-tone amount — `3 / 8`, `2h of 6h`. */
  valueText?: ReactNode;
}) {
  const safeMax = max > 0 ? max : 0;
  const clamped = safeMax === 0 ? 0 : Math.min(Math.max(value, 0), safeMax);
  const pct = safeMax === 0 ? 0 : (clamped / safeMax) * 100;

  return (
    <div className="ui-progress">
      {(name || valueText) && (
        <div className="ui-progress-head">
          {name && <span className="ui-progress-name">{name}</span>}
          {valueText && <span className="ui-progress-value">{valueText}</span>}
        </div>
      )}
      <div
        className={height === 6 ? 'ui-progress-track ui-progress-6' : 'ui-progress-track'}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
      >
        <span
          className={[
            'ui-progress-fill', `ui-progress-fill-${fill}`, hatch ? 'hatch' : null
          ].filter(Boolean).join(' ')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {caption && <span className="ui-progress-caption">{caption}</span>}
    </div>
  );
}
