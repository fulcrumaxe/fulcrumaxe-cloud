import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RUN_EVENTS_REMINDER_START_DAYS,
  RUN_EVENTS_RETENTION_DAYS,
  retentionDaysFor,
} from '../../src/retention/runEvents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const OWNER_FILE = path.join(REPO_ROOT, 'packages', 'core', 'src', 'retention', 'runEvents.ts');

/** A line that spells a retention window as the number 90 (a comment, a name or a value near the word "retention"). */
export function spellsRetentionAs90(line: string): boolean {
  return /retention/i.test(line) && /(?<![\w.])90(?![\w.])/.test(line);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next', 'test', 'tests', 'fixtures', 'migrations'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('retention/runEvents (D#45 S8 criterion 1)', () => {
  it('exports the 90-day window, the day-30 reminder start, and a retentionDaysFor that returns 90', async () => {
    expect(RUN_EVENTS_RETENTION_DAYS).toBe(90);
    expect(RUN_EVENTS_REMINDER_START_DAYS).toBe(30);
    const client = { query: () => Promise.reject(new Error('the default window needs no query')) };
    expect(await retentionDaysFor(client, 'any-account')).toBe(90);
  });

  it('no other source file under packages/ or apps/ spells a retention window as 90', () => {
    const offenders: string[] = [];
    for (const root of ['packages', 'apps']) {
      for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
        if (file === OWNER_FILE) continue;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (spellsRetentionAs90(line)) offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan is not vacuous: it flags a redefinition and lets an unrelated 90 through', () => {
    expect(spellsRetentionAs90('const RUN_EVENTS_RETENTION_DAYS = 90;')).toBe(true);
    expect(spellsRetentionAs90('// keep events for 90 days (retention)')).toBe(true);
    expect(spellsRetentionAs90('const timeoutMs = 90;')).toBe(false);
    expect(spellsRetentionAs90('retention window is 900 days')).toBe(false);
  });
});
