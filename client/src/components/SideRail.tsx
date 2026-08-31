/**
 * The rail's tabs, in rail order — and the one definition of what a section is.
 *
 * "Board" rather than the "Projects" this tab shipped as, and rather than
 * "Tasks": a nav entry names a place, not a type, and the place holds bugs,
 * ideas and refactors alongside tasks. Narrowing to one project is a board
 * control and lives in the board toolbar, which is what made "Projects" the
 * wrong word for a section switch in the first place.
 *
 * `as const` so `Section` can be derived from it below. Everything that needs
 * to *check* a value against the list — `resolveSection` in App.tsx, guarding
 * a stored section that outlived the build that wrote it, and `LANDINGS` in
 * lib/settings.ts, clamping the "Opens on" preference — reads `SECTIONS` from
 * here instead of hand-copying the names. A type union alone has no runtime
 * members to iterate, which is why those two used to carry duplicates of this
 * list that could silently fall out of step with the rail.
 */
const TABS = [
  { id: 'board', label: 'Board' },
  { id: 'archive', label: 'Archive' },
  { id: 'settings', label: 'Settings' }
] as const;

export type Section = (typeof TABS)[number]['id'];

/** Every section id, runtime-readable. Derived, so the rail cannot drift from it. */
export const SECTIONS: readonly Section[] = TABS.map((t) => t.id);

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/**
 * Top-level section switch: board · archive · settings. A rail down the left
 * edge on desktop, a horizontal scroll strip below 700px.
 *
 * Ported from ../guide-manager/client/src/components/SideRail.tsx with its
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
