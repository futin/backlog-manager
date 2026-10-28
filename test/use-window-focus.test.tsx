/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';

import { useWindowFocus } from '../client/src/hooks/useWindowFocus';

/**
 * `useWindowFocus` (#376) is the one `focus` listener in `hooks/` — `useRefreshing`, `useTrackers` and `useJira` all subscribe through it — so its two
 * promises are pinned here directly: a focus calls the callback once, and an unmounted caller is never called again (a leaked listener would refetch
 * from a hook whose state no longer exists).
 */
function Probe({ onFocus }: { onFocus: () => void }): null {
  useWindowFocus(onFocus);
  return null;
}

describe('useWindowFocus', () => {
  it('calls the callback once per window focus, with no arguments', () => {
    const onFocus = jest.fn();
    render(<Probe onFocus={onFocus} />);
    window.dispatchEvent(new Event('focus'));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith();
  });

  it('calls nothing after unmount', () => {
    const onFocus = jest.fn();
    const { unmount } = render(<Probe onFocus={onFocus} />);
    unmount();
    window.dispatchEvent(new Event('focus'));
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('follows a new callback identity and drops the old one', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<Probe onFocus={first} />);
    rerender(<Probe onFocus={second} />);
    window.dispatchEvent(new Event('focus'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
