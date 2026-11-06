import { Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';
import { homedir } from 'node:os';

import { isJiraKey } from '../../../shared/types';
import type { JiraBoard, JiraIssueWriteResult, JiraRepoDefaultsWriteResult, JiraSkill, JiraStatusPayload } from '../../../shared/types';
import { SameOriginPostGuard } from '../agents/origin.guard';
import {
  JIRA_TRANSITION_ID_MAX_CHARS,
  JiraConfigUnreadableError,
  JiraUnknownIdError,
  deleteBoard,
  deleteSkill,
  jiraConfigFile,
  parseBoardWrite,
  parseRepoDefaultsWrite,
  parseReposWrite,
  readJiraConfig,
  parseSkillWrite,
  writeBoard,
  writeRepoDefaults,
  writeRepos,
  writeSkill
} from './config.util';
import { jiraEnv } from './env.util';
import { JiraLiveService } from './live.service';
import { JiraPollerService } from './poller.service';
import { jiraWriteOrThrow } from './unwrap.util';

/**
 * The nine POST routes under `/api/jira` — `POST /boards/sweep` (the chip's per-board `now`, which writes nothing and asks the poller for a board save's
 * sweep), and eight write routes, six of them config writes (Jira phase 2, spec §5 and §8; the two skill routes, `POST /skills` and
 * `POST /skills/delete`, are phase 5's, and `POST /repo-defaults` the repo/branch work's), `POST /boards`, `POST /boards/delete`, `POST /repos`,
 * `POST /repo-defaults`, `POST /skills` and `POST /skills/delete`, the only callers of the
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
 * repair it, and nothing was written — #270's refusal, restated for six writers), and `JiraUnknownIdError` is a 404 `unknown board` or `unknown skill` by the kind it carries (the board sentence and
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
 * (`boardDeleted`) and the poller is `arm()`ed so it re-judges whether anything is left to poll. A repos or repo-defaults write re-aims the poller at nothing: no sweep reads
 * either. A repos write does tell `JiraLiveService` (`reposChanged`), so the session reconciler in `agents/` arms and branch detection starts without a restart.
 */
@Controller('api/jira')
export class JiraWriteController {
  constructor(
    private readonly poller: JiraPollerService,
    private readonly live: JiraLiveService
  ) {}

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

  /**
   * `POST /api/jira/sweep` — the popover head's site-wide `Sync now`. No body is read and no target taken (the per-board button is `boards/sweep`, below).
   * Guard → `sweepNow`: `not-armed` is a 409, a 429 window a 429 carrying the stored end, anything else a 200 with the same payload `GET /api/jira` answers,
   * `live` filled from the live map so the client can replace its cache with it. A 401, a 5xx or a transport failure inside the sweep is the poller's to
   * record (`access`, `detail`) and is a 200 here: the request itself worked.
   */
  @Post('sweep')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async sweepSite(): Promise<JiraStatusPayload> {
    const result = await this.poller.sweepNow();
    if (result.kind === 'not-armed') throw new HttpException({ message: 'Jira is not being polled' }, 409);
    if (result.kind === 'wait') throw new HttpException({ message: 'rate limited', retryAt: new Date(result.retryAt).toISOString() }, 429);
    const status = this.poller.status();
    return status.configured ? { ...status, live: this.live.snapshot() } : status;
  }

  /**
   * `POST /api/jira/boards/sweep` — `{ id }`: the chip popover's per-board `now` button. It writes nothing — not `jira.json`, not Jira — and asks the poller
   * for exactly what a board save asks for after its write: `boardSaved`, which forces THAT board due, sweeps it, and resolves when a sweep including it has
   * finished or after `JIRA_SAVE_SWEEP_WAIT_MS`. Reusing it rather than adding a second "sweep now" path is the point: the `forced` generation is the one
   * mechanism that survives a sweep already in flight (that sweep read the file before the ask), a 401, a 5xx or an opened 429 window — the board simply
   * stays owed and the next tick pays it — so a click inside a 429 window spends no call and is not refused; the status the client re-reads says why.
   *
   * The order is the config writes': guard → validate (400) → configured (503) → then the file must be readable (409, the writers' sentence — a board the
   * file cannot list is not one this route can name) and must hold the id (404 `unknown board`, the read route's words). An `off` board is swept too: a
   * manual-only board is the one a `now` exists for.
   */
  @Post('boards/sweep')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  async sweepBoard(@Body() body: unknown): Promise<{ ok: true }> {
    const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).id : undefined;
    if (typeof id !== 'string' || id === '') throw new HttpException({ error: 'id must be a non-empty string' }, 400);
    this.requireConfigured();
    const config = readJiraConfig();
    if (config.unreadable !== null) throw new HttpException({ error: new JiraConfigUnreadableError(jiraConfigFile(), config.unreadable).message }, 409);
    if (!config.boards.some((b) => b.id === id)) throw new HttpException({ error: 'unknown board' }, 404);
    await this.poller.boardSaved(id);
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
    // The one re-aim a repos write has: detection (agents/) runs only while a repo is mapped, so a mapping made now must arm it. Through the live service's
    // listener hook, because jira/ never imports agents/.
    this.live.reposChanged();
    return parsed.value;
  }

  /**
   * `POST /api/jira/repo-defaults` — `{ path, base, namePattern }`, `null` meaning unset; both `null` deletes the path's entry. Answers `{ path, base,
   * namePattern }` as stored (the path normalised, `null` for unset). The order is the file's usual one with one addition: guard → validate (400) → configured
   * (503) → `jira.json` readable (409) → the path mapped to SOME project (400 `<path> is not mapped`) → write. The mapping check needs the file, so it sits
   * after the 503 and after the 409 — an unreadable file cannot say what is mapped, so it answers the refusal a person can act on, with the file untouched —
   * and it quotes the NORMALISED path, which is what the client got from the status payload. The defaults are per path, so any project's mapping will do, as on
   * `/refs`; it keeps the file from collecting entries for paths nobody can reach. No re-aim: no sweep reads `repoDefaults`.
   */
  @Post('repo-defaults')
  @HttpCode(200)
  @UseGuards(SameOriginPostGuard)
  saveRepoDefaults(@Body() body: unknown): JiraRepoDefaultsWriteResult {
    const parsed = parseRepoDefaultsWrite(body, homedir());
    if (!parsed.ok) throw new HttpException({ error: parsed.error }, 400);
    this.requireConfigured();
    const { path, base, namePattern } = parsed.value;
    const config = readJiraConfig();
    if (config.unreadable !== null) throw new HttpException({ error: new JiraConfigUnreadableError(jiraConfigFile(), config.unreadable).message }, 409);
    if (!Object.values(config.repos).some((paths) => paths.includes(path))) throw new HttpException({ error: `${path} is not mapped` }, 400);
    this.writing(() => writeRepoDefaults(path, { ...(base !== null && { base }), ...(namePattern !== null && { namePattern }) }));
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
