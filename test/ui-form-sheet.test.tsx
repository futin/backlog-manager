/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { FormSheet } from '../client/src/components/ui/FormSheet';

describe('FormSheet', () => {
  it('is a dialog named by its label, with the title, body and footer in their own slots', () => {
    render(
      <FormSheet label="orchestrate alpha" title={<span>alpha</span>} footer={<button>start</button>} onClose={() => {}}>
        <span>the fields</span>
      </FormSheet>
    );

    // `label`, not `title`: the two are different strings on both sheets —
    // `dispatch task-1` against a kicker plus an id — and a name derived from
    // the title node would have silently renamed both dialogs.
    const dialog = screen.getByRole('dialog', { name: 'orchestrate alpha' });
    expect(dialog).toHaveClass('ui-form-sheet');
    expect(dialog.querySelector('.ui-form-sheet-title')).toContainElement(screen.getByText('alpha'));
    expect(dialog.querySelector('.ui-form-sheet-body')).toContainElement(screen.getByText('the fields'));
    expect(dialog.querySelector('.ui-form-sheet-foot')).toContainElement(screen.getByRole('button', { name: 'start' }));
  });

  /* The steps slot is optional because only one of the two sheets has steps,
     and an absent slot draws no hairline — an empty rule above the body is a
     line that says nothing. */
  it('draws the steps slot only when there are steps', () => {
    const { rerender } = render(
      <FormSheet label="dispatch task-1" title="task-1" footer={null} onClose={() => {}}>
        fields
      </FormSheet>
    );
    expect(document.querySelector('.ui-form-sheet-steps')).toBeNull();

    rerender(
      <FormSheet label="orchestrate alpha" title="alpha" steps={<ol aria-label="orchestrate steps" />} footer={null} onClose={() => {}}>
        fields
      </FormSheet>
    );
    expect(document.querySelector('.ui-form-sheet-steps')).toContainElement(screen.getByLabelText('orchestrate steps'));
  });

  /* A footer is required so a composer has to decide, and drawn only when it
     holds something: the launch sheet's launched and blocked states have no
     actions left, and an empty bar with a rule over it would be a control row
     with no controls. */
  it('draws no footer bar when the composer passes none', () => {
    render(
      <FormSheet label="dispatch task-1" title="task-1" footer={null} onClose={() => {}}>
        fields
      </FormSheet>
    );
    expect(document.querySelector('.ui-form-sheet-foot')).toBeNull();
  });

  it('closes on the scrim, on its close control, and on Escape', async () => {
    const onClose = jest.fn();
    render(
      <FormSheet label="dispatch task-1" title="task-1" footer={null} onClose={onClose}>
        fields
      </FormSheet>
    );

    await userEvent.click(document.querySelector('.ui-form-sheet-scrim') as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('takes the full-screen shape from useNarrow, the same one place the modal reads it', () => {
    const matchMedia = jest.fn().mockReturnValue({ matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() });
    Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });

    render(
      <FormSheet label="dispatch task-1" title="task-1" footer={null} onClose={() => {}}>
        fields
      </FormSheet>
    );

    expect(screen.getByRole('dialog')).toHaveClass('ui-form-sheet', 'ui-form-sheet-narrow');
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 700px)');
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });
});
