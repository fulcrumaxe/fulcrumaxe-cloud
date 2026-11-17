// The UTS #39 "skeleton" of a string, and the two note checks built on it. Plain ES module with no imports, so the Node host and the browser client can load the
// same file. The confusables table (about 45 KB) lives in skeletonTable.js and is loaded on first use, never at boot: call `await loadConfusables()` before the
// first check (a note check is the right place); the functions below are synchronous and throw if the table is not loaded, so a check can never silently pass
// against an empty table.

/** @type {Map<number, string> | null} */
let TABLE = null;
/** @type {RegExp | null} */
let IGNORABLE = null;
/** @type {Promise<void> | null} */
let LOADING = null;

/** Decodes the compact table (see scripts/generate-confusables.mjs for the format) into a code point to replacement map. */
export function decodeTable(encoded) {
  const map = new Map();
  for (const record of encoded.split(";")) {
    const [target, sources] = record.split("~");
    if (target === undefined || sources === undefined) throw new Error("confusables: bad table record");
    const replacement = String.fromCodePoint(...target.split(".").map((n) => parseInt(n, 36)));
    let cp = 0;
    for (const delta of sources.split(",")) {
      cp += parseInt(delta, 36);
      map.set(cp, replacement);
    }
  }
  return map;
}

/** Decodes the Default_Ignorable_Code_Point ranges (see scripts/generate-confusables.mjs) into a global regular expression over those code points. */
export function decodeIgnorable(encoded) {
  let cp = 0;
  const cls = encoded
    .split(",")
    .map((range) => {
      const [gap, span] = range.split(".");
      const lo = cp + parseInt(gap ?? "", 36);
      cp = lo + parseInt(span ?? "", 36);
      return "\\u{" + lo.toString(16) + "}-\\u{" + cp.toString(16) + "}";
    })
    .join("");
  return new RegExp("[" + cls + "]", "gu");
}

/** Loads the table on first call; later calls share the result. A failed load is retried on the next call and the checks keep throwing meanwhile. */
export function loadConfusables() {
  if (TABLE && IGNORABLE) return Promise.resolve();
  if (!LOADING) {
    LOADING = import("./skeletonTable.js").then(
      (m) => {
        IGNORABLE = decodeIgnorable(m.IGNORABLE);
        TABLE = decodeTable(m.default);
      },
      (err) => {
        LOADING = null;
        throw err;
      },
    );
  }
  return LOADING;
}

export function confusablesLoaded() {
  return TABLE !== null && IGNORABLE !== null;
}

function table() {
  if (!TABLE || !IGNORABLE) throw new Error("confusables table not loaded: await loadConfusables() first");
  return TABLE;
}

/**
 * UTS #39 (version 18) skeleton: NFD, then remove the Default_Ignorable_Code_Point characters (the Hangul fillers among them, which are letters and so not
 * format characters), then each remaining code point through the table, then NFD again.
 */
export function skeleton(s) {
  const t = table();
  let out = "";
  for (const ch of String(s).normalize("NFD").replace(/** @type {RegExp} */ (IGNORABLE), "")) {
    out += t.get(/** @type {number} */ (ch.codePointAt(0))) ?? ch;
  }
  return out.normalize("NFD");
}

/** Both forms a check looks at: the note as written and its NFKD form, which folds circled, squared, superscript, subscript and modifier letters and the long s. */
const forms = (note) => [String(note), String(note).normalize("NFKD")];

/**
 * True when the lowercase skeleton of the note, as written or in NFKD form, with everything but a-z removed, contains an untrusted-content marker word run.
 * Every lookalike is ASCII by then, so a letter the table does not know cannot sit between the marker letters and break the match.
 */
export function spellsMarker(note) {
  return forms(note).some((form) => {
    const letters = skeleton(form).toLowerCase().replace(/[^a-z]/g, "");
    return letters.includes("enduntrusted") || letters.includes("untrustedexternalcontent");
  });
}

/**
 * True when the note holds an angle bracket or a lookalike, as written or in NFKD form. A source that is a symbol, punctuation or ASCII counts on its own. A
 * source that is a letter (Hiragana KU, Bopomofo, Canadian syllabics: ordinary words in those scripts) counts only as a run of two or more, with combining marks
 * and default-ignorable characters skipped when finding the run: one letter cannot form a marker, and the marker words are covered by `spellsMarker`.
 */
export function hasAngleRun(note) {
  table();
  for (const form of forms(note)) {
    let run = 0;
    for (const ch of form.normalize("NFD")) {
      const sk = skeleton(ch);
      if (sk === "" || /\p{M}/u.test(ch)) continue; // default-ignorable (the skeleton drops it) or a combining mark
      const angles = (sk.match(/[<>]/g) ?? []).length;
      if (angles > 0 && !/\p{L}/u.test(ch)) return true;
      run = angles > 0 ? run + angles : 0;
      if (run >= 2) return true;
    }
  }
  return false;
}
