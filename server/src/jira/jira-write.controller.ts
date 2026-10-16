import { Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';
import { homedir } from 'node:os';

import type { JiraBoard } from '../../../shared/types';
import { SameOriginPostGuard } from '../agents/origin.guard';
import { JiraConfigUnreadableError, JiraUnknownIdError, deleteBoard, parseBoardWrite, parseReposWrite, writeBoard, writeRepos } from './config.util';
import { jiraEnv } from './env.util';
import { JiraPollerService } from './poller.service';

/**
 * The three write routes under `/api/jira` (Jira phase 2, spec §5 and §8) — `POST /boards`, `POST /boards/delete` and `POST /repos`, the only callers of the
 * writers in `config.util.ts`. They are POSTs (the app has no PUT or DELETE route anywhere) and each carries `SameOriginPostGuard`, the one guard every other
 * state-changing route here carries: `application/json` and a same-origin `Origin`, 403 otherwise. The Host allowlist is global and has already answered
 * before a handler runs.
 *
 * The order inside every handler is part of the contract and is the read controller's, extended by the write: guard → validate (400) → configured (503) →
 * write (404 / 409) → re-aim the poller. A malformed body is wrong whatever the environment, so it must not read as an environment problem; and an unconfigured
 * server never touches `jira.json`, so a probe of it creates no file. `parseBoardWrite` and `parseReposWrite` answer the 400's sentence — it names the field,
 * because the board sheet puts it under that field.
 *
 * Config writes are NOT gated on `access` (§8): saving a board while the credential is rejected (401) or the site is `unsupported` touches only `jira.json`,
 * so there is nothing to refuse, and a person whose token expired must still be able to fix their boards. Only the sweep that follows is affected, and it is
 * the poller's business to be a no-op there.
 *
 * Two failures are the writers' own and are mapped here, once: `JiraConfigUnreadableError` is a 409 carrying its message (the file exists, a person has to
 * repair it, and nothing was written — #270's refusal, restated for three writers), and `JiraUnknownIdError` is a 404 `unknown board`, the same sentence and
 * status the read route gives a malformed or absent id. Anything else the writer throws is an I/O failure and stays Nest's 500.
 *
 * After the write, the poller is re-aimed. A saved board awaits `boardSaved`, which sweeps THAT board and resolves when the sweep is done or after its
 * own `JIRA_SAVE_SWEEP_WAIT_MS` cap — it already races itself and never rejects, so this route adds no second timer. A deleted board drops its cache at once
 * (`boardDeleted`) and the poller is `arm()`ed so it re-judges whether anything is left to poll. A repos write re-aims nothing: no sweep reads `repos`.
 */
@Controller('api/jira')
export class JiraWriteController {
  constructor(private readonly poller: JiraPollerService) {}

  /** `POST /api/jira/boards` — create (no `id`) or update (`id`) a board; answers the board as stored, with the ids the server minted. */
  @Post('boards')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async saveBoard(@Body() body: unknown): Promise<JiraBoard> {
    const parsed = parseBoardWrite(body);
    if (!parsed.ok) throw new HttpException({ error: parsed.error }, 400);
    this.requireConfigured();
    const board = this.writing(() => writeBoard(parsed.value));
    await this.poller.boardSaved(board.id);
    return board;
  }

  /** `POST /api/jira/boards/delete` — `{ id }`. A board the file does not hold is the 404, a second delete of the same id included. */
  @Post('boards/delete')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  deleteBoard(@Body() body: unknown): { ok: true } {
    const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined;
    if (typeof id !== 'string' || id === '') throw new HttpException({ error: 'id must be a non-empty string' }, 400);
    this.requireConfigured();
    this.writing(() => deleteBoard(id));
    this.poller.boardDeleted(id);
    this.poller.arm();
    return { ok: true };
  }

  /** `POST /api/jira/repos` — `{ project, paths }`; the paths come back as stored (normalised, deduplicated), and `[]` removes the project's key. */
  @Post('repos')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  saveRepos(@Body() body: unknown): { project: string; paths: string[] } {
    const parsed = parseReposWrite(body, homedir());
    if (!parsed.ok) throw new HttpException({ error: parsed.error }, 400);
    this.requireConfigured();
    this.writing(() => writeRepos(parsed.value.project, parsed.value.paths));
    return parsed.value;
  }

  private requireConfigured(): void {
    if (!jiraEnv().configured) throw new HttpException({ error: 'Jira is not configured' }, 503);
  }

  /** Run a writer and map its two named refusals; every other throw propagates as Nest's 500. */
  private writing<T>(write: () => T): T {
    try {
      return write();
    } catch (err) {
      if (err instanceof JiraConfigUnreadableError) throw new HttpException({ error: err.message }, 409);
      if (err instanceof JiraUnknownIdError) throw new HttpException({ error: 'unknown board' }, 404);
      throw err;
    }
  }
}
