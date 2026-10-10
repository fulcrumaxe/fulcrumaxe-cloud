import { describe, expect, it } from 'vitest';
import { cleanWorkItemTitle, WORK_ITEM_TITLE_MAX } from '../src/work-items/title.js';

const ch = (...codes: number[]) => String.fromCharCode(...codes);

describe('cleanWorkItemTitle', () => {
  it('keeps an ordinary title as it is', () => {
    expect(cleanWorkItemTitle('Add a dark mode toggle')).toBe('Add a dark mode toggle');
  });
  it('turns control characters, newlines and tabs into single spaces and trims', () => {
    expect(cleanWorkItemTitle(`  one\r\ntwo\tthree${ch(0)}${ch(0x1b)}[0m four ${ch(0x85)}five  `)).toBe('one two three [0m four five');
  });
  it('removes line separators, bidi overrides and zero-width characters', () => {
    expect(cleanWorkItemTitle(`a${ch(0x2028)}b${ch(0x2029)}c${ch(0x202e)}d${ch(0x200b)}e${ch(0xfeff)}`)).toBe('a b c d e');
  });
  it("leaves markup as plain characters (escaping is the renderer's job)", () => {
    expect(cleanWorkItemTitle('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });
  it('cuts to 120 code points without splitting a surrogate pair, and trims the cut', () => {
    expect(WORK_ITEM_TITLE_MAX).toBe(120);
    expect(Array.from(cleanWorkItemTitle('x'.repeat(300))!)).toHaveLength(120);
    const emoji = cleanWorkItemTitle(String.fromCodePoint(0x1f600).repeat(200))!;
    expect(Array.from(emoji)).toHaveLength(120);
    expect(emoji.endsWith(String.fromCodePoint(0x1f600))).toBe(true);
    expect(cleanWorkItemTitle(`${'a'.repeat(119)} ${'b'.repeat(50)}`)).toBe('a'.repeat(119));
  });
  it('is null, never an empty string, for nothing printable or a non-string', () => {
    for (const v of ['', '   ', `${ch(0)}\n\t`, ch(0x200b), null, undefined, 7, {}]) expect(cleanWorkItemTitle(v)).toBeNull();
  });
});
