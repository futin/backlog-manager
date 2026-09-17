import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which source owns one registered project's items, answered from the project's
 * own committed marker — `backlog/source.json` — and nothing else (task-43,
 * spec §3.2 of docs/superpowers/specs/2026-09-17-tracker-backed-backlog-design.md).
 *
 * Read per request, never cached: one `existsSync`, one `readFileSync`, one
 * `JSON.parse` per call. That is deliberately the same cost class — and the
 * same rule — as the registry's own read, which CLAUDE.md states outright:
 * "The server re-reads it per request, never writes, never caches." The
 * question this file answers moves for exactly the same reasons the registry
 * moves (someone connected a project, someone edited a file on disk mid
 * session), so a cache here would go stale on the same events and buy a few
 * microseconds against a scan that is about to read hundreds of files anyway.
 *
 * Marker file, not a per-machine setting, because source is a property of the
 * PROJECT and not of the laptop reading it (spec §2.3): every clone of a
 * connected repo agrees about who owns its items, and a machine that has never
 * heard of the tracker still knows not to show the files.
 *
 * Nothing here throws. Every failure this function can meet — a marker that is
 * a directory, bytes that are not JSON, a kind no adapter serves — is a
 * property of one project's disk, and a board that 500s because one of five
 * registered projects has a typo in one file is a worse answer than a board
 * that renders the other four and reports the fifth.
 */

/** The one spelling of the marker's file name, relative to `backlog/`. */
export const SOURCE_MARKER = 'source.json';

/**
 * The marker's parsed contents. `kind` is the only key this resolver reads or
 * validates; everything else (`repo` for GitHub, a site and project key for
 * Jira) is the ADAPTER's to validate, because only the adapter knows what its
 * own kind requires. Resolving and validating are two jobs, and a resolver
 * that knew every adapter's schema would have to change for every adapter.
 */
export interface SourceMarker {
  kind: string;
  [key: string]: unknown;
}

/**
 * The four answers, as a discriminated union so a caller cannot forget one:
 *
 * - `missing` — no `backlog/` directory at all. Today's behaviour, unchanged:
 *   the index skips the project and `/api/projects` reports it.
 * - `files` — the scanner owns this project's items. Either there is no marker
 *   (the implicit case, which is every project on this machine today) or the
 *   marker says so explicitly.
 * - `tracker` — a marker naming a kind the caller registered an adapter for.
 *   The parsed marker travels with it: the adapter reads its repo off it.
 * - `unsupported` — a marker IS present and cannot be honoured. `reason` is a
 *   human sentence, already prefixed with the marker's absolute path.
 */
export type ResolvedSource =
  | { kind: 'missing' }
  | { kind: 'files' }
  | { kind: 'tracker'; marker: SourceMarker }
  | { kind: 'unsupported'; reason: string };

/**
 * `known` is the set of kinds the CALLER has adapters for, passed in rather
 * than imported, so this function stays a pure read over the filesystem with
 * no knowledge of Nest, of the adapter registry, or of which build it is in.
 * `files` is never required to be in it: it is the implicit source, and
 * refusing an explicit `{"kind":"files"}` because nobody registered it would
 * make writing the marker down worse than leaving it out.
 */
export function resolveSource(projectPath: string, known: ReadonlySet<string>): ResolvedSource {
  const backlog = join(projectPath, 'backlog');
  if (!existsSync(backlog)) return { kind: 'missing' };

  const marker = join(backlog, SOURCE_MARKER);
  if (!existsSync(marker)) return { kind: 'files' };

  let text: string;
  try {
    text = readFileSync(marker, 'utf8');
  } catch (e) {
    // A DIRECTORY named source.json passes existsSync and throws EISDIR here;
    // an unreadable one throws EACCES. Both are "there is a marker and I
    // cannot read it", which is precisely the case that must not fall back to
    // files: something put a file there on purpose.
    return { kind: 'unsupported', reason: `${marker}: cannot be read (${e instanceof Error ? e.message : String(e)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { kind: 'unsupported', reason: `${marker}: invalid JSON (${e instanceof Error ? e.message : String(e)})` };
  }

  // `typeof null === 'object'` and an array is an object too, so both are
  // ruled out explicitly before the key is read.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unsupported', reason: `${marker}: expected an object with a string "kind"` };
  }
  const kind = (parsed as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    return { kind: 'unsupported', reason: `${marker}: expected an object with a string "kind"` };
  }

  if (kind === 'files') return { kind: 'files' };
  if (known.has(kind)) return { kind: 'tracker', marker: parsed as SourceMarker };

  // The load-bearing negative: an unknown kind is NOT files. A tracker project
  // whose marker this build cannot honour would otherwise render whatever
  // stale files a clone still carries, as ghosts beside the real items on
  // another machine's board.
  return { kind: 'unsupported', reason: `${marker}: unsupported source kind "${kind}"` };
}
