import { useRef, useState } from 'react';

import { boardsByName } from '../../lib/jira';
import type { JiraBoardStatus } from '../../../../shared/types';
import { Chevron } from '../ui/Chevron';
import { Chip } from '../ui/Chip';
import { Popover } from '../ui/Popover';

/**
 * The board picker: a `Chip` reading the board's name that opens a `Popover` listing every board by name — pick only (spec §1: Edit and New belong to
 * Setup). A pick stores the board's id and closes the panel; nothing else happens, because what the page draws follows from the stored id alone. The chip is
 * the popover's anchor (its own click toggles; Escape hands focus back to it), which is what `Chip`'s ref is for. DESIGN.md §8.9.1.
 */
export function JiraBoardPicker({ boards, current, onPick }: { boards: readonly JiraBoardStatus[]; current: JiraBoardStatus; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  return (
    <div className="jira-picker">
      <Chip
        ref={chip}
        aria-label={`Pick a Jira board: ${current.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="jira-picker-name">{current.name}</span>
        <Chevron dir={open ? 'up' : 'down'} />
      </Chip>
      {open && (
        <Popover label="Boards" width={320} anchor={chip} onClose={() => setOpen(false)}>
          {boardsByName(boards).map((b) => (
            <button
              key={b.id}
              type="button"
              className={b.id === current.id ? 'jira-picker-opt on' : 'jira-picker-opt'}
              aria-pressed={b.id === current.id}
              onClick={() => {
                onPick(b.id);
                setOpen(false);
              }}
            >
              <span>{b.name}</span>
              <svg className="jira-picker-tick" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 10.5l4 4 8-9" />
              </svg>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}
