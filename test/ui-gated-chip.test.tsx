/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { GatedChip } from '../client/src/components/ui/GatedChip';
import type { AgentsStatus } from '../shared/types';

/**
 * #272: `GatedChip` is the one implementation of the disabled-control mechanics `DispatchButton` and the band's Orchestrate chip used to hand-keep each.
 * Its callers' suites (dispatch-button, orchestrator-start-ui, tracker-board) prove the wiring through a real board; this one proves the mechanics
 * against a stub `reverify` the test resolves by hand, which is the only way to observe the state between a click and its answer.
 */
const FRESH: AgentsStatus = {
  enabled: true,
  reachable: true,
  remoteAnswer: true,
  spawnAvailable: true,
  spawnMaxPermission: 'acceptEdits',
  projectPaths: ['/p']
};

const GATE = 'the dashboard does not list /p';
const OTHER = 'held by a session';

/** A `reverify` whose promise the test settles itself, counting its calls. */
function heldReverify(): { reverify: jest.Mock<Promise<AgentsStatus>, []>; resolve: (s: AgentsStatus) => Promise<void> } {
  let settle: (s: AgentsStatus) => void = () => {};
  const reverify = jest.fn(
    () =>
      new Promise<AgentsStatus>((r) => {
        settle = r;
      })
  );
  return {
    reverify,
    resolve: async (s) => {
      await act(async () => {
        settle(s);
      });
    }
  };
}

function renderChip(props: Partial<Parameters<typeof GatedChip>[0]> = {}): { onActivate: jest.Mock; recheck: jest.Mock } {
  const onActivate = jest.fn();
  const recheck = jest.fn(() => true);
  render(
    <GatedChip gateBlock={null} otherBlock={null} idleTitle="do the thing" recheck={recheck} onActivate={onActivate} {...props}>
      Go
    </GatedChip>
  );
  return { onActivate: (props.onActivate as jest.Mock) ?? onActivate, recheck: (props.recheck as jest.Mock) ?? recheck };
}

describe('GatedChip', () => {
  it('activates on click when nothing blocks, and asks nothing', async () => {
    const { reverify } = heldReverify();
    const { onActivate } = renderChip({ reverify });
    const btn = screen.getByRole('button', { name: 'Go' });

    expect(btn).toHaveAttribute('aria-disabled', 'false');
    expect(btn).not.toHaveAttribute('aria-describedby');
    expect(btn).toHaveAttribute('title', 'do the thing');

    await userEvent.click(btn);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(reverify).not.toHaveBeenCalled();
  });

  it('refuses a block it cannot re-ask, with the reason described from outside the button', async () => {
    const { reverify } = heldReverify();
    const { onActivate } = renderChip({ reverify, otherBlock: OTHER });
    const btn = screen.getByRole('button', { name: 'Go' });

    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', OTHER);
    const reason = document.getElementById(btn.getAttribute('aria-describedby') ?? '');
    expect(reason).toHaveTextContent(OTHER);
    expect(btn).not.toContainElement(reason);

    await userEvent.click(btn);
    expect(reverify).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('re-asks a visibility block, busy until the answer, and activates when the fresh answer clears it', async () => {
    const { reverify, resolve } = heldReverify();
    const { onActivate } = renderChip({ reverify, gateBlock: GATE });
    const btn = screen.getByRole('button', { name: 'Go' });

    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(onActivate).not.toHaveBeenCalled();

    await resolve(FRESH);
    expect(btn).toHaveAttribute('aria-busy', 'false');
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('activates nothing, and keeps the reason, when the fresh answer is still blocked', async () => {
    const { reverify, resolve } = heldReverify();
    const recheck = jest.fn(() => false);
    const { onActivate } = renderChip({ reverify, recheck, gateBlock: GATE });
    const btn = screen.getByRole('button', { name: 'Go' });

    await userEvent.click(btn);
    await resolve(FRESH);

    expect(onActivate).not.toHaveBeenCalled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', GATE);
  });

  it('asks once however many times it is clicked while the first ask is in flight', async () => {
    const { reverify, resolve } = heldReverify();
    renderChip({ reverify, gateBlock: GATE });
    const btn = screen.getByRole('button', { name: 'Go' });

    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(reverify).toHaveBeenCalledTimes(1);
    await resolve(FRESH);
  });

  it('is inert on a visibility block when there is no way to ask', async () => {
    const { onActivate } = renderChip({ gateBlock: GATE });
    const btn = screen.getByRole('button', { name: 'Go' });

    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-busy', 'false');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('hands recheck the very status the re-ask resolved to', async () => {
    const { reverify, resolve } = heldReverify();
    const { recheck } = renderChip({ reverify, gateBlock: GATE });
    const fresh = { ...FRESH };

    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await resolve(fresh);

    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck.mock.calls[0][0]).toBe(fresh);
  });

  it('renders a function child with whether the chip is blocked', () => {
    render(
      <GatedChip gateBlock={null} otherBlock={OTHER} idleTitle="t" recheck={() => true} onActivate={() => {}}>
        {(blocked) => (blocked ? 'blocked' : 'free')}
      </GatedChip>
    );
    expect(screen.getByRole('button', { name: 'blocked' })).toBeInTheDocument();
  });
});
