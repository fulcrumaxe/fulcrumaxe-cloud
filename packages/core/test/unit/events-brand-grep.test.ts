import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_SRC_DIR = path.join(__dirname, '..', '..', 'src', 'events');

/**
 * D#2 H11 criterion 6, kept for H11 by D#31 comment 18494573 (C5) and
 * extended by D#37 (comment 18493337, "The 'Claude Code' rule"): the
 * build fails on any match of `/claude[\s_\-. ]*code/i`, case
 * insensitively, including separator variants -- no exceptions. H11 no
 * longer ships any UI (that criterion moved to D#37 WS-F2), so this
 * scopes the same pattern to the one thing H11 does ship:
 * `packages/core/src/events/**`. Same pattern the (since archived) marketing
 * site branding test (H25) proved against rendered HTML -- this
 * is the source-scan half.
 */
const CLAUDE_CODE_PATTERN = /claude[\s_\-. ]*code/i;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('no "Claude Code" string in packages/core/src/events (D#2 H11 criterion 6)', () => {
  const files = listFiles(EVENTS_SRC_DIR);

  it('scanned at least the files this test knows about (guards against an empty/miscounted scan)', () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of listFiles(EVENTS_SRC_DIR)) {
    const relative = path.relative(EVENTS_SRC_DIR, file);
    it(`${relative} has no /claude[\\s_\\-. ]*code/i match`, () => {
      const contents = readFileSync(file, 'utf8');
      const match = CLAUDE_CODE_PATTERN.exec(contents);
      expect(match, `${relative} matches: ${match?.[0]}`).toBeNull();
    });
  }

  it('the pattern itself goes red on a deliberate violation fixture (proves it is not vacuous)', () => {
    expect(CLAUDE_CODE_PATTERN.test('Powered by Claude')).toBe(false);
    for (const violation of ['Claude Code', 'claude-code', 'claude_code', 'claude.code', 'ClaudeCode']) {
      expect(CLAUDE_CODE_PATTERN.test(violation), violation).toBe(true);
    }
  });
});
