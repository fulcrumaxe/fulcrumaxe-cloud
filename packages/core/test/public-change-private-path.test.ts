import { describe, expect, it } from 'vitest';
import { PUBLIC_CHANGE_REFUSAL_REASON, privatePathChangeSentence, publicChangeSentence } from '../src/repos/publicChangeCopy.js';

describe('the card sentence for a change that edits private-only paths', () => {
  it('names the paths and what to change, and never says Build again (it would be refused the same way)', () => {
    for (const runtime of ['runner', 'sandbox', null]) {
      const s = publicChangeSentence('refused', 'private_path_change', runtime, ['docs/ops/plan.md', 'docs/ops/b.md']);
      expect(s).toBe(privatePathChangeSentence(['docs/ops/plan.md', 'docs/ops/b.md']));
      expect(s).toContain('docs/ops/plan.md, docs/ops/b.md');
      expect(s).toContain("Take them out of the Spec's file list");
      expect(s).not.toMatch(/Build again/);
      expect(s).not.toContain('must not be public');
    }
  });

  it('shows five paths and counts the rest', () => {
    const paths = Array.from({ length: 8 }, (_, i) => `docs/ops/f${i}.md`);
    const s = privatePathChangeSentence(paths);
    expect(s).toContain('docs/ops/f4.md and 3 more');
    expect(s).not.toContain('f5.md');
  });

  it('with no path known it still reads as a sentence', () => {
    expect(privatePathChangeSentence([])).toMatch(/^Refused: the change edits private-only paths, which the public repository never receives\./);
  });

  it('a real scan refusal keeps its own words', () => {
    expect(publicChangeSentence('refused', 'scan_refused', 'runner', ['docs/ops/x.md'])).toBe(`Refused: ${PUBLIC_CHANGE_REFUSAL_REASON.scan_refused}. Use Build again to try once more.`);
  });
});
