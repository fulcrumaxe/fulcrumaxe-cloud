import { describe, expect, it } from "vitest";
import { MEMORY_HIDDEN_CLASS, MEMORY_PROPOSAL_TEXT, removeHiddenMemoryChars } from "../src/index.js";

/** Text whose joiners and selectors do visible work: it must pass the runner's check and survive the cloud's cleaning byte for byte. */
const READABLE: Record<string, string> = {
  persianZwnj: "می\u200cخواهم این را اجرا کنم",
  hindiZwnj: "क\u094d\u200cष का परीक\u094dषण",
  malayalamZwj: "ന\u0d4d\u200d ഒരു പരീക\u0d4dഷണം",
  sinhalaZwj: "ක්\u200dර ලේඛනය",
  familyEmoji: "family \u{1F468}\u200d\u{1F469}\u200d\u{1F467} icon",
  skinToneJoined: "dev \u{1F469}\u{1F3FD}\u200d\u{1F4BB} here",
  heartSelector: "keep ❤\ufe0f in the header",
  textSelector: "arrow ↔\ufe0e here",
  keycap: "press 1\ufe0f\u20e3 then #\ufe0f\u20e3 or *\ufe0f\u20e3",
  plain: "run the tests with pnpm, café, 日本語",
};

/** Each of these hides something from a person reading the text. */
const HIDDEN: Record<string, string> = {
  variationSelectorSupplement: "run\u{e0100} tests",
  variationSelectorSupplementEnd: "run\u{e01ef} tests",
  variationSelectorOnLetter: "run\ufe0f tests",
  variationSelectorCjk: "邊\ufe00",
  privateUse: "run\ue000 tests",
  privateUseSupplement: "run\u{f0000} tests",
  hangulFiller: "run\u3164 tests",
  hangulChoseong: "run\u115f tests",
  hangulJungseong: "run\u1160 tests",
  halfwidthHangul: "run\uffa0 tests",
  brailleBlank: "run\u2800 tests",
  graphemeJoiner: "run\u034f tests",
  softHyphen: "run\u00ad tests",
  tag: "run\u{e0041} tests",
  bidi: "run\u202e tests",
  zeroWidthSpace: "run\u200b tests",
  lineSeparator: "run\u2028 tests",
  znwjBetweenLatin: "pa\u200css word",
  zwjBetweenLatin: "pa\u200dss word",
  zwjAfterLetterBeforeSpace: "run\u200d tests",
  keycapSelectorWithoutKeycap: "press 1\ufe0f now",
  loneSurrogate: "run\ud800 tests",
  khmerInherentVowel: "run\u17b4 tests",
  khmerInherentVowelAa: "run\u17b5 tests",
  mongolianSelectorOne: "run\u180b tests",
  mongolianSelectorThree: "run\u180d tests",
  mongolianSelectorFour: "run\u180f tests",
  unassignedDefaultIgnorable: "run\u2065 tests",
  specials: "run\ufff0 tests",
  tagBlockUnassigned: "run\u{e0fff} tests",
};

describe("memory text the person can see", () => {
  it("keeps joiners and selectors that spell a word or draw an emoji, in the cloud's cleaning and the runner's check alike", () => {
    for (const [name, text] of Object.entries(READABLE)) {
      expect(removeHiddenMemoryChars(text), name).toBe(text);
      expect(MEMORY_PROPOSAL_TEXT.test(text), name).toBe(true);
    }
  });

  it("removes (cloud) and refuses (runner) each class of hidden character, so the two agree", () => {
    for (const [name, text] of Object.entries(HIDDEN)) {
      expect(removeHiddenMemoryChars(text), name).not.toBe(text);
      expect(MEMORY_PROPOSAL_TEXT.test(text), name).toBe(false);
    }
  });

  it("agrees on mixed text: what the runner accepts the cloud leaves alone, and cleaning twice is cleaning once", () => {
    for (const text of [...Object.values(READABLE), ...Object.values(HIDDEN), "ا\u200c\u00adب", "1\ufe0f\ufe0f\u20e3", "❤\ufe0f\ufe0f"]) {
      const once = removeHiddenMemoryChars(text);
      expect(removeHiddenMemoryChars(once), text).toBe(once);
      if (MEMORY_PROPOSAL_TEXT.test(text)) expect(once, text).toBe(text);
    }
  });

  it("hides every Default_Ignorable_Code_Point, so a newer Unicode or a missed one cannot slip through", () => {
    const hidden = new RegExp(`^[${MEMORY_HIDDEN_CLASS}]$`, "u");
    const missing: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/\p{Default_Ignorable_Code_Point}/u.test(ch)) continue;
      // The joiners and selectors a rule keeps are still in the class: they are removed everywhere no rule applies.
      if (!hidden.test(ch) || removeHiddenMemoryChars(`a${ch}b`) !== "ab" || MEMORY_PROPOSAL_TEXT.test(`a${ch}b`)) missing.push(cp.toString(16));
    }
    expect(missing).toEqual([]);
  });

  it("does not hide an unassigned code point outside the default-ignorable ranges: the hidden set does not depend on the Unicode version of the running Node", () => {
    let unassigned = -1;
    for (let cp = 0x1f000; cp < 0x20000 && unassigned < 0; cp++) if (/\p{Cn}/u.test(String.fromCodePoint(cp))) unassigned = cp;
    expect(unassigned).toBeGreaterThan(0);
    const text = `new emoji ${String.fromCodePoint(unassigned)} here`;
    expect(removeHiddenMemoryChars(text)).toBe(text);
    expect(MEMORY_PROPOSAL_TEXT.test(text)).toBe(true);
    // Only these categories are named: stable ones (control, format, private-use, surrogate). No unassigned category is.
    expect(MEMORY_HIDDEN_CLASS).not.toContain("\\p{Cn}");
  });

  it("drops only the hidden character and leaves the visible ones around it", () => {
    expect(removeHiddenMemoryChars("a\u2800b\ue000c\u{e0100}d\u3164e")).toBe("abcde");
  });
});
