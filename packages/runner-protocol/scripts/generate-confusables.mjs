// Builds src/confusables/skeletonTable.js from the vendored UTS #39 confusables.txt and the vendored Default_Ignorable_Code_Point extract. No network: both data
// files are checked in and their SHA-256 values are pinned below. Run `node scripts/generate-confusables.mjs` to rewrite the table; the test regenerates it in
// memory and requires it to be byte-identical.
// The extract is the header and the Default_Ignorable_Code_Point section of DerivedCoreProperties.txt (the whole file is 1.1 MB and holds 60 other properties).
// To rebuild it from a fresh download of that file: `node scripts/generate-confusables.mjs --extract <path to DerivedCoreProperties.txt>`; the script checks the
// download against DCP_FULL_SHA256 and rewrites the extract.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_PATH = join(HERE, "..", "vendor", "unicode", "confusables.txt");
export const TABLE_PATH = join(HERE, "..", "src", "confusables", "skeletonTable.js");
export const UNICODE_VERSION = "18.0.0";
export const DATA_SHA256 = "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92";
export const IGNORABLE_PATH = join(HERE, "..", "vendor", "unicode", "DefaultIgnorable.txt");
/** SHA-256 of the whole DerivedCoreProperties.txt, Unicode 18.0.0 (dated 2026-08-07, 1159889 bytes), the file the extract is cut from. */
export const DCP_FULL_SHA256 = "09c928886a178fcafd93c29e4bd59073a058e5a100b716d425cb563ab50f68c9";
/** SHA-256 of the checked-in extract. */
export const IGNORABLE_SHA256 = "9dc39b6095446efd7b9c4e71c0ef4ddd6afe8aae043f020dc926efe15a9322f5";
const DCP_SECTION = "# Derived Property: Default_Ignorable_Code_Point";

/** Parses the data lines: `SRC ; TARGET [TARGET...] ; TYPE # comment`. Returns [source code point, target code points] pairs. */
export function parse(text) {
  const out = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = (raw.split("#")[0] ?? "").trim();
    if (line === "") continue;
    const parts = line.split(";").map((p) => p.trim());
    if (parts.length < 3 || !/^[0-9A-F]{4,6}$/.test(parts[0] ?? "")) throw new Error("confusables: unreadable line: " + raw.slice(0, 40));
    const target = (parts[1] ?? "").split(/\s+/).map((h) => parseInt(h, 16));
    if (target.length === 0 || target.some((n) => !Number.isInteger(n) || n > 0x10ffff)) throw new Error("confusables: bad target: " + raw.slice(0, 40));
    out.push([parseInt(parts[0] ?? "", 16), target]);
  }
  return out;
}

/**
 * The compact form: one record per distinct target, `;`-separated. A record is `T~S` where T is the target's code points in base 36 joined by `.` and S is the
 * ascending source code points in base 36, the first absolute and the rest as differences from the one before, joined by `,`.
 */
export function encode(pairs) {
  const byTarget = new Map();
  const seen = new Set();
  for (const [src, target] of pairs) {
    if (seen.has(src)) throw new Error("confusables: duplicate source U+" + src.toString(16));
    seen.add(src);
    const key = target.map((n) => n.toString(36)).join(".");
    const list = byTarget.get(key);
    if (list) list.push(src);
    else byTarget.set(key, [src]);
  }
  const records = [];
  for (const [key, srcs] of [...byTarget.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    srcs.sort((a, b) => a - b);
    let prev = 0;
    const deltas = srcs.map((s) => {
      const d = (s - prev).toString(36);
      prev = s;
      return d;
    });
    records.push(key + "~" + deltas.join(","));
  }
  return records.join(";");
}

/**
 * Lookalikes that confusables.txt leaves out, added here by hand and overriding the file where both name a character. Targets are ASCII (the note checks
 * lowercase after the skeleton). `closure` below then follows them, so a character the file maps to one of these ends on the ASCII letter.
 *  - Latin letter small capitals (the file keeps them apart from the letters).
 *  - Armenian capital Vo (looks like n), Coptic e, and the Canadian syllabics E and S.
 *  - Angle brackets: the file maps the letter-category angle lookalikes (Bopomofo, Hiragana KU, Dingbat angle) to U+276C/U+276D and stops there.
 */
export const SUPPLEMENT = [
  [0x1d00, "a"], [0x0299, "b"], [0x1d04, "c"], [0x1d05, "d"], [0x1d07, "e"], [0xa730, "f"], [0x0262, "g"], [0x029c, "h"], [0x026a, "i"], [0x1d0a, "j"],
  [0x1d0b, "k"], [0x029f, "l"], [0x1d0d, "m"], [0x0274, "n"], [0x1d0f, "o"], [0x1d18, "p"], [0x0280, "r"], [0xa731, "s"], [0x1d1b, "t"], [0x1d1c, "u"],
  [0x1d20, "v"], [0x1d21, "w"], [0x028f, "y"], [0x1d22, "z"],
  [0x0548, "n"], [0x2c88, "e"], [0x2c89, "e"], [0x15f4, "e"], [0x1515, "s"],
  // Open E: the file sends these to U+0190 or U+A793, never to e (U+A792 is the prototype of the euro sign). The closure carries the rest of the family
  // (small open e, Cyrillic and Greek epsilon, the lunate epsilon, the Deseret E letters).
  [0x0190, "E"], [0xa792, "E"], [0xa793, "e"], [0x025b, "e"], [0x03b5, "e"], [0x03f5, "e"], [0x2107, "e"], [0x0510, "E"], [0x0511, "e"], [0x10401, "e"], [0x10429, "e"],
  // Other letters the file leaves alone or sends elsewhere.
  [0x1455, "c"], [0x043f, "n"], [0x03c7, "x"], [0x03bc, "u"], [0xa7b9, "u"], [0x027e, "r"], [0x0220, "n"], [0x0500, "d"], [0x039b, "a"], [0x0245, "a"], [0xa645, "s"], [0x01a8, "s"],
  // Letters the host's own short table folds and the file sends to a different or a non-ASCII letter (kra, turned w, eszett, and zeta, which it leaves alone).
  [0x03f2, "c"], [0x0138, "k"], [0x043c, "m"], [0x03b2, "b"], [0x03b6, "z"],
  // Circles (symbols, not letters) and crosses.
  [0x25cb, "o"], [0x25cf, "o"], [0x25ef, "o"], [0x26aa, "o"], [0x26ab, "o"], [0x2b55, "o"], [0x0298, "o"], [0x2299, "o"],
  [0x2715, "x"], [0x2716, "x"], [0x2717, "x"], [0x2718, "x"], [0x2573, "x"],
  // Angle brackets: the file maps the letter-category angle lookalikes (Bopomofo, Hiragana KU, Dingbat angle) to U+276C/U+276D and stops there.
  [0x276c, "<"], [0x276d, ">"], [0x1405, ">"], [0x3031, "<"],
  // Equal to or precedes / succeeds, and the APL greater-than with diaeresis: the file sends them to other symbols.
  [0x22de, "<"], [0x22df, ">"], [0x2369, ">"],
  // Enclosed letters with no decomposition (the circled, squared and parenthesized ones are folded by the NFKD pass in the checks).
  ...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].flatMap((letter, i) => [[0x1f150 + i, letter], [0x1f170 + i, letter], [0x1f1e6 + i, letter]]),
];

/**
 * Angle-shaped symbols, added only where the data file has no entry of its own (it already maps the plain and the double forms, and keeps them as they are).
 * A symbol's skeleton need only hold `<` or `>`: the note check refuses any non-letter source whose skeleton does. The lists are the characters named
 * LESS-THAN or GREATER-THAN, the left- and right-pointing triangles and pointers, and the guillemets and angle brackets of the CJK, Dingbat and
 * mathematical blocks (a double form gets `<<` or `>>`).
 */
export const ANGLE_FAMILY = [
  ...[0x2264, 0x2266, 0x2268, 0x226a, 0x226e, 0x2270, 0x2272, 0x2274, 0x22d6, 0x22d8, 0x22dc, 0x22e6, 0x2343, 0x2976, 0x2977, 0x29c0, 0x2a79, 0x2a7b, 0x2a7d, 0x2a7f, 0x2a81, 0x2a83, 0x2a85, 0x2a87, 0x2a89, 0x2a8d, 0x2a95, 0x2a97, 0x2a99, 0x2a9b, 0x2a9d, 0x2a9f, 0x2aa1, 0x2aa3, 0x2aa6, 0x2aa8, 0x2af7, 0x2af9, 0xfe64, 0xff1c, 0x00ab, 0x2770, 0x2989, 0x2991, 0x29fc, 0x227a, 0x22b2, 0x02f1, 0x23ea, 0x23ee, 0x23f4, 0x25c0, 0x25c1, 0x25c2, 0x25c3, 0x25c4, 0x25c5, 0x2bc7, 0x1f780].map((cp) => [cp, "<"]),
  ...[0x2265, 0x2267, 0x2269, 0x226b, 0x226f, 0x2271, 0x2273, 0x2275, 0x22d7, 0x22d9, 0x22dd, 0x22e7, 0x2344, 0x2369, 0x2978, 0x29c1, 0x2a7a, 0x2a7c, 0x2a7e, 0x2a80, 0x2a82, 0x2a84, 0x2a86, 0x2a88, 0x2a8a, 0x2a8e, 0x2a96, 0x2a98, 0x2a9a, 0x2a9c, 0x2a9e, 0x2aa0, 0x2aa2, 0x2aa7, 0x2aa9, 0x2af8, 0x2afa, 0x2b43, 0xfe65, 0xff1e, 0x00bb, 0x2771, 0x298a, 0x2992, 0x29fd, 0x227b, 0x22b3, 0x02f2, 0x23e9, 0x23ed, 0x23ef, 0x23f5, 0x25b6, 0x25b7, 0x25ba, 0x25bb, 0x27a2, 0x27a3, 0x27a4, 0x2bc8, 0x1f782, 0x25b8, 0x25b9].map((cp) => [cp, ">"]),
  ...[0x2276, 0x2277, 0x2278, 0x2279, 0x22da, 0x22db, 0x2a8b, 0x2a8c, 0x2a8f, 0x2a90, 0x2a91, 0x2a92, 0x2a93, 0x2a94, 0x2aa4, 0x2aa5].map((cp) => [cp, "<>"]),
  ...[0x300a, 0x27ea, 0x2abb, 0x2aa1].map((cp) => [cp, "<<"]),
  ...[0x300b, 0x27eb, 0x2abc, 0x2aa2].map((cp) => [cp, ">>"]),
  [0x23ea, "<<"], [0x23e9, ">>"],
];

/** Parses the Default_Ignorable_Code_Point section of the extract into sorted, merged [first, last] ranges. */
export function parseIgnorable(text) {
  const ranges = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*Default_Ignorable_Code_Point\s*#/.exec(raw);
    if (!m) {
      if (/;\s*Default_Ignorable_Code_Point/.test(raw)) throw new Error("confusables: unreadable ignorable line: " + raw.slice(0, 40));
      continue;
    }
    ranges.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)]);
  }
  if (ranges.length === 0) throw new Error("confusables: no Default_Ignorable_Code_Point lines");
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [lo, hi] of ranges) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

/** Ranges as `gap.length` pairs in base 36, comma-separated: the gap from the end of the previous range (or from 0), then the range length minus one. */
export function encodeRanges(ranges) {
  let prev = 0;
  return ranges
    .map(([lo, hi]) => {
      const out = (lo - prev).toString(36) + "." + (hi - lo).toString(36);
      prev = hi;
      return out;
    })
    .join(",");
}

/** The header and the Default_Ignorable_Code_Point section of a full DerivedCoreProperties.txt. */
export function extractIgnorable(fullText) {
  const lines = fullText.split("\n");
  const blank = lines.indexOf("");
  const from = lines.indexOf(DCP_SECTION);
  const to = lines.findIndex((l, i) => i > from && l.startsWith("# Total code points:"));
  if (blank < 0 || from < 0 || to < 0) throw new Error("confusables: the Default_Ignorable_Code_Point section was not found");
  return [...lines.slice(0, blank + 1), ...lines.slice(from, to + 1)].join("\n") + "\n";
}

/** Makes every target final: a target code point that is itself a source is replaced by its own target, until none is (the skeleton then needs one pass). */
export function closure(pairs) {
  const map = new Map(pairs.map(([s, t]) => [s, t]));
  const resolve = (t) => {
    let cur = t;
    for (let depth = 0; depth < 8; depth++) {
      const next = cur.flatMap((cp) => map.get(cp) ?? [cp]);
      if (next.length === cur.length && next.every((v, i) => v === cur[i])) return cur;
      cur = next;
    }
    throw new Error("confusables: mapping does not settle for " + t.map((n) => n.toString(16)).join(" "));
  };
  return [...map.keys()].sort((a, b) => a - b).map((s) => [s, resolve(/** @type {number[]} */ (map.get(s)))]);
}

export function render(dataText, ignorableText) {
  const ihash = createHash("sha256").update(ignorableText).digest("hex");
  if (ihash !== IGNORABLE_SHA256) throw new Error("confusables: ignorable extract hash " + ihash + " does not match the pinned " + IGNORABLE_SHA256);
  const hash = createHash("sha256").update(dataText).digest("hex");
  if (hash !== DATA_SHA256) throw new Error("confusables: data file hash " + hash + " does not match the pinned " + DATA_SHA256);
  const merged = new Map(parse(dataText).map(([s, t]) => [s, t]));
  for (const [cp, shape] of new Map(ANGLE_FAMILY)) if (!merged.has(cp)) merged.set(cp, [...shape].map((c) => c.codePointAt(0)));
  for (const [cp, ascii] of SUPPLEMENT) merged.set(cp, [...ascii].map((c) => c.codePointAt(0)));
  const pairs = closure([...merged.entries()]);
  return (
    "// GENERATED by scripts/generate-confusables.mjs from vendor/unicode/confusables.txt (Unicode " + UNICODE_VERSION + ", UTS #39). Do not edit.\n" +
    "// " + pairs.length + " single-code-point sources. The Unicode data is under the Unicode License v3: see vendor/unicode/LICENSE.\n" +
    "export const UNICODE_VERSION = " + JSON.stringify(UNICODE_VERSION) + ";\n" +
    "export const SOURCE_COUNT = " + pairs.length + ";\n" +
    "export const IGNORABLE = " + JSON.stringify(encodeRanges(parseIgnorable(ignorableText))) + ";\n" +
    "export default " + JSON.stringify(encode(pairs)) + ";\n"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf("--extract");
  if (at > 0) {
    const full = readFileSync(process.argv[at + 1] ?? "", "utf8");
    const h = createHash("sha256").update(full).digest("hex");
    if (h !== DCP_FULL_SHA256) throw new Error("confusables: DerivedCoreProperties.txt hash " + h + " does not match the pinned " + DCP_FULL_SHA256);
    writeFileSync(IGNORABLE_PATH, extractIgnorable(full));
    console.log("wrote " + IGNORABLE_PATH + " (set IGNORABLE_SHA256 to " + createHash("sha256").update(readFileSync(IGNORABLE_PATH)).digest("hex") + ")");
  } else {
    writeFileSync(TABLE_PATH, render(readFileSync(DATA_PATH, "utf8"), readFileSync(IGNORABLE_PATH, "utf8")));
    console.log("wrote " + TABLE_PATH);
  }
}
