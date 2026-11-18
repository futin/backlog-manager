/**
 * @jest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { Modal } from '../../client/src/components/ui/Modal';

describe('Modal', () => {
  it('is a dialog named by its label, with the facts and body in their own slots', () => {
    render(
      <Modal label="groomed bug" facts={<span>the facts</span>} onClose={() => {}}>
        <span>the body</span>
      </Modal>
    );

    const dialog = screen.getByRole('dialog', { name: 'groomed bug' });
    expect(dialog).toHaveClass('ui-modal');
    // The split is the whole contract: a composer hands two nodes and the
    // stylesheet, not the composer, decides the 290 px column and the fold.
    expect(dialog.querySelector('.ui-modal-facts')).toContainElement(screen.getByText('the facts'));
    expect(dialog.querySelector('.ui-modal-body')).toContainElement(screen.getByText('the body'));
    // No `head`, no split: the item modal keeps the sidecar shape and draws no head band.
    expect(dialog).not.toHaveClass('ui-modal-split');
    expect(dialog.querySelector('.ui-modal-head')).toBeNull();
  });

  it('takes the split shape when a composer passes `head`, with the head band ahead of both columns', () => {
    render(
      <Modal label="PAY-131" head={<span>the head</span>} facts={<span>the agent</span>} onClose={() => {}}>
        <span>the ticket</span>
      </Modal>
    );

    const dialog = screen.getByRole('dialog', { name: 'PAY-131' });
    expect(dialog).toHaveClass('ui-modal', 'ui-modal-split');
    const head = dialog.querySelector('.ui-modal-head');
    expect(head).toContainElement(screen.getByText('the head'));
    // Ahead in document order, so a reader meets the title before either column.
    expect(head!.compareDocumentPosition(dialog.querySelector('.ui-modal-facts')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.querySelector('.ui-modal-body')).toContainElement(screen.getByText('the ticket'));
  });

  it('draws a `foot` as a full-width band after the body, and no band without one', () => {
    const { unmount } = render(
      <Modal label="reply editor" head={<span>head</span>} facts={<span>write</span>} foot={<button type="button">Post reply</button>} onClose={() => {}}>
        <span>preview</span>
      </Modal>
    );
    const dialog = screen.getByRole('dialog', { name: 'reply editor' });
    const foot = dialog.querySelector('.ui-modal-foot');
    expect(foot).not.toBeNull();
    expect(foot!.parentElement).toBe(dialog);
    expect(foot).toContainElement(screen.getByRole('button', { name: 'Post reply' }));
    // After the body: the last of the shell's slots, so it reads after both columns.
    expect(dialog.lastElementChild).toBe(foot);
    expect(dialog).toHaveClass('ui-modal-footed');
    unmount();

    render(
      <Modal label="plain" facts={<span>f</span>} onClose={() => {}}>
        <span>b</span>
      </Modal>
    );
    expect(screen.getByRole('dialog', { name: 'plain' }).querySelector('.ui-modal-foot')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'plain' })).not.toHaveClass('ui-modal-footed');
  });

  it('stacks over another modal with `over`: the scrim and the panel both carry ui-modal-over, and neither does without it', () => {
    const { unmount } = render(
      <Modal label="on top" over facts={<span>f</span>} onClose={() => {}}>
        <span>b</span>
      </Modal>
    );
    expect(screen.getByTestId('modal-scrim')).toHaveClass('ui-modal-over');
    expect(screen.getByRole('dialog', { name: 'on top' })).toHaveClass('ui-modal-over');
    unmount();

    render(
      <Modal label="below" facts={<span>f</span>} onClose={() => {}}>
        <span>b</span>
      </Modal>
    );
    expect(screen.getByTestId('modal-scrim')).not.toHaveClass('ui-modal-over');
    expect(screen.getByRole('dialog', { name: 'below' })).not.toHaveClass('ui-modal-over');
  });

  it('closes on the scrim, on its close control, and on Escape', async () => {
    const onClose = jest.fn();
    render(
      <Modal label="groomed bug" facts={null} onClose={onClose}>
        body
      </Modal>
    );

    await userEvent.click(screen.getByTestId('modal-scrim'));
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await userEvent.keyboard('{Escape}');

    // Escape included: the shell calls `useDialogEscape` so its composers do
    // not have to, which is what keeps bug-23's rule true of every surface
    // that opens through it.
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  /* `useNarrow` answers `false` with no `matchMedia` (jsdom's default), which
     is the desktop shape every other case here asserts against. Stubbing it
     true proves the hook is actually READ rather than the breakpoint being
     restated as a media query of this family's own — the fold is a reading
     order, and CSS alone cannot reorder the two slots. */
  it('takes the full-screen shape from useNarrow, not from a media query of its own', () => {
    const matchMedia = jest.fn().mockReturnValue({ matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() });
    Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });

    render(
      <Modal label="groomed bug" facts={null} onClose={() => {}}>
        body
      </Modal>
    );

    expect(screen.getByRole('dialog')).toHaveClass('ui-modal', 'ui-modal-narrow');
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 700px)');
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });
});

/**
 * Test case 1 of task-40's brief, and the reason it is a SOURCE guard: "this
 * is the only modal in the app" is a negative, and a render test cannot prove
 * a component nobody wrote does not exist.
 *
 * Two halves, because there are two ways a second modal arrives — someone
 * writes a `RunModal`, or someone composes this primitive from a second
 * surface. The design spec's §6.1/§12.4 say the run's detail is the Runs
 * page's own inline sheet and that `Modal` therefore has exactly one composer;
 * a second one is a design change, which means amending that section first,
 * not a diff this guard should pass silently.
 */
describe('the item modal and the two Jira modals are the only modals', () => {
  const SRC = join(__dirname, '..', '..', 'client', 'src');

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  }

  const files = walk(SRC).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));

  it('has no run-modal component anywhere in client/src', () => {
    const offenders = files.filter((f) => /run-?modal/i.test(f.split('/').pop() as string));
    expect(offenders).toEqual([]);
  });

  // Three since Jira mentions: the mention modal (`jira/JiraMentionModal.tsx`) is a ticket's thread, with no run to show, so §8.7 was amended to admit it.
  it('is composed by exactly three files — board/ItemModal.tsx, jira/JiraDetail.tsx and jira/JiraMentionModal.tsx', () => {
    const composers = files
      .filter((f) => !f.endsWith(join('ui', 'Modal.tsx')))
      .filter((f) => /from '[^']*ui\/Modal'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));
    expect(composers.sort()).toEqual([
      join('components', 'board', 'ItemModal.tsx'),
      join('components', 'jira', 'JiraDetail.tsx'),
      join('components', 'jira', 'JiraMentionModal.tsx')
    ]);
  });
});
