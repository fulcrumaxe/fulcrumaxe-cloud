// apps/workspace/import/rules.mjs
//
// D#37 WS-A1 security fix round: the secret/dotfile path and content rules,
// shared by import.mjs (which refuses to write anything that trips them,
// before any file lands on disk) and checks.mjs (which re-audits the
// resulting tree after import, and adds the --ship-only "Claude Code" gate
// on top). One module, one set of regexes, so the importer and checks.mjs
// can never drift apart from each other again (security review finding E2:
// the old checks.mjs-only rules were case-sensitive and ran only as a
// separate manual step after the files were already written).

// Path rule: dotfiles/dot-dirs, .env variants (this also covers
// prod.env and local.env, both of which contain ".env" as a
// substring), backup files, anything with "secret" in the path (covers
// both *secret* and secrets/), key/certificate material, the
// id_(rsa|dsa|ecdsa|ed25519) family, credentials-named files, .npmrc and
// source maps. Case-insensitive (E2): a security review probe found 11 of
// 17 synthetic secret fixtures passed the old case-sensitive check by
// varying case alone (core/SECRET.js, core/server.PEM, ...).
export const PATH_SECRET_RE =
  /(^|\/)\.|\.env|env\.|\.bak$|secret|\.pem$|\.key$|\.pfx$|\.p12$|\.p8$|\.jks$|\.keystore$|id_(rsa|dsa|ecdsa|ed25519)|credentials|\.npmrc$|\.map$/i;

export function pathIsSecretShaped(relPath) {
  return PATH_SECRET_RE.test(relPath);
}

// Content rules: obvious secret-shaped tokens. checkContent() below runs
// these against the file's bytes decoded as latin1 (byte-preserving, so
// single-byte-per-char tokens like AKIA/ghp_ always match regardless of the
// file's real encoding), as utf8 (so a multi-byte UTF-8 sequence decodes to
// its real character instead of splitting into latin1 mojibake), and as
// UTF-16LE/BE (E2b: a token written to a UTF-16 file is invisible to both
// of the above -- every other byte is a NUL that breaks a single-byte-per-
// char match, and it isn't valid UTF-8 either).
export const CONTENT_RULES = [
  { rule: "content-secret-ghs", re: /ghs_/ },
  { rule: "content-secret-ghp", re: /ghp_/ },
  { rule: "content-secret-github-pat", re: /github_pat_/ },
  { rule: "content-secret-gho", re: /gho_/ },
  { rule: "content-secret-ghu", re: /ghu_/ },
  { rule: "content-secret-ghr", re: /ghr_/ },
  { rule: "content-secret-sk-ant", re: /sk-ant-/ },
  { rule: "content-secret-sk-live", re: /sk_live_/ },
  { rule: "content-secret-sk-proj", re: /sk-proj-/ },
  // Security re-review 2 (E2c): the bare prefixes below matched inside
  // ordinary identifiers and public-corpus binary noise (a real TTF's bytes
  // contained "AKIA"; "ASIA" alone matched a region-name array; random
  // base64 tripped both a few percent of the time). Tightened to the real
  // key format with a word boundary on each side -- AKIA/ASIA are 20
  // characters total (4-letter prefix + 16 uppercase-alnum), AIza is a real
  // Google API key's 39 characters (4-letter prefix + 35 alnum/_/-).
  { rule: "content-secret-akia", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "content-secret-asia", re: /\bASIA[0-9A-Z]{16}\b/ },
  { rule: "content-secret-xoxb", re: /xoxb-/ },
  { rule: "content-secret-aiza", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "content-secret-rk-live", re: /rk_live_/ },
  // E2c: a bare "-----BEGIN" also matches a public key or certificate
  // (neither is a secret) -- only a private-key block is.
  { rule: "content-secret-pem-begin", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // E2b: the bare prefix is distinctive enough on its own -- a fixed body
  // length (or character set) is something a token format change, or a
  // base64url-flavored body containing "_"/"-", evades for free.
  { rule: "content-secret-fxat", re: /fxat_/ },
  { rule: "content-secret-whsec", re: new RegExp("whsec_[0-9A-Za-z+/=_-]{16,}") },
  // A JWT: three base64url segments separated by dots, header/payload both
  // starting "eyJ" (the base64 encoding of `{"`).
  { rule: "content-secret-jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  // E2c: the four env-style assignment rules below were case-insensitive
  // and had no minimum value length, so they matched benign minified code
  // like `{password:!0}` or a CSS map with no value at all. Now
  // case-sensitive (real env vars are conventionally SCREAMING_SNAKE_CASE;
  // lowercase `api_key = x` in source is not this shape), \b-anchored, and
  // require a value of a minimum length so a bare `=` with nothing
  // meaningful after it doesn't trip the rule.
  { rule: "content-secret-password-assign", re: /\b[A-Z][A-Z0-9]*_PASSWORD\s*=\s*\S{4,}/ },
  { rule: "content-secret-api-key-assign", re: /\b[A-Z0-9_]*API_KEY\s*=\s*\S{8,}/ },
  // E2b: two more specifically-named env-style assignments the review
  // probed for directly, neither of which the two rules above cover
  // (CLIENT_SECRET doesn't end in _PASSWORD; GITHUB_TOKEN doesn't end in
  // API_KEY).
  { rule: "content-secret-client-secret-assign", re: /\b[A-Z0-9_]*CLIENT_SECRET\s*=\s*\S{8,}/ },
  { rule: "content-secret-github-token-assign", re: /\b[A-Z0-9_]*GITHUB_TOKEN\s*=\s*\S{8,}/ },
  // E2c: the generic assignment rule (E2b, first adopted last round) was the
  // single biggest false-positive source -- it matched `this.token = token`,
  // `.password:focus{...}` in CSS, `{password:""}` in form state, an i18n
  // map's `password: "Password"`, and a minified input-type map's
  // `password:!0`, none of which are a secret. Tightened to require a
  // QUOTED literal of 12 or more non-quote, non-space characters as the
  // value -- \2 backreferences the SAME quote character matched as the
  // opening quote, so a stray quote elsewhere in the line can't close the
  // match early or extend it past the real value.
  { rule: "content-secret-assign-colon", re: /(password|passwd|secret|api[_-]?key|token)["'`]?\s*[:=]\s*(["'`])[^"'`\s]{12,}\2/i },
  // E2c: generalized from "any /home/<user>/" (which matched a virtual
  // `/home/user/` constant or a `/home/apps/` route table entry, neither of
  // which is a real local path) to a path inside a real home directory -- a
  // `/home/<name>/<something>` where <name> is not one of those generic
  // stand-in names -- plus any user's actual credential dot-directory.
  { rule: "content-local-path", re: /\/home\/(?!(?:user|users|username|apps?|me|name|example)\/)[^/\s"'`]+\/[^/\s"'`]|\/(?:home\/[^/\s"'`]+|root)\/\.(?:ssh|aws|gnupg|config|netrc|npmrc|docker|kube|env)/ },
];

// E2b / E4b: decodes a buffer as latin1, utf8, and UTF-16 (both byte
// orders) so a content rule sees a token regardless of the file's real
// encoding. UTF-16BE is derived by byte-swapping a copy of the buffer and
// decoding it with Node's built-in utf16le decoder -- Node has no native
// utf16be decoder, but swapping every pair of bytes first makes the two
// equivalent. Skipped when the buffer's length is odd (not a valid
// UTF-16 stream either way).
function decodeAllEncodings(buffer) {
  const texts = [buffer.toString("latin1"), buffer.toString("utf8"), buffer.toString("utf16le")];
  if (buffer.length % 2 === 0 && buffer.length > 0) {
    const swapped = Buffer.from(buffer);
    swapped.swap16();
    texts.push(swapped.toString("utf16le"));
  }
  return texts;
}

/**
 * Runs CONTENT_RULES against a file's raw bytes, decoded as latin1, utf8,
 * and UTF-16LE/BE. Returns the de-duplicated list of rule names that hit.
 */
export function checkContent(buffer) {
  const seen = new Set();
  for (const text of decodeAllEncodings(buffer)) {
    for (const { rule, re } of CONTENT_RULES) {
      if (re.test(text)) seen.add(rule);
    }
  }
  return [...seen];
}

// --ship only: the "Claude Code" string gate (D#2 constraint), widened to
// close every bypass a security review probe found.
//
// E4 (first round): a UTF-8-decoded NBSP, the literal escape-sequence text
// forms " " and "\xa0" (six and four literal ASCII characters
// respectively, as they'd appear unparsed in a source file), HTML NBSP
// entities (&nbsp;, the decimal &#160; and hex &#xa0; numeric forms, each
// with or without leading zeros), and an actual zero-width space (U+200B)
// or other invisible Unicode format character sitting between the two
// words.
//
// E4b (second round): every remaining separator-shaped form the review
// found -- combining marks (\p{M}: U+0301, U+0332, the combining grapheme
// joiner U+034F, ...) and format characters (\p{Cf}: soft hyphen U+00AD,
// the Mongolian vowel separator U+180E, function application U+2061, ...)
// used directly as the byte sitting between "claude" and "code"; the
// en/em/thin-space and soft-hyphen named entities and the &#32;/&#x20;/
// &#8203; numeric forms; and the literal escape-sequence texts "\x20",
// "\u{a0}", and the CSS "\a0 " hex escape (one to six hex digits with an
// optional trailing whitespace terminator, per the CSS spec).
//
// R1 (security re-review 2, CWE-1333): the CSS-escape alternative used to
// be `\\a0[ \t]?` -- the trailing terminator was OPTIONAL, so it overlapped
// with the plain `\s` alternative earlier in the same class: a run of
// "\a0 " (backslash, a, 0, space) could be parsed as `\\a0[ \t]?` consuming
// all four bytes in one iteration of the surrounding `(?:...)+`, OR as
// `\\a0` consuming three bytes and leaving the space for `\s` to consume in
// the NEXT iteration. That ambiguity is exactly what makes a `(?:A|B)+`
// group backtrack exponentially when neither alternative matches at the
// end -- a 192-byte adversarial CSS file hung the --ship check for over 30
// seconds. The negative lookahead below removes the ambiguity instead:
// `\\a0` now always consumes exactly three bytes (never the trailing
// space), so a "\a0 " run has exactly one parse. The lookahead itself only
// rejects a MORE hex digits immediately following (so this alternative
// never partially matches a longer CSS escape like "\a0b3"); it does not
// change which inputs match overall, since \s already consumes the space.
//
// E4c: the Hangul filler code points and the braille blank added to the
// character class directly -- raw bytes a probe used as the separator
// as-is, none of which fall under \s, \p{M} or \p{Cf} (they're
// General_Category Lo and So respectively).
const SEPARATOR_EXTRA_CODEPOINTS = [0x115f, 0x3164, 0xffa0, 0x2800].map((cp) => String.fromCodePoint(cp)).join("");
const NBSP_LIKE_SEPARATOR = String.raw`(?:[\s\p{M}\p{Cf}${SEPARATOR_EXTRA_CODEPOINTS}]|&nbsp;|&ensp;|&emsp;|&thinsp;|&shy;|&#0*32;|&#0*160;|&#0*8203;|&#x0*20;|&#x0*a0;|\\u00a0|\\u\{0*a0\}|\\xa0|\\x20|\\a0(?![0-9a-fA-F]))`;

export const SHIP_CLAUDE_CODE_RULES = [
  { rule: "ship-claude-code-text", re: /claude[\s_\-. ]*code/i },
  { rule: "ship-claude-code-nbsp", re: new RegExp(`claude(?:${NBSP_LIKE_SEPARATOR})+code`, "iu") },
];
const SHIP_CLAUDE_CODE_NBSP_RULE = SHIP_CLAUDE_CODE_RULES.find((r) => r.rule === "ship-claude-code-nbsp");

// E4b: strips every combining mark and format character out of a string
// entirely, so a mark or invisible character planted INSIDE one of the two
// words ("Cĺaude", a zero-width space mid-word) no longer breaks the
// literal "claude"/"code" substring match. This is applied as a second pass
// over each decoded text below, in addition to (never instead of) matching
// the raw text -- a purely-ASCII fixture has nothing for this to strip, so
// it changes nothing for any of the forms the first pass already covers.
const STRIP_MARKS_AND_FORMAT_RE = /[\p{M}\p{Cf}]/gu;

// E4c (security re-review 2): rounds one and two closed each separator
// bypass by adding another literal alternative to NBSP_LIKE_SEPARATOR --
// that is exactly how R1's ReDoS got introduced, and re-review 2 found 46
// of 54 further forms still missing (entities without a trailing `;`, the
// long MathML-style entity names, JS escape TEXT for `\t`/`\n`/`\x09`, and
// the raw Hangul filler/braille-blank code points). Enumeration cannot
// converge. Instead: decode every known entity/escape form to its real
// character FIRST, strip invisible/combining characters (including the
// code points below, none of which are \p{M} or \p{Cf}), and match the
// existing rules ONCE more against that single normalized string.
// The named HTML/XML entities that stand for a whitespace or invisible
// character -- not the full HTML5 entity table, just the ones relevant to
// a separator between two words. Matched case-insensitively (a probe found
// "&ENSP;" and "&#X20;"), so keys are looked up lowercased.
const NAMED_SEPARATOR_ENTITIES = {
  nbsp: String.fromCodePoint(0x00a0),
  nonbreakingspace: String.fromCodePoint(0x00a0),
  ensp: String.fromCodePoint(0x2002),
  emsp: String.fromCodePoint(0x2003),
  thinsp: String.fromCodePoint(0x2009),
  thinspace: String.fromCodePoint(0x2009),
  hairsp: String.fromCodePoint(0x200a),
  numsp: String.fromCodePoint(0x2007),
  puncsp: String.fromCodePoint(0x2008),
  mediumspace: String.fromCodePoint(0x205f),
  shy: String.fromCodePoint(0x00ad),
  zerowidthspace: String.fromCodePoint(0x200b),
  nobreak: String.fromCodePoint(0x2060),
  tab: String.fromCodePoint(0x0009),
  newline: String.fromCodePoint(0x000a),
};

function decodeCodePoint(hex, radix) {
  const cp = parseInt(hex, radix);
  return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
}

// Named entity names, longest first so e.g. "nonbreakingspace" is tried
// before any shorter name that happens to be one of its prefixes.
const NAMED_SEPARATOR_ENTITY_PATTERN = Object.keys(NAMED_SEPARATOR_ENTITIES)
  .sort((a, b) => b.length - a.length)
  .join("|");

// Decodes, in order: hex and decimal numeric character references WITH a
// trailing `;` (unambiguous, safe to decode with an open quantifier), the
// named entities above WITH a trailing `;`, then the same named entities
// WITHOUT one and the two short numeric forms the review probed for
// directly (decimal 160, hex a0 -- both NBSP) matched as fixed literal
// values rather than an open quantifier -- HTML5 only recognizes a FIXED
// list of legacy names without a trailing `;` (maximal match against a
// known table, e.g. "&nbspCode" is "&nbsp" + "Code", never one long unknown
// name), and an open hex-digit quantifier can't tell a short, common,
// unterminated numeric reference from a longer one that happens to start
// the same way ("a0" immediately followed by the "C" that starts "Code" --
// C is itself a valid hex digit, so no lookahead can disambiguate this;
// only an exact-value match can). Then JS escape TEXT (`\u{...}`, `\uXXXX`,
// `\xXX`, `\t`, `\n` -- matched via a doubled backslash in each regex
// literal below, so the pattern matches a literal backslash BYTE in the
// scanned text, exactly as it would sit unparsed in a source file, never an
// interpreted escape), and finally the CSS `\[0-9a-f]{1,6}` hex escape (one
// to six hex digits with an optional single trailing whitespace
// terminator, per the CSS spec).
function decodeEntitiesAndEscapes(text) {
  let out = text;
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => decodeCodePoint(hex, 16) ?? m);
  out = out.replace(/&#([0-9]+);/g, (m, dec) => decodeCodePoint(dec, 10) ?? m);
  out = out.replace(
    new RegExp(`&(${NAMED_SEPARATOR_ENTITY_PATTERN});`, "gi"),
    (m, name) => NAMED_SEPARATOR_ENTITIES[name.toLowerCase()] ?? m,
  );
  out = out.replace(
    new RegExp(`&(${NAMED_SEPARATOR_ENTITY_PATTERN})`, "gi"),
    (m, name) => NAMED_SEPARATOR_ENTITIES[name.toLowerCase()] ?? m,
  );
  out = out.replace(/&#0*160(?![0-9])/g, () => NAMED_SEPARATOR_ENTITIES.nbsp);
  out = out.replace(/&#x0*a0/gi, () => NAMED_SEPARATOR_ENTITIES.nbsp);
  // \u{...} is checked before plain \uXXXX so the brace form is never left
  // half-decoded by the shorter pattern.
  out = out.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, hex) => decodeCodePoint(hex, 16) ?? m);
  out = out.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => decodeCodePoint(hex, 16) ?? m);
  out = out.replace(/\\x([0-9a-fA-F]{2})/g, (m, hex) => decodeCodePoint(hex, 16) ?? m);
  out = out.replace(/\\t/g, "\t");
  out = out.replace(/\\n/g, "\n");
  // CSS hex escape: one to six hex digits, with an optional single
  // trailing whitespace terminator consumed along with it (CSS spec).
  out = out.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (m, hex) => decodeCodePoint(hex, 16) ?? m);
  return out;
}

/**
 * Runs SHIP_CLAUDE_CODE_RULES against a file's raw bytes, decoded as
 * latin1, utf8, and UTF-16LE/BE (E4b) -- catching a real UTF-8/UTF-16-
 * encoded NBSP, zero-width space, combining mark, format character, Hangul
 * filler, or braille blank sitting directly between the two words (all of
 * them are now in NBSP_LIKE_SEPARATOR's own character class) -- plus a
 * second pass with \p{M}/\p{Cf} characters stripped out entirely, for the
 * case where one sits INSIDE a word rather than between the two -- plus a
 * third pass (E4c) that decodes every known HTML entity and JS/CSS escape
 * form to its real character FIRST (never touching a raw, already-real
 * character), then matches the nbsp rule again against that decoded text.
 * Decoding is what closes the gap enumeration cannot: whatever new encoded
 * form a probe finds next, it decodes to one of the same real characters
 * NBSP_LIKE_SEPARATOR already knows how to match, without another literal
 * alternative added to the regex.
 */
export function checkShipClaudeCode(buffer) {
  const seen = new Set();
  for (const text of decodeAllEncodings(buffer)) {
    for (const { rule, re } of SHIP_CLAUDE_CODE_RULES) {
      if (re.test(text)) seen.add(rule);
    }
    const stripped = text.replace(STRIP_MARKS_AND_FORMAT_RE, "");
    if (stripped !== text) {
      for (const { rule, re } of SHIP_CLAUDE_CODE_RULES) {
        if (re.test(stripped)) seen.add(rule);
      }
    }
    // Attributed to ship-claude-code-nbsp specifically, not looped over
    // every rule: NBSP_LIKE_SEPARATOR's own alternation already matches
    // every character this decode step can produce, so it alone is
    // sufficient. Also testing ship-claude-code-text here would
    // double-attribute a plain decoded `&nbsp;` to BOTH rules (a real NBSP
    // is itself \s-matched, and \s is also in ship-claude-code-text's char
    // class), which is exactly the distinction this pass exists to keep
    // separate -- "was this caught by literal adjacent text, or only after
    // decoding an encoded separator" is real information a reviewer or a
    // later regression test relies on. No further stripping is applied
    // here (unlike the second pass above): NBSP_LIKE_SEPARATOR's own
    // character class already treats every \s/\p{M}/\p{Cf}/Hangul/braille
    // character this decode step can produce as a valid separator in its
    // own right -- stripping them here would delete the separator entirely
    // rather than normalize it, turning "claude<mark>code" into
    // "claudecode" with nothing left for the `+` quantifier to match.
    const decoded = decodeEntitiesAndEscapes(text);
    if (decoded !== text && SHIP_CLAUDE_CODE_NBSP_RULE.re.test(decoded)) {
      seen.add(SHIP_CLAUDE_CODE_NBSP_RULE.rule);
    }
  }
  return [...seen];
}

// --ship only: a precompressed file's bytes are never plaintext, so every
// content rule above (including the Claude Code gate) is blind to it.
// E4b: detected by magic bytes rather than by extension -- a rename to
// `.tgz`/`.zip`/`.svgz`/`.Z`/`.lz4`/`.7z`/`.zz` (or anything else) no
// longer evades this the way an extension allowlist/denylist would.
// E4c: zlib's own two-byte header added on top of the first round's magic
// list -- 78 01/9c/da are the three preset compression-level bytes zlib
// actually emits (fixed/default/best), which is what a ".zz" file's bytes
// normally start with.
const COMPRESSION_MAGIC = [
  [0x1f, 0x8b], // gzip
  [0x50, 0x4b, 0x03, 0x04], // zip (local file header)
  [0x50, 0x4b, 0x05, 0x06], // zip (empty archive)
  [0x50, 0x4b, 0x07, 0x08], // zip (spanned archive)
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  [0x42, 0x5a, 0x68], // bzip2 ("BZh")
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x04, 0x22, 0x4d, 0x18], // lz4 (frame format)
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x1f, 0x9d], // compress (.Z)
  [0x1f, 0xa0], // compress (.Z, alternate)
  [0x78, 0x01], // zlib (level 0-1, "fixed")
  [0x78, 0x9c], // zlib (level 6, "default")
  [0x78, 0xda], // zlib (level 9, "best")
];

// E4c (security re-review 2): magic-bytes-only detection regressed from the
// first round, which also checked the extension -- brotli has no magic
// number at all, and raw DEFLATE (no zlib/gzip wrapper) doesn't either, so
// both are invisible to a pure magic-byte check regardless of how many
// signatures the list above grows to. Extension is the only signal for
// either format, so it's kept as a second detector rather than folded into
// the magic list -- unlike gzip/zstd/etc., a real .gz always carries its
// magic bytes, so extending the extension check to those formats too would
// only reintroduce the "renamed but not actually compressed" false
// positive the first round's extension-only check had (see the "does NOT
// flag a file merely named .gz" test below).
const COMPRESSION_EXTENSION_ONLY_RE = /\.(?:br|zz|deflate)$/i;

// --ship only: D#37 WS-C2 criterion 9 — the fork's shipped bytes must
// contain none of the legacy local-auth surface `core/cloud-login.js`
// (and, historically, `core/boot.js`) used to talk to: the username/
// password terminal endpoints, the magic-link email flow, or a
// password input of any kind. Simple literal/regex checks are
// sufficient here (unlike SHIP_CLAUDE_CODE_RULES above): this is our
// own fork's source, not adversarial third-party content, so there is
// no obfuscation to defend against — only "did a stray reference
// survive a refactor".
export const SHIP_FORBIDDEN_SIGNIN_RULES = [
  { rule: "ship-forbidden-login-path", re: /\/api\/login\b/ },
  { rule: "ship-forbidden-signup-path", re: /\/api\/signup\b/ },
  { rule: "ship-forbidden-local-auto-login-path", re: /\/api\/local-auto-login\b/ },
  { rule: "ship-forbidden-magic-request-path", re: /magic\/request\b/ },
  // Matches both a literal HTML attribute (<input type="password">) and
  // a JS-constructed one (el.type = 'password', {type: "password"}).
  { rule: "ship-forbidden-password-input", re: /(<input\b[^>]*\btype\s*=\s*["']?password["']?|\btype\s*[:=]\s*["']password["'])/i },
];

// D#37 Correction C34 section 1 (WS-F5p): the one file allowed to hold a
// password input. The Model Key app's API-key field must be masked (a
// clear-text key invites shoulder-surfing and browser form history); the
// rule above targets the legacy sign-in surface, not that field. Matched
// by EXACT path only, never by prefix or glob, and only for a file the
// build classified as first-party. This list grows only by a D#37
// Correction.
export const SHIP_PASSWORD_INPUT_ALLOWED_PATHS = Object.freeze(["apps/model-key/model-key-app.js"]);

/**
 * Runs SHIP_FORBIDDEN_SIGNIN_RULES against a file's raw bytes, decoded
 * as latin1, utf8, and UTF-16LE/BE (same decode pass checkShipClaudeCode
 * uses, for the same reason: a token split across a multi-byte encoding
 * must still be caught).
 *
 * Optional `{ relPath, firstParty }`: when relPath equals an entry of
 * SHIP_PASSWORD_INPUT_ALLOWED_PATHS exactly and firstParty is true, only
 * ship-forbidden-password-input is skipped; every other rule still runs.
 * With no second argument the behaviour is unchanged.
 */
export function checkShipForbiddenSignin(buffer, { relPath, firstParty } = {}) {
  const passwordAllowed = firstParty === true && SHIP_PASSWORD_INPUT_ALLOWED_PATHS.includes(relPath);
  const seen = new Set();
  for (const text of decodeAllEncodings(buffer)) {
    for (const { rule, re } of SHIP_FORBIDDEN_SIGNIN_RULES) {
      if (passwordAllowed && rule === "ship-forbidden-password-input") continue;
      if (re.test(text)) seen.add(rule);
    }
  }
  return [...seen];
}

// --ship only: D#37 Correction C19d, task WS-B1 criterion 5 -- the
// `--ship` rule WS-D criterion 1 originally planned, moved here so it
// ships with the branding fix itself rather than waiting on WS-D. Scans
// every shipped file for the jpos boot/tab strings WS-B1 replaced
// (script.js's old window.brandingData defaults and boot.js's old
// bootSequence lines): "JP OP V.0.1", "Formal Hosting LLC", "Jungle We
// Like Fun And Games" and "CONNECTING TO THE CONSTRUCT". Matched on the
// distinguishing substring named in the criterion, not the full phrase,
// so a build can't evade this by truncating or rewording around it.
export const SHIP_FORBIDDEN_BRANDING_RULES = [
  { rule: "ship-forbidden-branding-jpos", re: /JP OP|Jungle We Like|THE CONSTRUCT|Formal Hosting/i },
];

/**
 * Runs SHIP_FORBIDDEN_BRANDING_RULES against a file's content, after the
 * same comment stripping checkTrustedTypesSink uses (stripJsComments) --
 * the criterion's own wording, and the same function checkTrustedTypesSink
 * calls, so the two can never drift apart. Decoded as utf8 only: these are
 * the fork's own hand-authored shell source, not adversarial third-party
 * content, so (unlike checkShipClaudeCode) there is no obfuscation to
 * defend against here.
 */
export function checkShipForbiddenBranding(buffer) {
  const seen = new Set();
  const text = stripJsComments(buffer.toString("utf8"));
  for (const { rule, re } of SHIP_FORBIDDEN_BRANDING_RULES) {
    if (re.test(text)) seen.add(rule);
  }
  return [...seen];
}

// --ship only: a dist/ path under the licence-activation app. D#37 WS-L1
// (correction C19c criterion 2): the profile no longer lists "activation"
// in app_modules, so profile.mjs's filter already drops every
// apps/activation/* tag from the shipped index.html and the build's own
// reachability walk (build.mjs) never adds an unreferenced file to dist/
// -- this path rule is the regression guard for that, not the mechanism.
// Matched the same way VENDOR_MONACO_RE/VENDOR_XTERM_RE are in
// checks.mjs: a path prefix, checked directly against relPath, not
// decoded content.
export const ACTIVATION_PATH_RE = /^apps\/activation\//;

// --ship only: D#37 WS-L1 (correction C19c criterion 2) -- none of the
// licence-activation module's own vocabulary may survive in shipped
// bytes, even after the path rule above (e.g. if some OTHER shipped file
// were ever edited to reference it again). Simple literal/case-
// insensitive checks, same reasoning as SHIP_FORBIDDEN_SIGNIN_RULES:
// this is our own fork's source, not adversarial third-party content.
export const SHIP_NO_LICENSE_ACTIVATION_RULES = [
  { rule: "ship-license-activation-global", re: /FULCLicense/i },
  { rule: "ship-license-activation-api-path", re: /\/api\/license\// },
  { rule: "ship-license-activation-cta-text", re: /Activate license/i },
  { rule: "ship-license-activation-key-text", re: /license key/i },
];

/**
 * Runs SHIP_NO_LICENSE_ACTIVATION_RULES against a shipped .js file's text,
 * after the SAME comment-stripping checkTrustedTypesSink uses (criterion
 * 2's own wording: "after the same comment stripping checkTrustedTypesSink
 * uses") -- so a code comment that merely EXPLAINS why licence activation
 * was removed (as this very file's comments do) never self-trips the
 * rule. Decoded as utf8 only: these are our own hand-authored source
 * files, matching checkTrustedTypesSink's reasoning exactly.
 */
export function checkShipNoLicenseActivation(buffer) {
  const text = stripJsComments(buffer.toString("utf8"));
  const seen = [];
  for (const { rule, re } of SHIP_NO_LICENSE_ACTIVATION_RULES) {
    if (re.test(text)) seen.push(rule);
  }
  return seen;
}

// --ship only: D#37 WS-L1 (correction C19c criterion 8) -- "No bypass
// flag, environment switch or test-only branch goes into shipped code
// ... The --ship scan also greps for such a flag and must find none."
// This is the naming vocabulary this task's own e2e seed helper
// (apps/workspace/e2e/seed-account-status.mjs, never shipped -- e2e/ is
// not build.mjs's input and is not on the allowlist) and gate would use
// if a shortcut around the gate were ever added to shell code instead of
// staying in test tooling. Deliberately broad (both word orders, `_`/`-`
// separators) rather than one exact string, so a rename doesn't quietly
// evade it.
export const SHIP_NO_SUBSCRIPTION_BYPASS_RE =
  /\b(?:workspace[_-]?access|subscription|gate)[_-]?bypass\b|\bbypass[_-]?(?:workspace[_-]?access|subscription|gate)\b/i;

export function checkShipNoSubscriptionBypass(buffer) {
  const text = stripJsComments(buffer.toString("utf8"));
  return SHIP_NO_SUBSCRIPTION_BYPASS_RE.test(text) ? ["ship-subscription-bypass-flag"] : [];
}

export function isPrecompressed(buffer, relPath) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (COMPRESSION_MAGIC.some((sig) => buffer.length >= sig.length && sig.every((b, i) => buffer[i] === b))) {
    return true;
  }
  return typeof relPath === "string" && COMPRESSION_EXTENSION_ONLY_RE.test(relPath);
}

// D#37 WS-C2b: the four shell files whose Trusted Types
// (`require-trusted-types-for: 'script'`, criterion 13) violations PR #114's
// round-3 milestone run surfaced -- plain `.innerHTML`/`.outerHTML`
// assignments and `.insertAdjacentHTML()` calls, replaced with
// createElement/textContent/append/replaceChildren. Paths are relative to
// the tree root checkTree() walks (shell/ in --import mode, dist/ in --ship
// mode; the build step preserves this relative path from one to the other),
// so the same set guards both.
// D#37 Correction C18 / WS-C5: the ten shell files the C18a ship-tree sweep
// found still holding a Trusted Types sink (21 sites total), added to the
// guard once each site was rewritten with createElement/textContent/append/
// replaceChildren. Adding more files than the three the live walk actually
// hit (window-manager.js, themes-app.js, themes-preview.js) is deliberate --
// the other seven carry 16 of the 21 sites on code paths the walk did not
// exercise, and they would still break under enforcement the moment those
// paths run.
// D#37 Correction C19 / WS-TH1 (C19b criterion 3): the six heritage-theme
// files C19b's own sweep found holding a Trusted Types sink (14 sites --
// C19b's authoritative recount of the technical architect's 13) once
// "heritage" ships in app_modules (root cause 1, this profile only shipped
// it starting with this task). orchard-icons.js and crystal-icons.js are
// deliberately NOT added here: they hold icon shape DATA now (no
// .innerHTML/etc. use at all, confirmed by tt-ship-sweep.test.mjs), not a
// sink site -- see those two files' own header comments.
export const TRUSTED_TYPES_SINK_GUARDED_FILES = new Set([
  "core/modals.js",
  "core/cloud-login.js",
  "core/desktop.js",
  "core/taskbar.js",
  "core/boot.js",
  "core/command-registry.js",
  "core/window-manager.js",
  "apps/themes/themes-app.js",
  "apps/themes/themes-preview.js",
  "core/system-tray.js",
  "core/hot-corners.js",
  "keybindings.js",
  "core/upgrade-modal.js",
  "core/channel-switcher.js",
  "core/presence.js",
  "sdk/fulc-sdk.umd.js",
  "apps/themes/heritage/crystal-adapter.js",
  "apps/themes/heritage/crystal-dom.js",
  "apps/themes/heritage/orchard-adapter.js",
  "apps/themes/heritage/orchard-dom.js",
  "apps/themes/heritage/orchard-dock-folders.js",
  "apps/themes/heritage/orchard-dock-minimized.js",
]);

// Matches a real sink use -- not a bare mention of the word, so a comment
// explaining why a sink was removed (this file's own history is full of
// exactly that) doesn't trip its own guard. Covers:
//   - a property assignment (`.innerHTML =` / `.outerHTML =`, not `==`/`===`)
//   - `.insertAdjacentHTML(`
//   - `.parseFromString(` (DOMParser) and `.createContextualFragment(`
//     (Range) -- both parse a string into live-attachable HTML, D#37 WS-C2
//     fix round: the guard originally missed command-registry.js's
//     `new DOMParser().parseFromString(html, 'text/html')` because neither
//     was in this list, even though `parseFromString` IS a Trusted Types
//     sink under require-trusted-types-for 'script' (confirmed live via a
//     CSP violation report)
//   - `document.write(` / `writeln(` (the latter unqualified so it also
//     catches `someDoc.writeln(`, e.g. via a popup's `.document`)
//   - `.setHTMLUnsafe(` and `.parseHTMLUnsafe(`, the newer HTML-parsing
//     sinks that bypass Trusted Types the same way innerHTML does
//
// D#37 Correction C16 / WS-C3: the six dotted-member forms above miss a
// computed-member sink (`el['innerHTML'] = x`, quoted with '/"/` ) and every
// script sink. Widened to also cover:
//   - `el['innerHTML'] = x` / `el["outerHTML"] = x` / the backtick
//     template-literal key form -- same quote character required to open
//     and close the bracketed key (\1), same `=(?!=)` guard against `==`/
//     `===` as the dotted form above
//   - `el['insertAdjacentHTML'](...)` -- the computed-member call form of
//     the existing dotted `.insertAdjacentHTML(` sink
//   - `eval(...)` and `Function(...)`/`new Function(...)` -- both compile
//     and run a string as script; `\b` keeps `retrieval(`/`myFunction(`
//     (the sink word ends mid-identifier, no word boundary there) from
//     matching, while still catching a property-qualified call like
//     `window.eval(...)` (the `.` before the sink word IS a boundary)
//   - `setTimeout(...)`/`setInterval(...)` called with a string-literal
//     first argument (the classic implicit-eval form) -- matches only when
//     the character right after the opening `(` (skipping whitespace) is a
//     quote, so `setTimeout(fn, 0)` (a function reference) is not a sink
//   - `.srcdoc =` -- an iframe's `srcdoc` is parsed as HTML the same way
//     `innerHTML` is
//   - `script.src =` -- name-heuristic, per C16: only a receiver literally
//     named `script` (e.g. a `<script>` element about to be inserted) is a
//     sink; `img.src =`/`newScript.src =` are ordinary resource URLs and
//     are deliberately NOT covered by this heuristic
//
// D#37 Correction C17a / WS-C4 criterion 7: the WS-C3 review on #147 found
// a real gap -- C16b's prose named `script.setAttribute('src', ...)` but
// its shipped pass/fail list only covered `script.src = x`. Widened once
// more to also cover:
//   - `script.setAttribute('src', x)` / `script.setAttribute("src", x)` --
//     same name-heuristic as `script.src =` above (only a receiver
//     literally named `script`), same same-quote-to-open-and-close
//     requirement (\3) as the computed-member forms above;
//     `img.setAttribute('src', x)` and `script.setAttribute('type', x)`
//     are deliberately NOT covered
// D#37 Correction C18 / WS-C5 criterion 2: exported (not just used
// internally by checkTrustedTypesSink below) so the ship-tree sweep test
// (tt-ship-sweep.test.mjs) can run the exact same regex object over every
// shipped file, not only the guarded set -- the sweep test must never carry
// a copied literal of this pattern, or the two could drift apart silently.
export const TRUSTED_TYPES_SINK_RE =
  /\.(?:innerHTML|outerHTML)\s*=(?!=)|\[\s*(['"`])(?:innerHTML|outerHTML)\1\s*\]\s*=(?!=)|\.insertAdjacentHTML\s*\(|\[\s*(['"`])insertAdjacentHTML\2\s*\]\s*\(|\.parseFromString\s*\(|\.createContextualFragment\s*\(|document\.write\s*\(|\bwriteln\s*\(|\.setHTMLUnsafe\s*\(|\.parseHTMLUnsafe\s*\(|\beval\s*\(|\bFunction\s*\(|\b(?:setTimeout|setInterval)\s*\(\s*['"`]|\.srcdoc\s*=(?!=)|\bscript\.src\s*=(?!=)|\bscript\.setAttribute\s*\(\s*(['"])src\3\s*,/;

// Best-effort JS comment stripper, not a full parser: removes /* */ block
// comments and // line comments before the sink regex runs, so a comment
// documenting the old sink (or warning against a new one) can freely spell
// out `.innerHTML =` without self-triggering. It does not track
// string/template-literal context, so a `//` or `/*` sitting inside a
// string literal would be mis-stripped -- acceptable here because these are
// hand-authored, reviewed source files, not general source input; the
// guarded-file test suite (`checks.test.mjs`) pins this behaviour with a
// literal-in-comment fixture so a regression is caught in CI, not silently
// trusted. Exported for the same reason TRUSTED_TYPES_SINK_RE is (WS-C5,
// tt-ship-sweep.test.mjs): the ship-tree sweep must use this exact stripper,
// never a copy.
export function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Returns `"trusted-types-sink"` if `relPath` is one of the WS-C2b guarded
 * shell files AND its content (after stripping comments) contains a real
 * innerHTML/outerHTML/insertAdjacentHTML sink use; otherwise `null`.
 * Content is decoded as utf8 -- these are hand-authored source files, never
 * a binary asset, so (unlike checkContent()/checkShipClaudeCode() above) a
 * single encoding is sufficient and avoids flagging latin1/UTF-16 mojibake
 * that happens to contain the byte sequence by chance.
 */
export function checkTrustedTypesSink(buffer, relPath) {
  if (!TRUSTED_TYPES_SINK_GUARDED_FILES.has(relPath)) return null;
  const text = stripJsComments(buffer.toString("utf8"));
  return TRUSTED_TYPES_SINK_RE.test(text) ? "trusted-types-sink" : null;
}
