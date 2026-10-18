import { Injectable } from '@nestjs/common';
import { createReleasesReader, findRepoRoot } from 'release-kit';

import type { ReleasesResponse } from '../../../shared/types';
import { runGit } from '../git-run.util';

/**
 * releases.service.ts — `GET /api/releases`: this app's own release history, read from its own checkout's annotated `vX.Y.Z` tags, which the release
 * workflow cuts on every releasing merge into `main` (docs/workflows/ci.md §Releases, docs/subsystems/releases.md).
 *
 * The whole read — tag filters, ordering, the GitHub-remote regex, `describe`, the memo — is release-kit's `createReleasesReader` (spec D3). What this
 * server keeps is the one rule release-kit cannot know about: every git read is `runGit`, async and bounded at 10 s, so a slow disk degrades one route
 * instead of hanging it. The reader takes a git PORT for exactly that, and the memo key's `rev-parse` goes through the same port as the read itself, so
 * nothing this route does launches git any other way (`test/api-releases.test.ts` pins it).
 *
 * Failure degrades per read, never as an error status: `for-each-ref` failing is the empty shape, `describe` failing is `current: null` with the releases
 * kept, `remote get-url` failing only drops `url`. An incomplete answer — either of the first two — is answered but never memoised, so one timeout cannot
 * hide the chip until HEAD or a tag next moves. The memo is this service's own and shares nothing with the items memo or the `uncommitted` read (which is
 * memoised nowhere, by rule).
 */

/** Re-exported for `test/api-releases.test.ts`, which pins the `.git`-FILE case a server started inside a linked worktree depends on. */
export { findRepoRoot };

/**
 * The checkout whose tags are read: `BM_RELEASES_ROOT` when set (the test seam, read per request like `BM_REGISTRY_FILE` and `BM_ORCH_HOME`), else this
 * server's own checkout, found from its own files — never `process.cwd()`, which is wherever the server happened to be started. In the compose stack that
 * is `/app`, the bind-mounted checkout with its `.git`.
 */
export function releasesRoot(): string | null {
  return process.env.BM_RELEASES_ROOT || findRepoRoot(__dirname);
}

@Injectable()
export class ReleasesService {
  // A closure over `runGit` rather than `runGit` itself: the reader keeps the function it is handed, and calling through the import on every launch is
  // what lets a test's `jest.spyOn(gitRun, 'runGit')` — installed long after this provider was built — see each one.
  private readonly reader = createReleasesReader({ root: releasesRoot, git: (args, o) => runGit(args, o) });

  read(): Promise<ReleasesResponse> {
    return this.reader.read();
  }
}
