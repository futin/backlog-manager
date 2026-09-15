/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Band } from '../client/src/components/ui/Band';

/*
  One suite per `ui/` primitive (the design spec's §9), in the shape
  `SettingsRow`'s own suite already has: the role it lands under, the name a
  reader hears, and that each variant prop becomes its documented class. The
  class assertions are the half that matters most here — every one of these
  components is composed by a LATER task, so nothing else in the repo pins
  their markup yet, and a prop that silently stopped emitting its class would
  be found by task 3 or task 5 rather than by this task's own reviewer.
*/
describe('Band', () => {
  it('is a banner-less header carrying the title as a heading', () => {
    render(<Band title="Runs" />);

    expect(screen.getByRole('heading', { name: 'Runs' })).toBeInTheDocument();
  });

  it('renders the subtitle only when one is given', () => {
    const { rerender } = render(<Band title="Runs" />);
    expect(document.querySelector('.ui-band-sub')).toBeNull();

    rerender(<Band title="Runs" sub="every run this orchestrator has made" />);
    expect(screen.getByText('every run this orchestrator has made')).toHaveClass('ui-band-sub');
  });

  it('puts its children in the right slot, and draws no slot without them', () => {
    const { rerender } = render(<Band title="Board" />);
    expect(document.querySelector('.ui-band-right')).toBeNull();

    rerender(<Band title="Board"><button>Orchestrate</button></Band>);
    const right = document.querySelector('.ui-band-right');
    expect(right).not.toBeNull();
    expect(right).toContainElement(screen.getByRole('button', { name: 'Orchestrate' }));
  });
});
