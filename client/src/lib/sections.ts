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
 * The order is rail order, and the rail renders in it.
 *
 * `files` and `github` (source-sections spec) replaced the root `board` and `archive` rows: Board and Archive are now PAGES under each source row, because a
 * board that mixed a files project's cards with a GitHub project's issues gave the two different write paths, different freshness and different controls
 * one undifferentiated surface, and the source a card came from was the first thing a reader had to work out. A source row is a member here
 * unconditionally, although the rail draws it only while the shell's projects answer says that source owns a project — the same split `jira` has, for the
 * same reason: the stored section is read in a `useState` initializer, before any answer exists. The conditional half is the shell's (`App`'s settle and
 * hold-and-fall, `SideRail`'s row). A stored `board`/`archive` from before this change is no longer a section; `resolveLegacySection`
 * (`lib/source-page.ts`) is the one place that reads it.
 *
 * `jira` (Jira phase 2, spec §6.1) sits between the sources and Runs: it is about the work, and Settings — under its rule — is about the board. It is a
 * member here unconditionally, although the rail draws its row only while `GET /api/jira` says `configured: true`: the stored section is read in a
 * `useState` initializer, before that answer exists, and a stored `jira` it refused would throw away the section a reader left on a configured machine.
 * The conditional half is the shell's — `App`'s hold-and-fall and `SideRail`'s row — never this list's.
 */
export const SECTIONS = ['files', 'github', 'jira', 'runs', 'settings'] as const;

export type Section = (typeof SECTIONS)[number];
