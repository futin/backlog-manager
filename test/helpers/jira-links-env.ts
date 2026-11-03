import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fresh `BM_JIRA_LINKS_FILE` before every test (a `setupFilesAfterEnv` entry, so `beforeEach` exists). The link store is persisted, and a suite builds a new
 * `JiraLiveService` per case: with one file for the whole process the second case would load the first case's links. Registered before any suite hook, so a
 * suite that sets the variable itself in its own `beforeEach` still wins. The directory does not exist yet; `saveLinks` makes it.
 */
const base = mkdtempSync(join(tmpdir(), 'bm-jira-links-'));
let n = 0;

beforeEach(() => {
  process.env.BM_JIRA_LINKS_FILE = join(base, `case-${n++}`, 'jira-links.json');
});
