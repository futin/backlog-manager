/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Marker } from '../client/src/components/ui/Marker';

describe('Marker', () => {
  it('is a bare word carrying its tone as a class', () => {
    render(<Marker tone="groomed">groomed</Marker>);

    const marker = screen.getByText('groomed');
    expect(marker.tagName).toBe('SPAN');
    expect(marker).toHaveClass('ui-marker', 'ui-marker-groomed');
  });

  it('lands each tone as its own class', () => {
    for (const tone of ['groomed', 'kind', 'done', 'stale'] as const) {
      const { unmount } = render(<Marker tone={tone}>x</Marker>);
      expect(screen.getByText('x')).toHaveClass(`ui-marker-${tone}`);
      unmount();
    }
  });
});
