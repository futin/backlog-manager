// client/src/components/board/ItemDrawer.tsx — replaced wholesale in Task 12
import type { BacklogItem } from '../../../../shared/types';

export function ItemDrawer({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  return (
    <aside className="drawer" role="dialog" aria-label={item.title}>
      <button className="drawer-close" onClick={onClose}>close</button>
    </aside>
  );
}
