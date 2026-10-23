import { HttpException, Injectable } from '@nestjs/common';

import { EFFORTS, MODELS } from '../../../../shared/agent';
import type { DashboardEntry, DashboardsFile, DashboardsView, HomeEntry, SuggestStrategy } from '../../../../shared/types';
import { readAgentsConfig, type AgentsConfig } from '../config.util';
import {
  ACCOUNT_MAX,
  DashboardsFileUnreadable,
  DEFAULT_STRATEGY,
  DEFAULT_THRESHOLD,
  HOME_ID,
  LABEL_MAX,
  MAX_REMOTES,
  STRATEGIES,
  dashboardsFile,
  normaliseOrder,
  readDashboardsFile,
  subsetOf,
  tokenVar,
  validateEntry,
  writeDashboardsFile
} from './dashboards-file.util';

/**
 * One machine a launch can be sent to, as every later server task sees it: home (this machine, id `home`, the dashboard `BM_AGENTS_URL` names) or a remote (id =
 * its `name`). `cfg` is the AgentsConfig a call to that machine's dashboard is made THROUGH — the same shape every existing spawn/stop call already takes, so a
 * remote launch is the home launch with a different `cfg` and nothing else forked. `host` and `bmUrl` are a remote's only (home has neither: its claims carry
 * this machine's own identity and its board is this one). `models` / `efforts` are what that account can run, the whole list when the entry does not narrow it.
 */
export interface Machine {
  id: string;
  label: string;
  home: boolean;
  host: string | null;
  account: string | null;
  models: string[];
  efforts: string[];
  cfg: AgentsConfig;
  bmUrl: string | null;
}

const bad = (error: string): HttpException => new HttpException({ error }, 400);
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The machine list (spec 2026-10-22-multi-dashboard-design.md, "Settings" and "Left to the builder"), and the one place `dashboards.json` is edited from a
 * route. Every read is `readDashboardsFile()` per call and the token env var is read per call too — nothing here is cached, so a person hand-editing the file
 * or exporting a token is seen by the next request, and a test overriding either between cases needs no reset.
 *
 * Fail closed on an unreadable file: `machines()` is then home alone, so a typo in the file can only NARROW where work may go, never widen it, and every write
 * refuses with `DashboardsFileUnreadable` (the controller's 409) so the damaged text is never replaced by defaults.
 *
 * The reader silently DROPS a duplicate name and a ninth entry (a hand-edited file must not take its good rows down with it), which makes the write routes the
 * only place a person ever learns of either — so the upsert refuses both as a 400 and never writes such a file. Body checks that need nothing from the file run
 * BEFORE it is read (a malformed request is a 400 whatever state the file is in, as `tick.controller.ts` orders it); the ones that compare against the list run
 * after the unreadable check, because they cannot be answered without it.
 */
@Injectable()
export class DashboardsService {
  /** Home first, then the remotes in CONFIGURED order — prefer order is `settings().order`'s, applied by the offers, not here. */
  machines(env: NodeJS.ProcessEnv = process.env): Machine[] {
    const read = readDashboardsFile();
    const file = read.source === 'unreadable' ? null : read.value;
    const homeCfg = readAgentsConfig(env);
    const home: Machine = {
      id: HOME_ID,
      label: file?.home?.label ?? 'Home',
      home: true,
      host: null,
      account: file?.home?.account ?? null,
      models: file?.home?.models ?? [...MODELS],
      efforts: file?.home?.efforts ?? [...EFFORTS],
      cfg: homeCfg,
      bmUrl: null
    };
    const remotes: Machine[] = (file?.dashboards ?? []).map((d) => ({
      id: d.name,
      label: d.name,
      home: false,
      host: d.host,
      account: d.account ?? null,
      models: d.models ?? [...MODELS],
      efforts: d.efforts ?? [...EFFORTS],
      // A remote is enabled exactly when home is (`BM_AGENTS` is the one switch for the whole feature), and a missing token is data, not an error: the request
      // goes without `Authorization`, as home's does today when `BM_AGENTS_TOKEN` is unset. Trimmed like home's, so a stray newline in an export is no header.
      cfg: { enabled: homeCfg.enabled, url: d.url, token: (env[tokenVar(d.name)] ?? '').trim() },
      bmUrl: d.bmUrl
    }));
    return [home, ...remotes];
  }

  /** `undefined` and `home` (any case — the name is reserved in every case) are home; a remote is found by its exact id; anything else is `null`. */
  machine(id: string | undefined, env: NodeJS.ProcessEnv = process.env): Machine | null {
    const all = this.machines(env);
    if (id === undefined || id.toLowerCase() === HOME_ID) return all[0];
    return all.find((m) => !m.home && m.id === id) ?? null;
  }

  /** The remote whose claims carry `host`, exact match — how a stop after a restart finds the dashboard a session runs on. Never home (it has no `host`). */
  byHost(host: string | undefined, env: NodeJS.ProcessEnv = process.env): Machine | null {
    if (host === undefined) return null;
    return this.machines(env).find((m) => !m.home && m.host === host) ?? null;
  }

  /** The strategy, threshold and prefer order the suggestion reads; the defaults when the file is missing or unreadable. */
  settings(): { order: string[]; strategy: SuggestStrategy; threshold: number } {
    const read = readDashboardsFile();
    if (read.source === 'unreadable') return { order: [HOME_ID], strategy: DEFAULT_STRATEGY, threshold: DEFAULT_THRESHOLD };
    const { order, strategy, threshold } = read.value;
    return { order: order ?? [HOME_ID], strategy: strategy ?? DEFAULT_STRATEGY, threshold: threshold ?? DEFAULT_THRESHOLD };
  }

  /**
   * What Settings draws. URLs ride along (the card edits them); a token never does — only whether its env var is non-empty here. An unreadable file shows no
   * remotes, the same list `machines()` acts on, so the card never offers a row the server would refuse to use.
   */
  view(env: NodeJS.ProcessEnv = process.env): DashboardsView {
    const read = readDashboardsFile();
    const value: DashboardsFile = read.source === 'unreadable' ? { dashboards: [] } : read.value;
    const [home, ...remotes] = this.machines(env);
    const { order, strategy, threshold } = this.settings();
    return {
      source: read.source,
      file: dashboardsFile(env),
      home: {
        label: home.label,
        url: home.cfg.url,
        account: home.account,
        models: home.models,
        efforts: home.efforts,
        tokenVar: 'BM_AGENTS_TOKEN',
        tokenSet: home.cfg.token !== ''
      },
      dashboards: remotes.map((m, i) => ({
        ...(value.dashboards[i] as DashboardEntry),
        tokenVar: tokenVar(m.id),
        tokenSet: m.cfg.token !== '',
        models: m.models,
        efforts: m.efforts
      })),
      order,
      strategy,
      threshold
    };
  }

  /**
   * Upsert. An entry whose exact name exists is updated in place; `replaces` names the existing entry a rename takes over (same position, and its id in `order`
   * becomes the new name). A name that matches an existing entry in another case — or, on a rename, a DIFFERENT entry in any case — is a 400: names are machine
   * ids and, uppercased, token env vars, so two that differ only in case would share a token and be indistinguishable on the wire.
   */
  upsertEntry(body: unknown): DashboardsView {
    if (!isPlainObject(body)) throw bad('bad body');
    const entry = validateEntry(body.entry);
    if (typeof entry === 'string') throw bad(entry);
    const { replaces } = body;
    if (replaces !== undefined && replaces !== null && typeof replaces !== 'string') throw bad('replaces must be a string');
    return this.edit((cur) => {
      const list = cur.dashboards;
      const target = typeof replaces === 'string' ? replaces : entry.name;
      const at = list.findIndex((d) => d.name === target);
      if (typeof replaces === 'string' && at < 0) throw new HttpException({ error: `no dashboard named "${replaces}"` }, 404);
      // The clash test skips the entry being replaced or updated: `Pro` → `PRO` is that entry changing case, not a second one.
      if (list.some((d, i) => i !== at && d.name.toLowerCase() === entry.name.toLowerCase())) throw bad(`a dashboard named "${entry.name}" already exists`);
      if (at < 0 && list.length >= MAX_REMOTES) throw bad(`at most ${MAX_REMOTES} dashboards`);
      const dashboards = at < 0 ? [...list, entry] : list.map((d, i) => (i === at ? entry : d));
      const order = (cur.order ?? []).map((id) => (at >= 0 && id === list[at].name ? entry.name : id));
      return {
        ...cur,
        dashboards,
        order: normaliseOrder(
          order,
          dashboards.map((d) => d.name)
        )
      };
    });
  }

  /** Drops the entry and its id in `order`. An unknown name is a 404 — the card only offers a delete for a row it drew. */
  deleteEntry(body: unknown): DashboardsView {
    if (!isPlainObject(body)) throw bad('bad body');
    const { name } = body;
    if (typeof name !== 'string') throw bad('name must be a string');
    return this.edit((cur) => {
      if (!cur.dashboards.some((d) => d.name === name)) throw new HttpException({ error: `no dashboard named "${name}"` }, 404);
      const dashboards = cur.dashboards.filter((d) => d.name !== name);
      return {
        ...cur,
        dashboards,
        order: normaliseOrder(
          cur.order,
          dashboards.map((d) => d.name)
        )
      };
    });
  }

  /**
   * Home's presentation, as a patch: an omitted key keeps what is stored, `null` clears it back to its default, anything else must pass the rule the reader
   * applies to the same key in a file (`normaliseHome`). `account: ''` clears too — a form that empties the field sends the empty string.
   */
  setHome(body: unknown): DashboardsView {
    if (!isPlainObject(body)) throw bad('bad body');
    const patch: Partial<Record<keyof HomeEntry, HomeEntry[keyof HomeEntry] | null>> = {};
    if (body.label !== undefined) {
      const label = body.label === null ? null : typeof body.label === 'string' ? body.label.trim() : '';
      if (label !== null && (label.length < 1 || label.length > LABEL_MAX)) throw bad(`label must be 1–${LABEL_MAX} characters`);
      patch.label = label;
    }
    if (body.account !== undefined) {
      if (body.account !== null && typeof body.account !== 'string') throw bad('account must be a string');
      const account = body.account === null ? null : body.account.trim();
      if (account !== null && account.length > ACCOUNT_MAX) throw bad(`account must be at most ${ACCOUNT_MAX} characters`);
      patch.account = account || null;
    }
    if (body.models !== undefined) {
      const models = body.models === null ? null : subsetOf(body.models, MODELS);
      if (body.models !== null && !models) throw bad(`models must be a non-empty subset of ${MODELS.join(', ')}`);
      patch.models = models;
    }
    if (body.efforts !== undefined) {
      const efforts = body.efforts === null ? null : subsetOf(body.efforts, EFFORTS);
      if (body.efforts !== null && !efforts) throw bad(`efforts must be a non-empty subset of ${EFFORTS.join(', ')}`);
      patch.efforts = efforts;
    }
    return this.edit((cur) => {
      const home: Record<string, unknown> = { ...cur.home };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete home[key];
        else home[key] = value;
      }
      const next: DashboardsFile = { ...cur };
      if (Object.keys(home).length) next.home = home as HomeEntry;
      else delete next.home;
      return next;
    });
  }

  /**
   * Strategy, threshold and prefer order. Every one is a 400 when malformed rather than repaired — the file reader's clamp is for a hand edit, and an
   * out-of-range number from a client is a bug to show, not to hide. `order` must name every configured machine, `home` included, exactly once, so a saved
   * order is always complete and the reader's append-what-is-missing repair is never what a person's arrangement depends on.
   */
  setSettings(body: unknown): DashboardsView {
    if (!isPlainObject(body)) throw bad('bad body');
    const { strategy, threshold, order } = body;
    if (strategy !== undefined && (typeof strategy !== 'string' || !STRATEGIES.includes(strategy)))
      throw bad(`strategy must be one of ${STRATEGIES.join(', ')}`);
    if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1 || threshold > 100))
      throw bad('threshold must be an integer 1–100');
    if (order !== undefined && (!Array.isArray(order) || order.some((id) => typeof id !== 'string')))
      throw bad('order must list configured machines once each');
    return this.edit((cur) => {
      const next: DashboardsFile = { ...cur };
      if (strategy !== undefined) next.strategy = strategy as SuggestStrategy;
      if (threshold !== undefined) next.threshold = threshold;
      if (order !== undefined) {
        const ids = [HOME_ID, ...cur.dashboards.map((d) => d.name)];
        const ok = order.length === ids.length && ids.every((id) => order.includes(id));
        if (!ok) throw bad('order must list configured machines once each');
        next.order = order as string[];
      }
      return next;
    });
  }

  // The one write path: read the file as it is NOW (an unreadable one refuses, naming the file), let `mutate` produce the next value or throw its 400/404, write
  // it, and answer the fresh view so the card draws the server's value and not an optimistic one.
  private edit(mutate: (cur: DashboardsFile) => DashboardsFile): DashboardsView {
    const read = readDashboardsFile();
    if (read.source === 'unreadable') throw new DashboardsFileUnreadable(dashboardsFile(), read.reason);
    writeDashboardsFile(mutate(read.value));
    return this.view();
  }
}
