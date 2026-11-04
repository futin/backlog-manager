import { existsSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../atomic-write.util';
import { isJiraKey, parseJiraAction } from '../../../shared/types';
import type { JiraEndReason, JiraLink, JiraLinkHow } from '../../../shared/types';

/**
 * The link store's file (Jira sessions, spec §5): which Jira ticket each agent session is linked to, live and ended. File I/O only — load, save and the path;
 * every rule about WHAT is kept (the one-run gate, retention, the TTL) is `JiraLiveService`'s, which holds the state in memory and calls `saveLinks` after
 * each change.
 *
 * The server is the one writer, and the file is written whole and atomically — a temp file in the same directory, then `rename` — as `syncConfigFile`'s
 * writer does it. `BM_JIRA_LINKS_FILE` overrides the path, as `BM_JIRA_FILE` overrides `jira.json`'s.
 *
 * **An unreadable file is set aside, not refused.** `jira.json` is hand-authored and irreplaceable, so its writers refuse with a 409 for as long as it cannot
 * be read (`config.util.ts`). This file is machine-written history whose loss costs only past lines in the List; refusing would stop every Run from linking
 * for as long as someone had not tidied it by hand. So a file that does not parse, or whose `version` is not 1, loads as EMPTY (one warning), and the first
 * save renames it to `jira-links.json.bad-<ISO>` before writing a fresh one — never overwriting it silently, so a person can still read what was there. The
 * check is made at save time against what is on disk, so a boot that never changes anything leaves the bad file exactly where it was.
 *
 * The fallback is per ENTRY, one level finer, the way `readBoard` and `readSkill` fall back: an entry missing its key, its session id or a known `how` costs
 * only itself, with one warning, and the file is not set aside for it. The next save writes the survivors.
 */

/** The only schema version this code reads or writes. */
export const JIRA_LINKS_VERSION = 1;

/** A `(key, sessionId)` pair: the suppressed list and the never-link list both hold these. */
export interface JiraLinkPair {
  key: string;
  sessionId: string;
}

/** Everything the file holds. */
export interface JiraLinksState {
  links: JiraLink[];
  /** Pairs a person unlinked: detection never re-adds them (spec C9). */
  suppressed: JiraLinkPair[];
  /** Pairs Jira answered 404 for: detection never asks again (spec §5). */
  neverLink: JiraLinkPair[];
}

/** The file, or `BM_JIRA_LINKS_FILE` when set — `jiraConfigFile()`'s shape, `env` a parameter for the same reason. */
export function jiraLinksFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_JIRA_LINKS_FILE || join(homedir(), '.backlog-manager', 'jira-links.json');
}

const HOWS: readonly JiraLinkHow[] = ['run', 'branch', 'manual'];
const REASONS: readonly JiraEndReason[] = ['idle', 'stopped', 'expired', 'gone'];

const EMPTY = (): JiraLinksState => ({ links: [], suppressed: [], neverLink: [] });

type Read = { kind: 'missing' } | { kind: 'bad'; why: string } | { kind: 'ok'; state: JiraLinksState };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const parses = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** One persisted entry, or `null` when it is unusable. Required: a key, a session id, a known `how`, a start. Every other field falls back to its empty value. */
function readLink(raw: unknown, file: string, index: number): JiraLink | null {
  const drop = (why: string): null => {
    console.warn(`${file}: link #${index} ${why} — dropped, the rest load`);
    return null;
  };
  if (!isRecord(raw)) return drop('is not an object');
  if (!isJiraKey(raw.key)) return drop('has no valid key');
  const sessionId = str(raw.sessionId);
  if (sessionId === null || sessionId === '') return drop('has no session id');
  if (!HOWS.includes(raw.how as JiraLinkHow)) return drop('has no known `how`');
  if (!parses(raw.startedAt)) return drop('has no valid startedAt');
  if (raw.endedAt !== null && raw.endedAt !== undefined && !parses(raw.endedAt)) return drop('has an unreadable endedAt');
  const ended = typeof raw.endedAt === 'string';
  const snap = isRecord(raw.snapshot) ? raw.snapshot : {};
  const surface = raw.surface === 'desktop' || raw.surface === 'dashboard' ? raw.surface : null;
  return {
    key: raw.key,
    sessionId,
    how: raw.how as JiraLinkHow,
    action: parseJiraAction(raw.action),
    name: str(raw.name) ?? '',
    repo: str(raw.repo) ?? '',
    branch: str(raw.branch),
    surface,
    model: str(raw.model),
    effort: str(raw.effort),
    snapshot: { summary: str(snap.summary) ?? '', type: str(snap.type) ?? '', parentKey: str(snap.parentKey) },
    startedAt: raw.startedAt,
    endedAt: ended ? (raw.endedAt as string) : null,
    // An ended entry whose reason is unreadable still ended; `gone` is the one reason that claims nothing about what the session was doing.
    endReason: ended ? (REASONS.includes(raw.endReason as JiraEndReason) ? (raw.endReason as JiraEndReason) : 'gone') : null,
    quietSince: parses(raw.quietSince) ? raw.quietSince : null,
    reattachedAt: parses(raw.reattachedAt) ? raw.reattachedAt : null
  };
}

function readPairs(raw: unknown): JiraLinkPair[] {
  if (!Array.isArray(raw)) return [];
  const out: JiraLinkPair[] = [];
  for (const p of raw) if (isRecord(p) && isJiraKey(p.key) && typeof p.sessionId === 'string' && p.sessionId !== '') out.push({ key: p.key, sessionId: p.sessionId });
  return out;
}

function readFile(file: string): Read {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'bad', why: 'cannot be read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'bad', why: 'does not parse as JSON' };
  }
  if (!isRecord(raw)) return { kind: 'bad', why: 'is not a JSON object' };
  if (raw.version !== JIRA_LINKS_VERSION) return { kind: 'bad', why: `has version ${JSON.stringify(raw.version)}, not ${JIRA_LINKS_VERSION}` };
  if (!Array.isArray(raw.links)) return { kind: 'bad', why: 'has no links array' };
  const seen = new Set<string>();
  const links: JiraLink[] = [];
  raw.links.forEach((entry, i) => {
    const link = readLink(entry, file, i);
    if (link === null) return;
    const id = `${link.key}\n${link.sessionId}`;
    if (seen.has(id)) return; // the pair is the identity; the first wins
    seen.add(id);
    links.push(link);
  });
  return { kind: 'ok', state: { links, suppressed: readPairs(raw.suppressed), neverLink: readPairs(raw.neverLink) } };
}

/** The file's state; empty when it is missing or unusable (the latter with one warning — it is set aside at the first save, see the header). Never throws. */
export function loadLinks(): JiraLinksState {
  const file = jiraLinksFile();
  const read = readFile(file);
  if (read.kind === 'ok') return read.state;
  if (read.kind === 'bad') console.warn(`${file}: ${read.why} — starting with no links; the file is set aside at the first save`);
  return EMPTY();
}

/**
 * Writes the whole state: a bad file already on disk is first renamed to `jira-links.json.bad-<ISO>`, then the state goes through `writeJsonAtomic`. Throws on
 * an I/O failure — the caller decides that a link that could not be saved must not fail a launch.
 */
export function saveLinks(state: JiraLinksState): void {
  const file = jiraLinksFile();
  if (existsSync(file) && readFile(file).kind === 'bad') renameSync(file, `${file}.bad-${new Date().toISOString()}`);
  writeJsonAtomic(file, { version: JIRA_LINKS_VERSION, links: state.links, suppressed: state.suppressed, neverLink: state.neverLink });
}
