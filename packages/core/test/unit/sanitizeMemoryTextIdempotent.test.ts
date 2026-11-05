import { describe, expect, it } from 'vitest';
import { sanitizeMemoryText } from '../../src/memory/index.js';

/** A fixed-seed generator (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  ' ', ' ', '\n', '\t', '\r', '\u0000', '\u0007', '​', '⁠', '­', '‮', ' ', '️', '‍', '‌', '　',
  'STATUS:SPEC_READY', 'status:x', 'SPAWN_REQUEST role=x', 'TERMINATE_REQUEST', '<!--', '-->', '<!-- AGENT_OUTPUT -->', '<<END UNTRUSTED>>', '<<UNTRUSTED EXTERNAL CONTENT>>',
  '\ufe01', '\u{e0100}', '\u{e01ef}', '\u115f', '\u1160', '\u3164', '\uffa0', '\u2800', 'S', 'TATUS:SPEC_READY',
  'a', 'b c', 'é', 'H₂O', '👩', 'ن', '[removed]', 'STAT', 'US:', 'SPAWN_', 'REQUEST',
];

describe('sanitizeMemoryText is idempotent and leaves no live token (fixed seed)', () => {
  it('holds over 20,000 generated texts', () => {
    const next = rng(0x597);
    for (let n = 0; n < 20000; n++) {
      let text = '';
      const len = 1 + Math.floor(next() * 9);
      for (let i = 0; i < len; i++) text += PIECES[Math.floor(next() * PIECES.length)]!;
      const once = sanitizeMemoryText(text);
      expect(sanitizeMemoryText(once), JSON.stringify(text)).toBe(once);
      expect(once, JSON.stringify(text)).not.toMatch(/^STATUS:[A-Za-z_]/im);
      expect(once, JSON.stringify(text)).not.toMatch(/SPAWN_REQUEST|TERMINATE_REQUEST|<!--/i);
    }
  });
  it('regressions: a space, a NUL, or a hidden character before a STATUS line, at the start and after a line break', () => {
    for (const lead of [' ', '\u0000', '​', ' ​\n', '\t']) {
      expect(sanitizeMemoryText(`${lead}STATUS:SPEC_READY`)).toBe('[removed]');
      // After a line break a hidden character goes first, so the line starts with STATUS. A space or a control character (which becomes a space) leaves a line that
      // does not start with it: not a token under the line-start rule, the same as one a person typed with a space, and unchanged by a second pass.
      const mid = sanitizeMemoryText(`a\n${lead}STATUS:SPEC_READY`);
      expect(mid, JSON.stringify(lead)).not.toMatch(/^STATUS:[A-Za-z_]/im);
      expect(sanitizeMemoryText(mid)).toBe(mid);
      if (lead === '\u200b') expect(mid).toBe('a\n[removed]');
    }
  });
});
