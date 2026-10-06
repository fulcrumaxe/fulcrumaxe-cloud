/**
 * The scrub (SE3). Two jobs, one definition of "a secret":
 *
 *  - `redact` / `redactDeep` remove secrets from text and data BEFORE it is written to disk (the report
 *    writer in `report.ts` calls them and then re-checks the result; if anything survives it refuses to write).
 *  - `scanDir` is the upload gate, and it is an allowlist: only text files (.log .txt .md .json .jsonl .html,
 *    strict UTF-8) and PNG screenshots (text chunks checked, nothing after IEND) may be uploaded. Everything
 *    else (zip, tar, traces, video, HAR, unknown binaries) is left out and listed as `not-uploaded:<type>`; that
 *    is not an error. A debugging run can opt specific files in with `includeUnscanned`; never on production.
 *
 * What is looked for, in an allowed file: the static shapes below, every value registered through `mask.ts`
 * (also ones registered after the scan started), and the secret-looking values of the run's own environment,
 * in plain text and through URL-encoding, JSON escapes (also doubly escaped), HTML entities, hex and
 * base64/base64url at every alignment. A finding never contains the secret itself, nor a name that holds one.
 *
 * The threat is an accidental leak from our own test code. Not covered: text drawn inside screenshot pixels
 * (that is what `data-secret-node` masking is for), a value split across lines, quoted-printable, base32, a
 * HAR pair whose `value` comes before its `name`, a bearer value shorter than 16 characters with no digit and
 * no known token prefix, and anything inside a file that was opted in with `includeUnscanned`.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import { envSecretValues, type MaskRegistry } from "./mask.js";

export class ScrubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrubError";
  }
}

/** Something the scrub could not read or bound. Reported as `unscannable:<message>`. */
export class Unscannable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unscannable";
  }
}

export interface ScrubContext {
  /** Runtime values (and, when file-backed, those registered by other processes). */
  registry?: MaskRegistry;
  /** The run's own environment: its secret-looking values must never appear. */
  env?: Record<string, string | undefined>;
  /** Names to treat as secret even though they do not look like it (a target's declared `env`). */
  declaredEnvNames?: readonly string[];
  /** Further literal values. */
  values?: readonly string[];
  /** When present, `redact` adds the number of replacements it makes. */
  stats?: { redactions: number };
}

export interface Finding {
  /** Path inside the scanned folder; `!` separates a container from an entry (`trace.zip!0/log.txt`). */
  path: string;
  /** The shape that matched, `runtime-value`, `env-value`, or `unscannable:<why>`. Never the secret. */
  kind: string;
  /** How it was found: `plain`, or a chain such as `base64>url`. */
  via: string;
}

interface Shape {
  kind: string;
  /** The secret is the capture group `v`, and it is the LAST thing the match consumes. */
  re: RegExp;
}

// A redaction placeholder must never be matched again by the context shapes below.
const NOT_PLACEHOLDER = String.raw`(?!\[REDACTED)`;
const LINE_VALUE = String.raw`[^\r\n"',;]`;

const SHAPES: readonly Shape[] = [
  // Stripe: secret and restricted keys, live and test, and webhook signing secrets. (pk_ is publishable.)
  // A real key mixes cases and digits; requiring one capital or digit keeps names like risk_test_something out.
  { kind: "stripe-key", re: /(?:sk|rk)_(?:live|test)_(?<v>(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{8,})/g },
  { kind: "stripe-webhook-secret", re: /whsec_(?<v>[A-Za-z0-9+/=]{16,})/g },
  // Anthropic API keys.
  { kind: "anthropic-key", re: /sk-ant-(?<v>[A-Za-z0-9_-]{8,})/g },
  // OpenAI keys (project, service-account and admin forms).
  { kind: "openai-key", re: /sk-(?:proj|svcacct|admin)-(?<v>[A-Za-z0-9_-]{16,})/g },
  // Other well-known token prefixes, matched whatever the length: Slack, AWS access key ids, Google API keys,
  // GitLab personal access tokens and npm tokens.
  { kind: "slack-token", re: /(?:xox[abprse]-|xapp-)(?<v>[A-Za-z0-9-]{8,})/g },
  { kind: "aws-key-id", re: /(?:AKIA|ASIA)(?<v>[0-9A-Z]{16})/g },
  { kind: "google-api-key", re: /AIza(?<v>[0-9A-Za-z_-]{35})/g },
  { kind: "gitlab-token", re: /gl(?:pat|ptt|dt|rt|cbt|ft|imt|agent|soat|oas)-(?<v>[A-Za-z0-9_.-]{16,})/g },
  { kind: "npm-token", re: /npm_(?<v>[A-Za-z0-9]{36})/g },
  // GitHub tokens: classic and app tokens, and fine-grained personal access tokens.
  { kind: "github-token", re: /(?:gh[pousr]_|github_pat_)(?<v>[A-Za-z0-9_]{16,})/g },
  // Vercel tokens carry a `vc?_` prefix (vcp_ vci_ vca_ vcr_ vck_); the body charset is not published, so
  // underscores and hyphens are allowed. The older bare 24-character form has no shape: the assignment and
  // header contexts below and the env-value check catch it.
  { kind: "vercel-token", re: /vc[a-z]_(?<v>[A-Za-z0-9_-]{16,})/g },
  // A JWT: three dot-separated base64url segments, header and payload start with `eyJ` (a JSON object).
  // Segment lengths are capped and the start is anchored so repeated `-eyJ` cannot make the scan quadratic.
  { kind: "jwt", re: /(?<![A-Za-z0-9])(?<v>eyJ[A-Za-z0-9_-]{6,4096}\.eyJ[A-Za-z0-9_-]{6,4096}\.[A-Za-z0-9_-]{0,4096})/g },
  { kind: "private-key", re: /(?<v>-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4096})/g },
  // `Authorization: <anything>` and `Proxy-Authorization`, header text or JSON/object form. A header NAME
  // listed without a value (the request log keeps names only) does not match: it needs `:` or `=` and a value.
  {
    kind: "authorization-header",
    re: new RegExp(String.raw`\b(?:proxy-)?authori[sz]ation["']?\s*[:=]\s*["']?${NOT_PLACEHOLDER}(?<v>[^\s"',;]${LINE_VALUE}{3,})`, "gi"),
  },
  // A bearer value of 8+ characters with a digit, or 16+ without (prose such as "bearer authentication" stays clear).
  {
    kind: "bearer-token",
    re: /\bbearer\s+(?<v>(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{16,})/gi,
  },
  // HAR and Playwright network logs list headers and cookies as {"name": "...", "value": "..."} pairs.
  {
    kind: "header-pair",
    re: new RegExp(
      String.raw`"name"\s*:\s*"(?:proxy-authorization|authorization|set-cookie|cookie|x-vercel-protection-bypass|x-vercel-set-bypass-cookie|(?:__Host-)?fx_session|_vercel_jwt)"\s*,\s*"value"\s*:\s*"${NOT_PLACEHOLDER}(?<v>[^"]+)`,
      "gi",
    ),
  },
  // Cookie headers, request and response: the whole value up to the end of the line or the closing quote.
  {
    kind: "cookie-header",
    re: new RegExp(String.raw`\b(?:set-)?cookie["']?\s*[:=]\s*["']?${NOT_PLACEHOLDER}(?<v>[^\s"][^\r\n"]+)`, "gi"),
  },
  // The app session cookie and Vercel's bypass/auth cookies, wherever they show up as `name=value`.
  {
    kind: "session-cookie",
    re: new RegExp(String.raw`(?:__Host-)?\bfx_session\s*=\s*${NOT_PLACEHOLDER}(?<v>[^\s;"']{4,})`, "g"),
  },
  {
    kind: "vercel-bypass-cookie",
    re: new RegExp(String.raw`\b_vercel_(?:jwt|sso_nonce)\s*=\s*${NOT_PLACEHOLDER}(?<v>[^\s;"']{4,})`, "g"),
  },
  // Vercel Deployment Protection bypass: header or query parameter.
  {
    kind: "bypass-secret",
    re: new RegExp(String.raw`\bx-vercel-(?:protection-bypass|set-bypass-cookie)["']?\s*[:=]\s*["']?${NOT_PLACEHOLDER}(?<v>[^\s"',;&]{3,})`, "gi"),
  },
  // A credential in a URL of any scheme (https, postgres, redis, mongodb+srv, ...): scheme://user:pw@host,
  // also with an empty user.
  { kind: "url-credentials", re: /\b[a-z][a-z0-9+.-]{1,30}:\/\/[^\s/:@]*:(?!\[REDACTED)(?<v>[^\s/@]{3,})@/gi },
  // An environment-style assignment of a secret-named variable (a printed env dump).
  {
    kind: "env-assignment",
    re: new RegExp(String.raw`\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|_KEY|_PAT|_DSN)[A-Z0-9_]*\s*=\s*["']?${NOT_PLACEHOLDER}(?<v>[^\s"']{8,})`, "g"),
  },
];

export const SHAPE_KINDS: readonly string[] = SHAPES.map((s) => s.kind);

// ---------------------------------------------------------------------------------------------------------
// Values the scrub looks for besides the static shapes.

function literalValues(ctx: ScrubContext): { runtime: string[]; env: string[] } {
  const runtime = [...(ctx.registry?.values() ?? []), ...(ctx.values ?? [])].filter((v) => v.length > 0);
  const env = ctx.env === undefined ? [] : envSecretValues(ctx.env, ctx.declaredEnvNames ?? []);
  return { runtime, env };
}

// ---------------------------------------------------------------------------------------------------------
// Views: the same text as it would look after one more layer of decoding.

const MAX_VIEW_DEPTH = 4;
const MIN_BASE64_RUN = 16;
/** Longer runs are decoded in overlapping windows, so a 16 MB blob costs memory for one window at a time. */
const WINDOW = 1024 * 1024;
const WINDOW_OVERLAP = 4096;
/** Runs up to this size are also decoded segment by segment between slashes. */
const SEGMENT_SPLIT_MAX = 64 * 1024;
const MAX_VIEW_WORK_CHARS = 1024 * 1024 * 1024;

const B64_CHAR = new Uint8Array(128);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_-") B64_CHAR[c.charCodeAt(0)] = 1;
const isB64 = (code: number): boolean => code < 128 && B64_CHAR[code] === 1;

/** Runs of base64/base64url characters, found without a regular expression (no recursion, any length). */
function* base64Runs(text: string): Generator<string> {
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && !isB64(text.charCodeAt(i))) i += 1;
    const start = i;
    while (i < n && isB64(text.charCodeAt(i))) i += 1;
    if (i - start < MIN_BASE64_RUN) continue;
    if (i - start <= WINDOW) yield text.slice(start, i);
    else for (let s = start; s < i; s += WINDOW - WINDOW_OVERLAP) yield text.slice(s, Math.min(i, s + WINDOW));
  }
}

function decodeBase64(run: string): string {
  return Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, ""), "base64").toString("latin1");
}

/** The run decoded from each of the four possible alignments, so a blob that starts mid-run is still read. */
function* base64Decodings(run: string): Generator<string> {
  for (let k = 0; k < 4 && run.length - k >= MIN_BASE64_RUN; k += 1) yield decodeBase64(k === 0 ? run : run.slice(k));
}

function urlDecode(s: string): string {
  if (!/%[0-9a-fA-F]{2}/.test(s)) return s;
  return s.replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const ESCAPE_MAP: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t" };

/** Undoes one layer of JSON-style escaping: \uXXXX, \xNN, \" \\ \/ \n \r \t. Applied repeatedly through the views. */
function jsonUnescape(s: string): string {
  if (!/\\[ux"\\/nrt]/.test(s)) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\(["\\/nrt])/g, (_m, u?: string, x?: string, c?: string) =>
    c !== undefined ? (ESCAPE_MAP[c] as string) : String.fromCharCode(parseInt((u ?? x) as string, 16)),
  );
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };

function htmlDecode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});|&(quot|amp|lt|gt|apos);/g, (m, d?: string, h?: string, named?: string) => {
    if (named !== undefined) return NAMED_ENTITIES[named] as string;
    const cp = d !== undefined ? parseInt(d, 10) : parseInt(h as string, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** Base64 wrapped across lines (MIME, PEM): lines of 16+ base64 characters joined. */
function unwrapLines(s: string): string {
  if (!s.includes("\n")) return s;
  return s.replace(/(?<=[A-Za-z0-9+/=_-]{16})\r?\n(?=[A-Za-z0-9+/_-])/g, "");
}

const HEX_CHAR = new Uint8Array(128);
for (const c of "0123456789abcdefABCDEF") HEX_CHAR[c.charCodeAt(0)] = 1;
const isHexish = (code: number): boolean => code === 32 || code === 58 || code === 44 || (code < 128 && HEX_CHAR[code] === 1);

/** Spans of hex digits and the separators " :," found with a loop (a regex overflows the stack on 16 MB), compacted. */
function* hexRuns(text: string): Generator<string> {
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && !isHexish(text.charCodeAt(i))) i += 1;
    const start = i;
    while (i < n && isHexish(text.charCodeAt(i))) i += 1;
    if (i - start < 16) continue;
    const compact = text.slice(start, i).replace(/[ :,]/g, "");
    if (compact.length < 16) continue;
    if (compact.length <= WINDOW) yield compact;
    // Windows start on even offsets and overlap, so a value crossing a boundary is whole in one of them.
    else for (let w = 0; w < compact.length; w += WINDOW - WINDOW_OVERLAP) yield compact.slice(w, Math.min(compact.length, w + WINDOW));
  }
}

/** Hex, plain or spaced (Node prints a buffer as `<Buffer 73 6b ...>`), at both nibble alignments. */
function* hexDecodings(s: string): Generator<string> {
  for (const compact of hexRuns(s)) {
    yield Buffer.from(compact, "hex").toString("latin1");
    yield Buffer.from(compact.slice(1), "hex").toString("latin1");
  }
}

interface View {
  text: string;
  via: string;
}

function* children(text: string): Generator<[string, string]> {
  const u = urlDecode(text);
  if (u !== text) yield ["url", u];
  const e = jsonUnescape(text);
  if (e !== text) yield ["escape", e];
  const h = htmlDecode(text);
  if (h !== text) yield ["entity", h];
  const w = unwrapLines(text);
  if (w !== text) yield ["unwrap", w];
  for (const d of hexDecodings(text)) yield ["hex", d];
  for (const run of base64Runs(text)) {
    for (const d of base64Decodings(run)) yield ["base64", d];
    if (run.length <= SEGMENT_SPLIT_MAX && run.includes("/")) {
      for (const seg of run.split("/")) if (seg.length >= MIN_BASE64_RUN) for (const d of base64Decodings(seg)) yield ["base64", d];
    }
  }
}

/** Every view of `text`, itself included, up to MAX_VIEW_DEPTH decodings deep, depth first (one chain in memory). */
function* views(text: string): Generator<View> {
  const work = { chars: 0, seen: new Set<string>([text]) };
  function* expand(view: View, depth: number): Generator<View> {
    work.chars += view.text.length;
    if (work.chars > MAX_VIEW_WORK_CHARS) throw new Unscannable("size-limit");
    yield view;
    if (depth >= MAX_VIEW_DEPTH) return;
    for (const [label, t] of children(view.text)) {
      if (t.length === 0) continue;
      if (t.length <= 65536) {
        if (work.seen.has(t)) continue;
        work.seen.add(t);
      }
      yield* expand({ text: t, via: view.via === "plain" ? label : `${view.via}>${label}` }, depth + 1);
    }
  }
  yield* expand({ text, via: "plain" }, 0);
}

export interface Hit {
  kind: string;
  via: string;
}

/** What `text` contains, looking through the encodings above. Never returns the secret. */
export function detect(text: string, ctx: ScrubContext = {}): Hit[] {
  const hits = new Map<string, Hit>();
  const { runtime, env } = literalValues(ctx);
  for (const view of views(text)) {
    for (const shape of SHAPES) {
      shape.re.lastIndex = 0;
      if (shape.re.test(view.text)) hits.set(`${shape.kind}|${view.via}`, { kind: shape.kind, via: view.via });
    }
    for (const v of runtime) if (view.text.includes(v)) hits.set(`runtime-value|${view.via}`, { kind: "runtime-value", via: view.via });
    for (const v of env) if (view.text.includes(v)) hits.set(`env-value|${view.via}`, { kind: "env-value", via: view.via });
  }
  return [...hits.values()];
}

// ---------------------------------------------------------------------------------------------------------
// Redaction: for text and data that is about to be written.

/** Replaces every secret found in the PLAIN text. Encoded copies are not rewritten; `assertClean` catches them. */
export function redact(text: string, ctx: ScrubContext = {}): string {
  let out = text;
  let count = 0;
  for (const shape of SHAPES) {
    shape.re.lastIndex = 0;
    out = out.replace(shape.re, (match: string, ...rest: unknown[]) => {
      const groups = rest[rest.length - 1] as { v?: string };
      const v = groups.v ?? "";
      if (v.length === 0) return match;
      count += 1;
      return `${match.slice(0, match.length - v.length)}[REDACTED:${shape.kind}]`;
    });
  }
  const { runtime, env } = literalValues(ctx);
  // Longest first, so a value that contains another is replaced whole.
  const literals = [...runtime.map((v) => ({ v, kind: "runtime-value" })), ...env.map((v) => ({ v, kind: "env-value" }))].sort(
    (a, b) => b.v.length - a.v.length,
  );
  for (const { v, kind } of literals) {
    for (const form of new Set([v, encodeURIComponent(v), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url")])) {
      if (form.length < 8) continue;
      const parts = out.split(form);
      if (parts.length > 1) {
        count += parts.length - 1;
        out = parts.join(`[REDACTED:${kind}]`);
      }
    }
  }
  if (ctx.stats !== undefined) ctx.stats.redactions += count;
  return out;
}

/** `redact` over every string in a JSON-like value (keys included), so escaping in the serialised form cannot hide a match. */
export function redactDeep<T>(value: T, ctx: ScrubContext = {}): T {
  if (typeof value === "string") return redact(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, ctx)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redact(k, ctx)] = redactDeep(v, ctx);
    return out as T;
  }
  return value;
}

/** Throws (naming only the kinds) when `text` still holds a secret in any view. Run on the final bytes to be written. */
export function assertClean(text: string, ctx: ScrubContext = {}): void {
  const hits = detect(text, ctx);
  if (hits.length > 0) {
    const kinds = [...new Set(hits.map((h) => `${h.kind} (${h.via})`))].join(", ");
    throw new ScrubError(`refusing to write: output still contains a secret after redaction: ${kinds}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The upload gate: what may leave the machine, and what is checked on the way.
//
// The threat is an ACCIDENTAL leak from our own test code or Playwright: a token in a log, a key in a URL, a
// cookie in a network log. So the gate is an allowlist, not a universal scanner:
//
//   - text files (.log .txt .md .json .jsonl .html): strict UTF-8, no NUL bytes, and checked with `detect`;
//   - PNG screenshots: the file is read as bytes, its text chunks (tEXt, iTXt, zTXt, decompressed) are
//     checked, and anything after IEND is refused;
//   - every other file (zip, tar, trace, video, HAR, unknown binaries) is NOT uploaded: it is listed as
//     `not-uploaded:<type>` and left out of the upload set. That is not an error.
//
// One explicit opt-in exists for a debugging run: `includeUnscanned` globs put matching non-allowlisted files
// into the upload set WITHOUT looking inside them (only the raw bytes get the plain check). It is refused on
// the production target (`includeUnscannedRefusal`) and is recorded in the report.

const MAX_INFLATE = 128 * 1024 * 1024;

export const TEXT_EXTENSIONS: readonly string[] = [".log", ".txt", ".md", ".json", ".jsonl", ".html"];

export interface NotUploaded {
  path: string;
  /** What it is, by name: zip, tar, trace, video, har, gzip, png-less binary types, or `unknown`. */
  type: string;
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  ".zip": "zip",
  ".jar": "zip",
  ".tar": "tar",
  ".tgz": "tar",
  ".gz": "gzip",
  ".bz2": "bzip2",
  ".xz": "xz",
  ".7z": "7z",
  ".rar": "rar",
  ".trace": "trace",
  ".har": "har",
  ".webm": "video",
  ".mp4": "video",
  ".mov": "video",
  ".mkv": "video",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
};

function extensionOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** The `<type>` of `not-uploaded:<type>`. */
export function notUploadedType(rel: string): string {
  return TYPE_BY_EXTENSION[extensionOf(rel)] ?? "unknown";
}

/** `**` matches across folders, `*` within one name, `?` one character. A glob without a slash matches the file name. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 1;
      if (glob[i + 1] === "/") i += 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function matchesGlob(rel: string, globs: readonly string[]): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return globs.some((g) => globToRegExp(g).test(g.includes("/") ? rel : base));
}

/** Layer for the opt-in: never on the production target. Returns the refusal reason, or null when allowed. */
export function includeUnscannedRefusal(targetName: string): string | null {
  return targetName === "production" ? "include-unscanned-on-production" : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The text of a PNG's tEXt, iTXt and zTXt chunks (decompressed), as Latin-1 strings. Throws `Unscannable`. */
function pngTextChunks(buf: Buffer): string[] {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Unscannable("png-invalid");
  const out: string[] = [];
  const inflate = (b: Buffer): string => {
    try {
      return inflateSync(b, { maxOutputLength: MAX_INFLATE }).toString("latin1");
    } catch {
      throw new Unscannable("png-inflate-failed-or-too-large");
    }
  };
  let p = 8;
  for (;;) {
    if (p + 12 > buf.length) throw new Unscannable("png-no-iend");
    const len = buf.readUInt32BE(p);
    if (p + 12 + len > buf.length) throw new Unscannable("png-truncated");
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "tEXt") out.push(data.toString("latin1"));
    else if (type === "zTXt") {
      const nul = data.indexOf(0);
      if (nul < 0 || nul + 2 > data.length) throw new Unscannable("png-invalid");
      out.push(data.toString("latin1", 0, nul), inflate(data.subarray(nul + 2)));
    } else if (type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul < 0 || nul + 3 > data.length) throw new Unscannable("png-invalid");
      const compressed = data[nul + 1] === 1;
      const lang = data.indexOf(0, nul + 3);
      const translated = lang < 0 ? -1 : data.indexOf(0, lang + 1);
      if (translated < 0) throw new Unscannable("png-invalid");
      const body = data.subarray(translated + 1);
      out.push(data.toString("latin1", 0, translated), compressed ? inflate(body) : body.toString("latin1"));
    }
    p += 12 + len;
    if (type === "IEND") {
      if (p !== buf.length) throw new Unscannable("png-trailing-data");
      return out;
    }
  }
}

export interface ScanOptions {
  /** Called after each file is scanned. Used by tests to register a value while the scan is running. */
  onFileScanned?: (relPath: string) => void;
  /** Debugging opt-in: globs of non-allowlisted files to put in the upload set without looking inside them. */
  includeUnscanned?: readonly string[];
}

export interface ScanResult {
  files: number;
  /** Anything that must fail the step: a secret, or a file that claims to be allowed but is not what it claims. */
  findings: Finding[];
  /** The files that may be uploaded: allowlisted and clean, plus opted-in files. */
  upload: string[];
  /** Files left out of the upload set because their type is not on the allowlist. Not an error. */
  notUploaded: NotUploaded[];
  /** The opted-in files that are in the upload set unscanned. */
  includedUnscanned: string[];
}

/** `rel`, or a numbered placeholder when the name itself holds a secret (so no finding echoes one). */
function shownName(rel: string, n: number, what: string, ctx: ScrubContext): string {
  try {
    return detect(rel, ctx).length > 0 ? `<${what} ${n}>` : rel;
  } catch {
    return `<${what} ${n}>`;
  }
}

function* walk(root: string, dir: string, notUploaded: NotUploaded[], ctx: ScrubContext, counter: { n: number }): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      // Never followed, never uploaded.
      counter.n += 1;
      notUploaded.push({ path: shownName(rel, counter.n, "symlink", ctx), type: "symlink" });
    } else if (st.isDirectory()) yield* walk(root, full, notUploaded, ctx, counter);
    else if (st.isFile()) yield rel;
    else {
      counter.n += 1;
      notUploaded.push({ path: shownName(rel, counter.n, "special file", ctx), type: "special-file" });
    }
  }
}

function insideDir(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

// ---------------------------------------------------------------------------------------------------------
// The one archive we read: Playwright's HTML report.
//
// `playwright-report/index.html` keeps each test's stdout, errors and attachments in a zip, base64-encoded in
// `<template id="playwrightReportBase64">data:application/zip;base64,...</template>`. That is a first-party format
// our own runs produce, so it is read, with hard bounds, and every entry is scanned like an uploaded file. Any
// other archive carried inside a text file is not parsed: the file is simply not uploaded.

const REPORT_TEMPLATE = '<template id="playwrightReportBase64"';
const REPORT_DATA_PREFIX = "data:application/zip;base64,";
export const REPORT_LIMITS = {
  entries: 5000,
  /** Total inflated bytes across the report, and the largest single entry. */
  totalBytes: 256 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  /** Inflated size over compressed size, checked for entries larger than 1 MiB. */
  ratio: 1000,
} as const;

interface ReportEntry {
  name: string;
  data: Buffer;
}

/** The report's zip, read from its central directory. Stored and deflate entries only; anything else throws. */
function readReportZip(buf: Buffer): ReportEntry[] {
  const eocd = buf.length < 22 ? -1 : buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), buf.length - 22);
  if (eocd < 0) throw new Unscannable("report-zip-invalid");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLen !== buf.length) throw new Unscannable("report-zip-trailing-data");
  if (count === 0xffff || cdOffset + cdSize !== eocd) throw new Unscannable("report-zip-invalid");
  if (count > REPORT_LIMITS.entries) throw new Unscannable("report-too-many-entries");
  const entries: ReportEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Unscannable("report-zip-invalid");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (next > eocd) throw new Unscannable("report-zip-invalid");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p = next;
    if ((flags & 1) !== 0) throw new Unscannable("report-zip-encrypted");
    if (local + 30 > cdOffset || buf.readUInt32LE(local) !== 0x04034b50) throw new Unscannable("report-zip-invalid");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compSize > cdOffset) throw new Unscannable("report-zip-invalid");
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.min(REPORT_LIMITS.entryBytes, REPORT_LIMITS.totalBytes - total) });
      } catch {
        throw new Unscannable("report-too-large");
      }
    } else throw new Unscannable(`report-zip-method-${method}`);
    if (data.length > 1024 * 1024 && data.length / Math.max(1, raw.length) > REPORT_LIMITS.ratio) throw new Unscannable("report-compression-ratio");
    total += data.length;
    if (total > REPORT_LIMITS.totalBytes) throw new Unscannable("report-too-large");
    if (!name.endsWith("/")) entries.push({ name, data });
  }
  return entries;
}

/** The text with the report payload(s) cut out, and the decoded zips. Throws `Unscannable` on a shape we do not know. */
function splitReport(text: string): { rest: string; zips: Buffer[] } {
  const zips: Buffer[] = [];
  let rest = text;
  for (let at = rest.indexOf(REPORT_TEMPLATE); at >= 0; at = rest.indexOf(REPORT_TEMPLATE)) {
    const open = rest.indexOf(">", at);
    const close = open < 0 ? -1 : rest.indexOf("</template>", open);
    if (close < 0) throw new Unscannable("report-unknown-format");
    const payload = rest.slice(open + 1, close).trim();
    if (!payload.startsWith(REPORT_DATA_PREFIX)) throw new Unscannable("report-unknown-format");
    zips.push(Buffer.from(payload.slice(REPORT_DATA_PREFIX.length), "base64"));
    rest = rest.slice(0, at) + rest.slice(close + "</template>".length);
  }
  return { rest, zips };
}

function looksLikeArchiveHeader(b: Buffer, at: number): boolean {
  if (b[at] === 0x50 && b[at + 1] === 0x4b && b[at + 2] === 3 && b[at + 3] === 4) return at + 10 <= b.length && b.readUInt16LE(at + 8) <= 14;
  if (b[at] === 0x1f && b[at + 1] === 0x8b && b[at + 2] === 8) return at + 10 <= b.length && ((b[at + 3] as number) & 0xe0) === 0 && [0, 2, 4].includes(b[at + 8] as number) && ((b[at + 9] as number) <= 13 || b[at + 9] === 255);
  return false;
}

/** A base64 run (at any alignment) that decodes to a zip or gzip header. Such a file is not uploaded, and not parsed. */
function hasEmbeddedArchive(text: string): boolean {
  const magics = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x1f, 0x8b, 0x08])];
  for (const run of base64Runs(text)) {
    if (run.length < 24) continue;
    for (const decoded of base64Decodings(run)) {
      const data = Buffer.from(decoded, "latin1");
      for (const magic of magics) {
        let at = data.indexOf(magic);
        for (let tries = 0; at >= 0 && tries < 64; tries += 1) {
          if (looksLikeArchiveHeader(data, at)) return true;
          at = data.indexOf(magic, at + 1);
        }
      }
    }
  }
  return false;
}


/**
 * Walks `dir` and decides, file by file, what may be uploaded. Values registered while it runs are honoured: if the
 * registry changed during a pass, the whole folder is scanned again (a bounded number of times, then it fails
 * closed). A file that cannot be read or makes the scan fail internally is a finding, never an exception.
 */
export function scanDir(dir: string, ctx: ScrubContext = {}, options: ScanOptions = {}): ScanResult {
  const registry = ctx.registry;
  const globs = options.includeUnscanned ?? [];
  for (let pass = 0; pass < 5; pass += 1) {
    registry?.loadFile();
    const versionAtStart = registry?.version ?? 0;
    const findings: Finding[] = [];
    const upload: string[] = [];
    const notUploaded: NotUploaded[] = [];
    const includedUnscanned: string[] = [];
    const counter = { n: 0 };
    let files = 0;
    if (registry?.file !== undefined && insideDir(dir, registry.file)) {
      counter.n += 1;
      findings.push({
        path: shownName(relative(dir, registry.file) || ".", counter.n, "mask file", ctx),
        kind: "unscannable:mask-file-inside-artifacts",
        via: "plain",
      });
    }
    for (const rel of walk(dir, dir, notUploaded, ctx, counter)) {
      files += 1;
      const shown = shownName(rel, files, "file", ctx);
      const before = findings.length;
      if (shown !== rel) findings.push({ path: shown, kind: "file-name", via: "plain" });
      const ext = extensionOf(rel);
      const isText = TEXT_EXTENSIONS.includes(ext);
      const isPng = ext === ".png";
      const optedIn = !isText && !isPng && globs.length > 0 && matchesGlob(rel, globs);
      if (!isText && !isPng && !optedIn) {
        notUploaded.push({ path: shown, type: notUploadedType(rel) });
        options.onFileScanned?.(rel);
        continue;
      }
      let data: Buffer | null = null;
      let excludeType: string | null = null;
      try {
        data = readFileSync(join(dir, rel));
      } catch {
        findings.push({ path: shown, kind: "unscannable:read-failed", via: "plain" });
      }
      if (data !== null) {
        const add = (kind: string, via = "plain") => findings.push({ path: shown, kind, via });
        try {
          if (isText) {
            if (data.includes(0)) add("unscannable:not-text");
            else {
              let text: string | null = null;
              try {
                text = STRICT_UTF8.decode(data);
              } catch {
                add("unscannable:not-utf8");
              }
              if (text !== null) {
                let body = text;
                if (ext === ".html" && text.includes(REPORT_TEMPLATE)) {
                  const split = splitReport(text);
                  body = split.rest;
                  for (const zip of split.zips) {
                    for (const entry of readReportZip(zip)) {
                      for (const h of detect(entry.name, ctx)) add(h.kind, `report-entry-name>${h.via}`);
                      let entryText: string | null = null;
                      if (!entry.data.includes(0)) {
                        try {
                          entryText = STRICT_UTF8.decode(entry.data);
                        } catch {
                          entryText = null;
                        }
                      }
                      if (entryText !== null) for (const h of detect(entryText, ctx)) add(h.kind, `report>${h.via}`);
                      else if (entry.data.length >= 8 && entry.data.subarray(0, 8).equals(PNG_SIGNATURE)) {
                        for (const h of detect(entry.data.toString("latin1"), ctx)) add(h.kind, `report>${h.via}`);
                        for (const t of pngTextChunks(entry.data)) for (const h of detect(t, ctx)) add(h.kind, `report>png-text>${h.via}`);
                      } else excludeType = "report-binary-attachment";
                    }
                  }
                }
                for (const h of detect(body, ctx)) add(h.kind, h.via);
                if (hasEmbeddedArchive(body)) excludeType = "embedded-archive";
              }
            }
          } else if (isPng) {
            // The raw bytes first (metadata the chunk walk does not decode), then each text chunk.
            for (const h of detect(data.toString("latin1"), ctx)) add(h.kind, h.via);
            for (const text of pngTextChunks(data)) for (const h of detect(text, ctx)) add(h.kind, `png-text>${h.via}`);
          } else {
            // Opted in: uploaded without being opened. Only the raw bytes get the plain check.
            for (const h of detect(data.toString("latin1"), ctx)) add(h.kind, h.via);
          }
        } catch (err) {
          // A stack overflow or similar is reported without its message, which could quote the content.
          add(err instanceof Unscannable ? `unscannable:${err.message}` : "unscannable:internal-error");
        }
      }
      if (excludeType !== null) notUploaded.push({ path: shown, type: excludeType });
      else if (findings.length === before) {
        upload.push(rel);
        if (optedIn) includedUnscanned.push(rel);
      }
      options.onFileScanned?.(rel);
    }
    registry?.loadFile();
    if ((registry?.version ?? 0) === versionAtStart) return { files, findings, upload, notUploaded, includedUnscanned };
  }
  return {
    files: 0,
    findings: [{ path: ".", kind: "unscannable:mask-registry-kept-changing", via: "plain" }],
    upload: [],
    notUploaded: [],
    includedUnscanned: [],
  };
}

/** One line per finding, safe to print: path, kind and route, never the value. */
export function describeFinding(f: Finding): string {
  return `${f.path}: ${f.kind} (${f.via})`;
}
