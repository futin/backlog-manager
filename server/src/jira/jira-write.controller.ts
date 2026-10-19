import { Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';
import { homedir } from 'node:os';

import { isJiraKey } from '../../../shared/types';
import type { JiraBoard, JiraIssueWriteResult, JiraSkill } from '../../../shared/types';
import { SameOriginPostGuard } from '../agents/origin.guard';
import {
  JIRA_TRANSITION_ID_MAX_CHARS,
  JiraConfigUnreadableError,
  JiraUnknownIdError,
  deleteBoard,
  deleteSkill,
  parseBoardWrite,
  parseReposWrite,
  parseSkillWrite,
  writeBoard,
  writeRepos,
  writeSkill
} from './config.util';
import { jiraEnv } from './env.util';
import { JiraPollerService } from './poller.service';
import { jiraWriteOrThrow } from './unwrap.util';

/**
 * The seven write routes under `/api/jira` — five of them config writes (Jira phase 2, spec §5 and §8; the two skill routes, `POST /skills` and
 * `POST /skills/delete`, are phase 5's), `POST /boards`, `POST /boards/delete`, `POST /repos`, `POST /skills` and `POST /skills/delete`, the only callers of the
 * writers in `config.util.ts`, and two of them writes to JIRA itself (phase 3), `POST /issue/assign` and
 * `POST /issue/transition`, the first calls this server makes that change anything outside `~/.backlog-manager`. They are POSTs (the app has no PUT or DELETE route anywhere) and each carries `SameOriginPostGuard`, the one guard every other
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
 * repair it, and nothing was written — #270's refusal, restated for five writers), and `JiraUnknownIdError` is a 404 `unknown board` or `unknown skill` by the kind it carries (the board sentence and
 * status are the read route's for a malformed or absent id). Anything else the writer throws is an I/O failure and stays Nest's 500.
 *
 * The two issue writes differ from the config writes in what they are gated on, and the difference is deliberate (§8): they ARE refused while `access` is
 * `unauthorized`, and while the identity is unknown for an assign — those refusals live in the poller (`assignToMe` / `transitionIssue`, R2), which owns the
 * state, and arrive here as a failure to render, so a route cannot forget one. The route's own part is the order — guard → validate (400) → configured (503)
 * → the poller — and the mapping of what comes back, which is `jiraWriteOrThrow` (`unwrap.util.ts`, shared with `POST /api/agents/dispatch-jira`, whose two
 * writes are these two): a failure goes through `unwrapJira` (`jiraHttpError`, §8's table, `retryAt` verbatim, so a refusal inside a 429 window answers the
 * stored instant and slides nothing), and the poller's two refusals that are not a Jira response are its two sentences — `no identity` is a 503 (a state
 * that heals on the next successful `myself`), `transition not offered` a 400 (the caller's id is wrong, and Jira was never asked to judge it). The answer is `JiraIssueWriteResult` (R1): `reread: false` is still a 200 because the write landed and cannot be
 * un-happened.
 *
 * After a config write, the poller is re-aimed. A saved board awaits `boardSaved`, which sweeps THAT board and resolves when the sweep is done or after its
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

  /**
   * `POST /api/jira/skills` — create (no `id`) or update (`id`) a skill; answers the skill as stored, with the id the server minted. A config write like the
   * board's, minus the re-aim: no sweep reads a skill, so the poller is not told anything.
   */
  @Post('skills')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  saveSkill(@Body() body: unknown): JiraSkill {
    const parsed = parseSkillWrite(body);
    if (!parsed.ok) throw new HttpException({ error: parsed.error }, 400);
    this.requireConfigured();
    return this.writing(() => writeSkill(parsed.value));
  }

  /** `POST /api/jira/skills/delete` — `{ id }`. A skill the file does not hold is the 404 `unknown skill`, a second delete of the same id included. */
  @Post('skills/delete')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  deleteSkill(@Body() body: unknown): { ok: true } {
    const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined;
    if (typeof id !== 'string' || id === '') throw new HttpException({ error: 'id must be a non-empty string' }, 400);
    this.requireConfigured();
    this.writing(() => deleteSkill(id));
    return { ok: true };
  }

  /**
   * `POST /api/jira/issue/assign` — `{ key }`. Assigns the issue to the signed-in user; there is no way to name anyone else, because the accountId is the
   * poller's own `me` and a body carrying one is ignored. The key is validated before the 503 for the reason every handler here does: a malformed request is
   * wrong whatever the environment.
   */
  @Post('issue/assign')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async assignIssue(@Body() body: unknown): Promise<JiraIssueWriteResult> {
    const key = this.issueKey(body);
    this.requireConfigured();
    return jiraWriteOrThrow(await this.poller.assignToMe(key));
  }

  /**
   * `POST /api/jira/issue/transition` — `{ key, transitionId }`. `transitionId` is a non-empty string of at most 64 characters and nothing more is asked of
   * its shape (R3): the poller's check against a fresh transitions list is the real validation, and guessing Jira's id format here would one day refuse a
   * valid id. A number is refused, not coerced — the client sends the id Jira gave it, a string, and a number would be a caller that has not read the list.
   */
  @Post('issue/transition')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async transitionIssue(@Body() body: unknown): Promise<JiraIssueWriteResult> {
    const key = this.issueKey(body);
    const id = (body as Record<string, unknown>).transitionId;
    if (typeof id !== 'string' || id === '' || id.length > JIRA_TRANSITION_ID_MAX_CHARS) {
      throw new HttpException({ error: 'transitionId must be a non-empty string' }, 400);
    }
    this.requireConfigured();
    return jiraWriteOrThrow(await this.poller.transitionIssue(key, id));
  }

  /** The body's `key`, or the 400 every `:key` gets (`isJiraKey`, case-sensitive: the one shape that is safe to put into a path and a JQL). */
  private issueKey(body: unknown): string {
    const key = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).key : undefined;
    if (typeof key !== 'string' || !isJiraKey(key)) throw new HttpException({ error: 'invalid issue key' }, 400);
    return key;
  }

  private requireConfigured(): void {
    if (!jiraEnv().configured) throw new HttpException({ error: 'Jira is not configured' }, 503);
  }

  /** Run a writer and map its two named refusals (the 404 names the entry kind the error carries: `unknown board` or `unknown skill`); every other throw propagates as Nest's 500. */
  private writing<T>(write: () => T): T {
    try {
      return write();
    } catch (err) {
      if (err instanceof JiraConfigUnreadableError) throw new HttpException({ error: err.message }, 409);
      if (err instanceof JiraUnknownIdError) throw new HttpException({ error: `unknown ${err.kind}` }, 404);
      throw err;
    }
  }
}
