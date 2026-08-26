export type Section = 'projects' | 'settings';

const TABS: { id: Section; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'settings', label: 'Settings' }
];

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/**
 * Top-level section switch: the backlog board · settings. A rail down the left
 * edge on desktop, a horizontal scroll strip below 700px.
 *
 * Ported from ../guide-manager/client/src/components/SideRail.tsx with its two
 * tabs relabelled. The class names are unchanged because the ported stylesheet
 * keys off them.
 *
 * Every tab is a plain section switch and nothing more, so no tab carries
 * `aria-expanded` — a button that only navigates must not announce a panel it
 * does not hold. Narrowing the board to one project belongs beside the board, in
 * the board toolbar, not in the switch that decides which section is showing.
 */
export function SideRail({ section, onChange }: Props) {
  return (
    <nav className="rail" aria-label="Sections">
      {/* the app's only wordmark */}
      <h1 className="rail-brand">
        <span className="rail-kicker">Backlog</span>
        <br />
        Manager
      </h1>
      {TABS.map(t => (
        <button
          key={t.id}
          className={section === t.id ? 'rail-link on' : 'rail-link'}
          aria-current={section === t.id ? 'page' : undefined}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
