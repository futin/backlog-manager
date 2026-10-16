/**
 * sections.ts — what a section IS, and the one runtime list of them.
 *
 * This lived in `SideRail.tsx` until task-42, beside the rail's own `TABS`, and
 * moved here for a mechanical reason rather than a tidying one: the rail now
 * reads `useSettings`, and `lib/settings.ts` reads the section list to clamp
 * the `Opens on` preference, so the two files closed an import cycle. ES
 * imports hoist, so `settings.ts` ran before the rail's body and saw
 * `SECTIONS` as `undefined` — every suite that loaded the rail died on it.
 *
 * The cycle's real edge was `settings.ts` depending on a COMPONENT for a list
 * of section names (four then, five since Jira phase 2), which is the kind of dependency `lib/` exists to absorb.
 * With the list here, nothing about the arrangement that mattered changes: it
 * is still one home, still runtime-readable, and the rail still derives its own
 * tabs from it rather than restating them — `RAIL_LABEL` is a
 * `Record<Section, string>`, so a section added here cannot ship without a
 * label, which is the same guarantee the old derivation gave from the other
 * direction.
 *
 * "Board" rather than the "Projects" this tab shipped as, and rather than
 * "Tasks": a nav entry names a place, not a type, and the place holds bugs,
 * ideas and refactors alongside tasks. Narrowing to one project is a board
 * control and lives in the board toolbar, which is what made "Projects" the
 * wrong word for a section switch in the first place.
 *
 * The order is rail order, and the rail renders in it: Board's companions
 * first, with Runs seated between Board and Archive rather than after Settings
 * where a careless append would land it.
 *
 * `jira` (Jira phase 2, spec §6.1) sits between Archive and Settings for the same reason: it is about the work, and Settings — under its rule — is about the
 * board. It is a member here unconditionally, although the rail draws its row only while `GET /api/jira` says `configured: true`: `resolveSection` runs in a
 * `useState` initializer, before that answer exists, and a stored `jira` it refused would throw away the section a reader left on a configured machine. The
 * conditional half is the shell's — `App`'s hold-and-fall and `SideRail`'s row — never this list's.
 */
export const SECTIONS = ['board', 'runs', 'archive', 'jira', 'settings'] as const;

export type Section = (typeof SECTIONS)[number];
