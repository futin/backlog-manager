# Releases

The board shows its own release history: a version chip at the foot of the side rail, and behind it a **What's new** drawer listing every release, newest
first. The record is the checkout's annotated `vX.Y.Z` tags, which the release workflow cuts on every releasing merge into `main`
([ci](../workflows/ci.md) §Releases). Design: [the release versioning spec](../superpowers/specs/2026-10-16-release-versioning-design.md), which adopts the
dashboard's release pipeline and its chip and drawer; the look is `.claude/DESIGN.md` §8.7 (the drawer shell) and §8.10.

Code: `server/src/releases/` (the route, and the service wiring release-kit's reader to `runGit`), `client/src/components/ReleasesDrawer.tsx` (the wrapper
over ui-kit's drawer), the chip in `SideRail.tsx`, the wiring in `AppShell` (`App.tsx`). Since #298 every decision the chip and drawer make — the label, the
dot, the fetch, the drawer's shell and markup — is `ui-kit`'s (`github:futin/ui-kit`, `useWhatsNew`, `VersionChip`, `ReleasesDrawer`); this repo keeps the
Escape stack, the phone reading and the notes renderer, and themes the kit through the `--uk-*` block in `styles.css`.

## `GET /api/releases`

Answers `ReleasesResponse` (`shared/types.ts`): `current` is the newest release tag reachable from HEAD and how many commits HEAD is past it, `releases`
every release tag, newest first. Read-only and git only — not one of the outbound-calling modules. A tag with no `Release-Type` trailer is the
**baseline**: where numbering starts, not a release of anything. Lightweight tags and names that are not exactly `vX.Y.Z` are ignored.

**The reader is release-kit's.** [release-kit](https://github.com/futin/release-kit)'s `createReleasesReader` (since `v1.2.0`) owns the filters, the
ordering, the GitHub-remote pattern and the memo below; `findRepoRoot` is its too. The service hands it one thing, `runGit` as the git port, because this
server's rule is that every git read is `runGit` — async, bounded at 10 s ([invariants](invariants.md#the-server-never-spawns-git-synchronously-in-a-request-path))
— and release-kit's default port is its own `execFile`. The memo key's `rev-parse` goes through the same port, so all four reads do, and
`test/api-releases.test.ts` pins it.

**The root.** `BM_RELEASES_ROOT` when set (the test seam), else the first ancestor of the server's own files holding a `.git` entry — a directory in a main
checkout, a file in a linked worktree. Never `process.cwd()`. In the compose stack that is `/app`, the bind-mounted checkout.

**Failure is a shape.** Always 200. `for-each-ref` failing (or a folder that is not a checkout, or one with no tags) is `{ current: null, releases: [] }`;
`describe` failing — or no release tag reachable from HEAD, a branch cut before the baseline — is `current: null` with the releases kept; `remote get-url`
failing, or an origin not on GitHub, only drops each release's `url`.

**The memo.** One read per change, not per request. The key is HEAD plus the mtimes of `packed-refs` and `refs/tags` under the **common** git dir
(`git rev-parse HEAD --git-common-dir`):

- HEAD alone is not enough: a tag fetched or cut by hand moves no HEAD, and the release workflow tags `main` after the merge you already pulled.
- The common dir, not `--git-dir`: in a linked worktree the worktree's own dir holds no tags, so a tag cut from the main checkout would never move the key.
- `refs/tags` changes when a loose tag is added or removed, `packed-refs` when `git pack-refs` or `git gc` moves tags into it.

A key git cannot produce is never memoised, and neither is an answer in which `for-each-ref` or `describe` failed, so one timeout cannot hide the chip until
HEAD or a tag next moves. Concurrent requests under one key share one read. The memo is its own: it shares nothing with the items memo, nor with the
`uncommitted` read, which is memoised nowhere by rule.

## The chip

`v0.3.0`, or `v0.3.0+2` when HEAD is two commits past the tag (ui-kit's `chipLabel`). No chip at all when `current` is null — which is what a checkout without
the baseline tag shows. It is the rail's last element, sunk to its foot, and the last row of the phone menu, where tapping it closes the menu as every rail
entry does.

**The dot.** A cyan dot sits in the chip while the newest release (the baseline counts) is above the version stored under `localStorage`
`backlog-manager.releases-last-seen` — a raw version string, not JSON. Opening the drawer stores the newest, and keeps storing whatever is newest while it is
open — but never a version below the stored one, so opening the drawer on an older checkout does not re-flag the releases it has not got. A first visit, or a stored value that is not a version, seeds the newest without showing the dot (ui-kit's `dotState`), so a fresh browser never flags the whole
history as new. Storage that throws (a private window, blocked site data) means no dot, never a crash: `AppShell` mirrors the value in memory, so the seed it
could not write still settles the dot. A per-browser convenience, not a record.

## The drawer

Opened from the chip, which refetches first; the list is also fetched once on load. There is no poll — a new release reaches the server only when someone
pulls or fetches tags and restarts it, and the chip is rarely looked at. A fetch that fails, or answers something that is not the releases shape, keeps the
last good answer. Each entry: version, type badge (Feature / Fix / Performance), a separate Breaking badge, date, the title without its `type(scope)!: `
prefix (the badge already says it), the notes through the sanitising Markdown renderer when there are any, and `PR #N` when the origin is on GitHub. The
baseline renders as a divider: `Versioning starts here · v0.1.0` and its date.

ui-kit's `Drawer` is the shell: a 400 px right-hand panel over the scrim, full screen under 700 px (`narrow`, which the wrapper sets from `useNarrow()` — the
kit's CSS has no media queries). Escape, the ✕ and a scrim click close it; Escape through `useDialogEscape`, never the kit's own listener, which the wrapper
turns off with `closeOnEscape={false}`. It is the sixth dialog on the Escape stack
([invariants](invariants.md#escape-has-one-owner-and-the-topmost-dialog-is-the-only-one-that-closes)) and stacks above the modal and the sheet, because it can
open over either. It is rendered in `AppShell`, outside the rail: the phone rail hides itself with a `transform`, which makes it the containing block of any
`position: fixed` child, so a drawer inside it would be clipped to the rail.

Badge colours are each status token on a 14 % tint of its own over `--strip`, mapped onto ui-kit's `--uk-feat-*`, `--uk-fix-*`, `--uk-perf-*` and
`--uk-breaking-*` in `styles.css`. The notes go through this repo's sanitising `renderMarkdown`, passed as `renderNotes`, not the kit's escape-first default —
so `###` headings still render.

## What is not here

No `git fetch` (the server reads only what the checkout already has), no GitHub API call, no `package.json` version — and `plugin.json`'s version is
bumped by hand, separately, for the plugin. The GitHub Release pages are written by the release workflow and are not read back.

<!-- docs-sync:
  sources:
    - server/src/releases
    - shared/types.ts
    - client/src/components/ReleasesDrawer.tsx
    - client/src/components/SideRail.tsx
    - client/src/App.tsx
  kind: subsystem
  verified: ce41a287e78746f99d78dc8f5758ac2036064f20
-->
