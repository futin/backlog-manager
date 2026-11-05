import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { Chip } from './ui/Chip';
import { Glyph } from './ui/Glyphs';
import type { StateTone } from '../lib/tones';

/**
 * The popover head the two status pills share (Shell mock, open popover): initials disc, name, `● connected · <site>`, `Sync now`, then two figures. A
 * component of its own because the GitHub and Jira popovers draw one head and differ only in the words — two copies are how the two heads come to disagree
 * about where focus lands. Focus lands on `Sync now` on mount: the popover mounts only while open, so mount is "just opened", and a keyboard reader
 * who opened it is one Enter from the one thing the head is for. A disabled button cannot take focus, so a blocked head leaves it where it was.
 */
export function ServiceHead({
  initial,
  name,
  tone,
  status,
  busy,
  disabledReason,
  notice,
  onSync,
  figures
}: {
  initial: string;
  name: string;
  tone: StateTone;
  /** The `connected · site` sentence. */
  status: string;
  busy: boolean;
  /** Set when `Sync now` cannot work (a 409's sentence, or why there is nothing to sync): disables it and becomes its title. */
  disabledReason: string | null;
  notice: string | null;
  onSync: () => void;
  figures: { label: string; value: ReactNode }[];
}) {
  const sync = useRef<HTMLButtonElement>(null);
  useEffect(() => sync.current?.focus(), []);
  return (
    <>
      <div className="tracker-pop-id">
        <span className="tracker-av">{initial}</span>
        <span className="tracker-pop-who">
          <span className="tracker-pop-name">{name}</span>
          <span className="tracker-pop-sub">
            <span className="tracker-dot" data-tone={tone} aria-hidden="true" />
            {status}
          </span>
        </span>
        <Chip
          ref={sync}
          size={28}
          icon={<Glyph name="refresh" />}
          disabled={busy || disabledReason !== null}
          title={disabledReason ?? undefined}
          onClick={onSync}
        >
          Sync now
        </Chip>
      </div>
      {notice !== null && (
        <p className="tracker-pop-note jira-setup-failure" role="status">
          {notice}
        </p>
      )}
      <div className="tracker-pop-figures">
        {figures.map((f) => (
          <div className="tracker-pop-figure" key={f.label}>
            <span className="tracker-pop-figure-label">{f.label}</span>
            <span className="tracker-pop-figure-value">{f.value}</span>
          </div>
        ))}
      </div>
    </>
  );
}
