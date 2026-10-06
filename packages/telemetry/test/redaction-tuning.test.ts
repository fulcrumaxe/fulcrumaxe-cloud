import { describe, expect, it } from "vitest";
import {
  redactDeep,
  redactShapes,
  SCAN_CHUNK_CHARS,
  SCAN_OVERLAP_CHARS,
  TELEMETRY_SHAPES,
  TOKEN_SHAPE_PATTERN_SOURCES,
} from "@fx/runtime/src/redact.js";
import { MAX_STRING_LENGTH, sanitizeString } from "../src/fields.js";

// Fixtures are assembled at run time so no secret scanner flags this file.
const SECRET = "abc123secretvalue";
const once = JSON.stringify({ authorization: SECRET });
const REDACTED_ROWS: Array<[string, string, string]> = [
  ["JSON password", '{"password":"x"}', '{"password":"[redacted]"}'],
  ["JSON apiKey", '{"apiKey":"abc123def456"}', '{"apiKey":"[redacted]"}'],
  ["X-Auth-Token header", "X-Auth-Token: 0123456789abcdef", "X-Auth-Token: [redacted]"],
  // The label rule also catches the row above; the header list alone owns the spaced `=` form.
  ["X-Auth-Token header with a spaced =", "X-Auth-Token = 0123456789abcdef", "X-Auth-Token = [redacted]"],
  ["password label","password: x", "password: [redacted]"],
  ["empty user in a URI", "redis://:pw@cache.internal:6379", "redis://:[redacted]@cache.internal:6379"],
  ["DBPASS", "DBPASS=hunter2", "DBPASS=[redacted]"],
  ["stripe.key", "stripe.key=sk_x1", "stripe.key=[redacted]"],
  ["client_secret", "client_secret=abc", "client_secret=[redacted]"],
  ["escaped JSON password", '{\\"password\\":\\"x y\\"}', '{\\"password\\":\\"[redacted]\\"}'],
  ["a token that is one word", "Bearer abcdefghij", "Bearer [redacted]"],
  // MF1: a name with a long prefix before the credential word.
  ["a 70-character lowercase prefix", "a".repeat(70) + "_password=hunter2", "a".repeat(70) + "_password=[redacted]"],
  ["a 66-character prefix before _TOKEN", "x".repeat(66) + "_TOKEN=hunter2", "x".repeat(66) + "_TOKEN=[redacted]"],
  ["a 70-character upper-case prefix", "A".repeat(70) + "PASSWORD=hunter2", "A".repeat(70) + "PASSWORD=[redacted]"],
  ["a 70-character dash prefix", "-".repeat(70) + "password: hunter2", "-".repeat(70) + "password: [redacted]"],
  // SF1: a quoted value after an unquoted label.
  ["double-quoted label value", 'password: "hunter2"', "password: [redacted]"],
  ["single-quoted label value", "password: 'hunter2'", "password: [redacted]"],
  ["quoted value in an object literal", "{password: 'hunter2'}", "{password: [redacted]}"],
  ["quoted env value", 'password="hunter2"', "password=[redacted]"],
  ["quoted value with an escaped quote", 'password: "ab\\"cd" next', "password: [redacted] next"],
  // MF2: a quoted value may span lines (a PEM key body included); an unterminated quote is bounded.
  ["multi-line quoted label value", 'password: "line1\nhunter2"', "password: [redacted]"],
  ["multi-line quoted env value", 'password="line1\nhunter2"', "password=[redacted]"],
  [
    "PEM key body",
    'private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQ' + "A".repeat(60) + "\n" + "B".repeat(64) + '\n-----END PRIVATE KEY-----" next',
    "private_key: [redacted] next",
  ],
  ["unterminated multi-line quote", 'password: "line1\nhunter2\nmore', "password: [redacted]"],
  // MF3: a quoted value runs to its closing quote, however long, or to the end of the string.
  ["a 5000-character quoted private key", 'private_key: "' + "x".repeat(5000) + '" next', "private_key: [redacted] next"],
  ["a 20000-character quoted env value", 'password="' + "x".repeat(20000) + '" next', "password=[redacted] next"],
  [
    "a three-certificate chain",
    'password: "' + [1, 2, 3].map((i) => `-----BEGIN CERTIFICATE-----\n${String(i).repeat(2000)}\n-----END CERTIFICATE-----\n`).join("") + '" after',
    "password: [redacted] after",
  ],
  ...[4096, 4097, 4098].map((n): [string, string, string] => [`a ${n}-character quoted body`, `token: "${"y".repeat(n)}" after`, "token: [redacted] after"]),
  ["an unterminated quote followed by 5000 more characters", 'password: "' + "z".repeat(5000), "password: [redacted]"],
  // SF2/SF3: spaces around =, and == or ===.
  ["double equals", "password == x", "password == [redacted]"],
  ["triple equals", "password === x", "password === [redacted]"],
  ["spaces around =", "password = hunter2", "password = [redacted]"],
  ["a tab before =", "export DB_TOKEN\t=abc123 && run", "export DB_TOKEN\t=[redacted] && run"],
  // R1: a credential word as a whole segment anywhere in the name.
  ["SECRET_KEY_BASE", "SECRET_KEY_BASE=abc123", "SECRET_KEY_BASE=[redacted]"],
  ["TOKEN_VALUE", "TOKEN_VALUE=abc123", "TOKEN_VALUE=[redacted]"],
  ["PASSWORD_HASH", "PASSWORD_HASH=abc123", "PASSWORD_HASH=[redacted]"],
  ["API_KEY_ID", "API_KEY_ID=abc123", "API_KEY_ID=[redacted]"],
  ["secretKeyBase", "secretKeyBase=abc123", "secretKeyBase=[redacted]"],
  ["API_KEYS plural", "API_KEYS=abc123", "API_KEYS=[redacted]"],
  // R2: no prose exemption after a credential name; headers and Bearer need three words.
  ["passphrase label", "password: correct horse battery staple", "password: [redacted]"],
  ["passphrase JSON value", '{"password":"correct horse battery staple"}', '{"password":"[redacted]"}'],
  ["scheme plus one word", "Authorization: Foo abcdefghijkl", "Authorization: [redacted]"],
  // R3: scheme words at the start of a header value.
  ["OAuth scheme", "Authorization: OAuth abcdef ghijkl mnopqr", "Authorization: [redacted]"],
  ["ApiKey scheme", "Authorization: ApiKey abcdefghijkl", "Authorization: [redacted]"],
  ["Bot scheme", "Authorization: Bot abcdef ghijkl mnopqr", "Authorization: [redacted]"],
  ["a label value with a digit", "secret: required for 2 endpoints", "secret: [redacted]"],
];
const KEPT_ROWS = [
  "keyboard=us",
  "token_count=5",
  "max_tokens=1024",
  "bypass=true",
  "compass=north",
  "token_limit=4096",
  "password != x",
  "TOKEN_COUNT=5",
  "KEY_TYPE=rsa",
  "passport=ok keyword=x tokenizer=y",
  "the bot is running",
  "the Bearer of bad news",
  "authorization: required for this endpoint",
];

describe("redactDeep: secret shapes the first pass missed", () => {
  for (const [label, input, expected] of REDACTED_ROWS) {
    it(`redacts ${label}`, () => {
      expect(redactDeep(input, [])).toBe(expected);
    });
  }

  it("redacts an authorization key escaped once and escaped twice", () => {
    const twice = JSON.stringify(once);
    for (const text of [once, twice, JSON.stringify(twice)]) {
      expect(redactDeep(text, [])).not.toContain(SECRET);
      expect(redactDeep(text, [])).toContain("[redacted]");
    }
  });
});

describe("redactDeep: ordinary words are kept", () => {
  for (const text of KEPT_ROWS) {
    it(`keeps ${JSON.stringify(text)}`, () => {
      expect(redactDeep(text, [])).toBe(text);
    });
  }
});

describe("sanitizeString scans the whole input before it cuts the output", () => {
  const head = ["sk", "ant", "api03"].join("-") + "-";
  const tail = "AbCdEf0123456789".repeat(3).slice(0, 40);
  const PRE_CUT = MAX_STRING_LENGTH + SCAN_OVERLAP_CHARS + SCAN_CHUNK_CHARS;

  it("a token after a long redacted run has no unredacted head in the output", () => {
    const out = sanitizeString("PASSWORD=" + "a".repeat(120_000) + " " + head + tail);
    expect(out).toBe("PASSWORD=[redacted] [redacted]");
  });

  it("a token that straddles where the old pre-cut fell is redacted whole", () => {
    const run = PRE_CUT - "PASSWORD=".length - " sk-ant-a".length;
    const out = sanitizeString("PASSWORD=" + "a".repeat(run) + " " + head + tail);
    expect(out).not.toContain("sk-ant");
    expect(out).toBe("PASSWORD=[redacted] [redacted]");
  });
});

// MF4: a quoted value may span a scan window. Where the window ends between a backslash and the character it
// escapes, the match must be regrown, not rescanned as plain text.
const WINDOW = SCAN_CHUNK_CHARS + SCAN_OVERLAP_CHARS;
const TAIL_SECRET = "SECRETVALUE";
const FORMS: Array<[string, string, string]> = [
  ["env", 'xx_password="', '"'],
  ["label", 'xx_password: "', '"'],
  ["JSON", '{"xx_password":"', '"'],
  ["escaped JSON", '{\\"xx_password\\":\\"', '\\"'],
];

/** One unchunked pass over the whole string, every pattern in redactShapes' order. */
function singlePass(text: string): string {
  let out = text;
  for (const source of TOKEN_SHAPE_PATTERN_SOURCES) out = out.replace(new RegExp(source, "g"), "[redacted]");
  for (const shape of TELEMETRY_SHAPES) out = out.replace(new RegExp(shape.source, shape.flags), shape.replacement);
  return out;
}

describe("a quoted value that spans a scan window is redacted whole (MF4)", () => {
  for (const [form, open, close] of FORMS) {
    for (const parity of [0, 1]) {
      for (const closed of [true, false]) {
        it(`${form}, prefix parity ${parity}, ${closed ? "closed" : "unterminated"}`, () => {
          const text = "x".repeat(parity) + open + "\\\\".repeat(WINDOW) + TAIL_SECRET + (closed ? close + " next" : "");
          const out = redactDeep(text, []);
          expect(out).not.toContain(TAIL_SECRET);
          expect(out).toBe(singlePass(text));
        });
      }
    }
  }
});

describe("differential: chunked redaction equals one pass, with the secret inside a quoted value at the window edge", () => {
  // mulberry32 with a fixed seed, so a failure reproduces.
  let seed = 0x4d463412;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  it("120 seeded cases across forms, offsets -16..16 around the window end, and escape sequences", () => {
    for (let i = 0; i < 120; i++) {
      const [form, open, close] = pick(FORMS);
      // In the escaped form a bare backslash-quote IS the closing delimiter, so it is not an escape piece there.
      const pieces = form === "escaped JSON" ? ["\\\\", "\\n", "\n", "b"] : ["\\\\", '\\"', "\\n", "\n", "b"];
      const delta = (i % 33) - 16;
      let tailBody = "";
      while (tailBody.length < 64) tailBody += pick(pieces);
      const lead = 1 + Math.floor(rand() * 2);
      const bulk = "a".repeat(Math.max(0, WINDOW + delta - open.length - tailBody.length - lead));
      const text = "x".repeat(lead) + open + bulk + tailBody + TAIL_SECRET + (rand() < 0.5 ? close + " next" : "");
      const label = `case ${i} (${form}, delta ${delta})`;
      const out = redactShapes(text);
      expect(out.includes(TAIL_SECRET), label).toBe(false);
      expect(out === singlePass(text), label).toBe(true);
      expect(sanitizeString(text) === singlePass(text).slice(0, MAX_STRING_LENGTH), label).toBe(true);
    }
  });
});
