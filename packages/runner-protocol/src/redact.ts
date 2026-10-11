/**
 * Credential redaction. Applied to every string a runtime is about to hand
 * to `onEvent`, a thrown error, or a log call, so a secret that legitimately
 * has to sit in a spawned process's env (the owner's OAuth token, a
 * tenant's brokered key) never has to be readable in the emitted event
 * stream, an error message, or logs (Spec H04 pass/fail 7; fix-round item
 * 4 added shape-based redaction on top of exact-value redaction; fix-round
 * 2 item 6 fixed the vck_ pattern's truncated tail, added sk-ant-admin, and
 * made redactError preserve the error's class and recurse into `.cause`).
 */

const REDACTED = "[redacted]";

/** Replace every occurrence of any non-empty secret in `secrets` with a
 * fixed placeholder. Order-independent, exact substring match — this is a
 * safety net for known values, not a general secret-shape detector; pair it
 * with `redactShapes` below for values we never captured verbatim. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Token-shape pattern SOURCES (strings, not compiled `RegExp`s) for the
 * credential shapes this runtime's env can legitimately hold, matched
 * independently of whether we ever captured the exact value as a "known
 * secret" — e.g. a token that arrived inside model output text we never set
 * ourselves. Exported as named sources — not a single opaque array — so
 * `src/production/guard.ts` can import and test against the EXACT SAME
 * pattern this module redacts with (fix-round 2 item 2: the guard used to
 * have its own hand-rolled `startsWith` check that had quietly drifted from
 * this module's actual redaction shape).
 *
 * Kept as strings rather than pre-built `RegExp` objects because every one
 * of these gets used both for `.replace(/…/g, …)` (global) and for a plain
 * existence `.test(…)` (non-global) — sharing one `/g`-flagged `RegExp`
 * instance across repeated `.test()` calls is a classic footgun (a global
 * regex's `.test()` advances its own `lastIndex`, so alternating calls on
 * different strings silently return false on every other call). `compile()`
 * below always builds a fresh instance, so neither call site can trip it.
 *
 *   - `sk-ant-oat…`   — Claude Code subscription OAuth token.
 *   - `sk-ant-api…`   — a raw Anthropic API key.
 *   - `sk-ant-admin…` — an Anthropic admin API key.
 *   - `vck_…`         — a Vercel AI Gateway API key (confirmed prefix in
 *     the AI Gateway API-key documentation, which shows keys masked as
 *     `vck_••••1234`).
 *
 * Anchored on the prefix plus a run of token-alphabet characters — no fixed
 * length, since none of these shapes documents one, and requiring a long
 * tail avoids matching the bare prefix inside unrelated prose. The
 * character class includes `-` and `_`: fix-round 2 item 6 found the old
 * `vck_` pattern's class (`[A-Za-z0-9]` only) left a real key's `-`/`_`
 * characters — and everything after the first one — outside the match,
 * redacting only the token's head and leaving its tail printed in full.
 */
export const SK_ANT_OAT_PATTERN_SOURCE = "sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{10,}";
export const SK_ANT_API_PATTERN_SOURCE = "sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{10,}";
export const SK_ANT_ADMIN_PATTERN_SOURCE = "sk-ant-admin[0-9]{2}-[A-Za-z0-9_-]{10,}";
export const VCK_PATTERN_SOURCE = "vck_[A-Za-z0-9_-]{10,}";

export const TOKEN_SHAPE_PATTERN_SOURCES: readonly string[] = [
  SK_ANT_OAT_PATTERN_SOURCE,
  SK_ANT_API_PATTERN_SOURCE,
  SK_ANT_ADMIN_PATTERN_SOURCE,
  VCK_PATTERN_SOURCE,
];

/**
 * OPS-T1: the shapes the telemetry logger adds on top of the four above (the engine's
 * `backend/redaction.py` patterns, this cloud's own shapes, and context secrets). A SEPARATE
 * list: `TOKEN_SHAPE_PATTERN_SOURCES` and the production guard's env-refusal lists are
 * untouched, while `redactShapes` applies both. Shapes that keep their label replace with
 * `$1[redacted]`. Every pattern must stay linear (CWE-1333): a literal anchor first, bounded
 * repetition before any required character; `test/redaction-timing.test.ts` enforces it.
 */
const JWT_SEGMENT_MAX = 16384;

export interface TelemetryShape {
  readonly name: string;
  readonly source: string;
  readonly flags: string;
  readonly replacement: string;
  /** When set, the match is KEPT if its value (group 2) plus the rest of the line (group 3, if any) is plain prose. */
  readonly prose?: boolean;
}

/** A credential word as a whole SEGMENT anywhere in a name: bounded before by the start, a non-alphanumeric
 * (`_ . -`) or a camel step, and after by the end, a non-alphanumeric or an upper-case step (apiKeyId); an
 * all-upper-case run ending in the word counts too (DBPASS). Boundaries are lookbehinds and lookaheads, with no
 * prefix quantifier, so a name of any length is found. Kept on purpose: not a whole segment (keyboard, bypass,
 * passport), TOKENS plural (max_tokens), and the word followed directly by a measurement segment (token_count,
 * token_limit, KEY_TYPE). The tail after the word is bounded, as on main. */
const CRED_WORDS = ["KEY", "KEYS", "APIKEY", "APIKEYS", "TOKEN", "SECRET", "SECRETS", "PASSWORD", "PASSWORDS", "PASSWD", "PASS", "PWD", "CREDENTIAL", "CREDENTIALS"];
const MEASURE_WORDS = ["COUNT", "COUNTS", "LIMIT", "LEN", "LENGTH", "SIZE", "TYPE", "TTL"];
const anyCase = (w: string): string => w.replace(/./g, (c) => `[${c}${c.toLowerCase()}]`);
const capitalised = (w: string): string => w[0] + w.slice(1).toLowerCase();
const CRED_NAME =
  `(?:(?<![A-Za-z0-9])(?:${CRED_WORDS.map((w) => w.toLowerCase()).join("|")})(?![a-z])` +
  `|(?:(?<=[a-z0-9])|(?<![A-Za-z0-9]))(?:${CRED_WORDS.map(capitalised).join("|")})(?![a-z])` +
  `|(?<![a-z])(?:${CRED_WORDS.join("|")})(?![A-Za-z]))` +
  `(?![_.-]?(?:${MEASURE_WORDS.map(anyCase).join("|")})(?![A-Za-z0-9]))`;
// Atomic (a lookahead capture, group 2): the run before the delimiter is read once, never re-scanned by backtracking.
const NAME_TAIL = String.raw`(?=([A-Za-z0-9_.-]{0,64}))\2`;
/** A quoted value (quotes may carry up to 8 backslashes; group 3 is the opener) or, failing that, `unquoted`.
 * The quoted body may cross newlines (a PEM key) and runs to its closing quote or, if there is none, to the end
 * of the string (fail closed). Each character is consumed once, so it stays linear. */
const quotedOr = (unquoted: string): string =>
  String.raw`(?:(\\{0,8}["'])(?:(?!\3)(?:\\[^]|[^\\]))*(?:\3)?|${unquoted})`;

const PROSE = /^[A-Za-z]{1,15}[.,;!?]?(?:[ \t]+[A-Za-z]{1,15}[.,;!?]?){2,}$/;
const AUTH_SCHEME = /^(?:basic|bearer|digest|negotiate|ntlm|token|hmac|apikey|api-key|oauth|jwt|mac|hawk|bot)\b/i;
/** Plain prose: three or more letters-only words (none over 15 letters, a trailing . , ; ! ? allowed), nothing
 * else, at most 256 characters, and not a scheme word followed by a token. Everything else is a secret. Only
 * header values and a Bearer value may be prose; a value after a credential NAME never is. */
function isProse(text: string): boolean {
  const t = text.trimEnd();
  return t.length <= 256 && PROSE.test(t) && !AUTH_SCHEME.test(t);
}

export const TELEMETRY_SHAPES: readonly TelemetryShape[] = [
  { name: "github_pat", source: "github_pat_[A-Za-z0-9_]{36,}", flags: "g", replacement: REDACTED },
  { name: "github_prefixed_token", source: "gh[pshour]_[A-Za-z0-9]{36,}", flags: "g", replacement: REDACTED },
  {
    // A bare 40-hex run is a git SHA, so the classic PAT form needs a token-context keyword before it.
    name: "classic_gh_pat",
    source:
      "((?:Authorization\\s{0,16}:\\s{0,16}token\\s{1,16})|(?:x-access-token\\s{0,16}:\\s{0,16})|(?:(?:token|pat|github[_-]token|gh[_-]token|x[_-]auth[_-]token)\\s{0,16}[=:]\\s{0,16}))" +
      "[0-9a-f]{40}(?![0-9a-f])",
    flags: "gi",
    replacement: `$1${REDACTED}`,
  },
  { name: "slack_token", source: "xox[pbar]-[A-Za-z0-9-]{10,}", flags: "g", replacement: REDACTED },
  { name: "sk_ant_key", source: "sk-ant-[A-Za-z0-9_-]{20,}", flags: "g", replacement: REDACTED },
  // G2: the whole sk-ant family, whatever its kind word, with a short tail too (the pattern above needs 20+ characters,
  // so an invented `sk-ant-zzz42-` variant with a shorter tail would slip past it). Kind and digits are bounded.
  { name: "sk_ant_family", source: "sk-ant-[a-z]{1,32}[0-9]{0,8}-[A-Za-z0-9_-]{10,}", flags: "g", replacement: REDACTED },
  // G2: GitHub app and personal tokens with a short tail (the shape above needs 36+), and the runner registration code.
  { name: "github_short_token", source: "gh[ps]_[A-Za-z0-9]{10,}", flags: "g", replacement: REDACTED },
  { name: "fxrr", source: "fxrr_[A-Za-z0-9_-]{10,}", flags: "g", replacement: REDACTED },
  { name: "fxrp", source: "fxrp_[A-Za-z0-9_-]{10,}", flags: "g", replacement: REDACTED },
  // OpenAI: `sk-proj-...`, and legacy `sk-` + 32+ alphanumerics after a non-token char ("task-force" never matches).
  { name: "openai_proj_key", source: "sk-proj-[A-Za-z0-9_-]{20,}", flags: "g", replacement: REDACTED },
  { name: "openai_legacy_key", source: "(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{32,}", flags: "g", replacement: REDACTED },
  { name: "aws_access_key", source: "AKIA[0-9A-Z]{16}", flags: "g", replacement: REDACTED },
  // Bounded userinfo: an unbounded `[^@\s]+` before a required `@` is quadratic on "postgres://postgres://...".
  { name: "postgres_uri", source: "postgres(?:ql)?://[^@\\s]{1,256}@[^\\s\"']+", flags: "g", replacement: REDACTED },
  { name: "fxat", source: "fxat_[A-Za-z0-9_-]{10,}", flags: "g", replacement: REDACTED },
  { name: "vercel_token", source: "vc[pia]_[A-Za-z0-9_-]{10,}", flags: "g", replacement: REDACTED },
  { name: "whsec", source: "whsec_[A-Za-z0-9+/=_-]{10,}", flags: "g", replacement: REDACTED },
  { name: "stripe_key", source: "(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{10,}", flags: "g", replacement: REDACTED },
  {
    name: "session_cookie",
    source: "(__Host-fx(?:_ops)?_session=)[^\\s;,\"'\\\\]+",
    flags: "g",
    replacement: `$1${REDACTED}`,
  },
  { name: "gh_token_env", source: "GH_TOKEN=[^\\s\"']+", flags: "g", replacement: `GH_TOKEN=${REDACTED}` },
  {
    name: "bearer_token",
    source: "(Bearer\\s{1,64})([A-Za-z0-9\\-._~+/]+=*)(?=([^\\r\\n\"']{0,257}))",
    flags: "gi",
    replacement: `Bearer ${REDACTED}`,
    prose: true,
  },
  // The lookbehind allows a start only at the head of a token-character run: "eyJeyJeyJ..." has one
  // start, not one per "eyJ" (the unanchored form was quadratic, 26 s at 240k characters).
  {
    name: "jwt_token",
    source: `(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{1,${JWT_SEGMENT_MAX}}\\.[A-Za-z0-9_-]{1,${JWT_SEGMENT_MAX}}(?:\\.[A-Za-z0-9_-]{0,${JWT_SEGMENT_MAX}})?`,
    flags: "g",
    replacement: REDACTED,
  },
  // CONTEXT secrets: the VALUE is redacted by where it sits, whatever it looks like.
  // URL query parameters with a credential-ish name.
  {
    name: "url_query_secret",
    source: "([?&;](?:access_token|token|api_key|apikey|key|secret|password|auth)=)[^&\\s#\"']+",
    flags: "gi",
    replacement: `$1${REDACTED}`,
  },
  // URL userinfo, "scheme://user:PASS@host".
  { name: "url_userinfo", source: "(?<=://)([^\\s:/@]{0,256}:)[^\\s@/]{1,256}(?=@)", flags: "g", replacement: `$1${REDACTED}` },
  // Header values (the rest of the line, or up to a closing quote when JSON-encoded; quotes may be backslash-escaped).
  {
    name: "secret_header",
    source:
      "\\b((?:authorization|x-api-key|api-key|x-auth-token|set-cookie|cookie)\\\\{0,8}[\"']?\\s{0,8}[:=]\\s{0,8}\\\\{0,8}[\"']?)([^\\r\\n\"']+)",
    flags: "gi",
    replacement: `$1${REDACTED}`,
    prose: true,
  },
  // CREDENTIAL-NAMED values: NAME=value, `NAME: value` (rest of the line) and JSON "NAME": "value" (the whole string).
  { name: "env_secret", source: `(${CRED_NAME}${NAME_TAIL}[ \\t]{0,8}={1,3}[ \\t]{0,8})${quotedOr(String.raw`[^\s"'&;]+`)}`, flags: "g", replacement: `$1${REDACTED}` },
  { name: "label_secret", source: `(${CRED_NAME}${NAME_TAIL}\\s{0,8}:\\s{0,8})${quotedOr(String.raw`[^\r\n]+`)}`, flags: "g", replacement: `$1${REDACTED}` },
  {
    name: "json_secret",
    source: `(${CRED_NAME}${NAME_TAIL}\\\\{0,8}["']\\s{0,8}:\\s{0,8}(\\\\{0,8}["']))(?:(?!\\3)(?:\\\\[^]|[^\\\\]))*`,
    flags: "g",
    replacement: `$1${REDACTED}`,
  },
];

export const TELEMETRY_SHAPE_PATTERN_SOURCES: readonly string[] = TELEMETRY_SHAPES.map((shape) => shape.source);

function compile(source: string, flags: string): RegExp {
  return new RegExp(source, flags);
}

/** True if `text` contains a substring matching `patternSource` ANYWHERE —
 * not just as a prefix or a full match (fix-round 2 item 2: the guard's old
 * `value.startsWith(prefix)` check let `"Bearer sk-ant-oat01-…"` or
 * `" sk-ant-oat01-…"` through). Builds a fresh non-global `RegExp` per call
 * — see the module doc comment above for why a shared `/g` instance would
 * be unsafe here. */
export function matchesShape(text: string, patternSource: string): boolean {
  return compile(patternSource, "").test(text);
}

/** Strings are scanned in windows of this many characters (CWE-1333: no input can make one regex
 * run span an unbounded text). Nothing is dropped: the whole string comes back, redacted. */
export const SCAN_CHUNK_CHARS = 64 * 1024;
/** Look-ahead past a window's chunk, so a match that starts inside the chunk is seen whole. The
 * longest span a bounded pattern needs is the JWT (three segments of JWT_SEGMENT_MAX plus two dots
 * and `eyJ`); every other bounded span (userinfo 514, Bearer 70, ...) is far smaller. Patterns with
 * an unbounded tail are handled by growing the window instead (see `replaceChunked`). */
export const SCAN_OVERLAP_CHARS = 3 * JWT_SEGMENT_MAX + 256;
/** Characters of look-behind kept so the lookbehind patterns (JWT, userinfo, legacy `sk-`) see the
 * same context they would in an unchunked scan; the longest lookbehind is `://`. */
const SCAN_CONTEXT_CHARS = 3;
/** A match that ends within this many characters of its window's end may have been cut short by the window,
 * not by the pattern, so the window is regrown. The pattern with the longest look-ahead is a quoted body: it
 * stops where its closing delimiter (up to 8 backslashes plus a quote, 9 characters) or an escape pair
 * (backslash plus the escaped character) is only partly inside the window. Such a stop lies at most 8
 * characters from the end (a delimiter of 9 with 8 present) or 1 (a lone trailing backslash), so
 * `e > win.length - 9` catches every one; matches ending earlier were ended by the text itself. */
const SCAN_END_MARGIN = 9;

/** `text.replace(new RegExp(source, flags), replacement)` for a global pattern, run window by window.
 * Matches are taken in order and never overlap, exactly as in one unchunked pass. A match that
 * reaches the end of its window might continue past it, so the window restarts at that match with
 * twice the reach (amortised linear); a match that starts in the chunk always fits in the overlap. */
function replaceChunked(text: string, source: string, flags: string, replacement: string, prose = false): string {
  const base = SCAN_CHUNK_CHARS + SCAN_OVERLAP_CHARS;
  if (text.length <= base && !prose) return text.replace(compile(source, flags), replacement);
  const expand = (m: RegExpMatchArray): string =>
    prose && isProse((m[2] ?? "") + (m[3] ?? "")) ? m[0] : replacement.startsWith("$1") ? (m[1] ?? "") + replacement.slice(2) : replacement;
  let out = "";
  let pos = 0;
  let reach = base;
  while (pos < text.length) {
    const from = Math.max(0, pos - SCAN_CONTEXT_CHARS);
    const ctx = pos - from;
    const win = text.slice(from, Math.min(text.length, pos + reach));
    const last = from + win.length === text.length;
    let cursor = ctx;
    let regrow = false;
    for (const m of win.matchAll(compile(source, flags))) {
      const s = m.index ?? 0;
      const e = s + m[0].length;
      if (s < ctx) continue;
      if (!last && s - ctx >= SCAN_CHUNK_CHARS) break;
      if (!last && e > win.length - SCAN_END_MARGIN) {
        out += win.slice(cursor, s);
        pos = from + s;
        reach *= 2;
        regrow = true;
        break;
      }
      out += win.slice(cursor, s) + expand(m);
      cursor = e;
    }
    if (regrow) continue;
    const next = last ? text.length : Math.max(pos + SCAN_CHUNK_CHARS, from + cursor);
    out += win.slice(cursor, next - from);
    pos = next;
    reach = base;
  }
  return out;
}

/** Redact every substring matching a known credential shape, regardless of
 * whether its exact value was ever captured as a "known secret". */
export function redactShapes(text: string): string {
  let out = text;
  for (const source of TOKEN_SHAPE_PATTERN_SOURCES) {
    out = replaceChunked(out, source, "g", REDACTED);
  }
  for (const shape of TELEMETRY_SHAPES) {
    out = replaceChunked(out, shape.source, shape.flags, shape.replacement, shape.prose);
  }
  return out;
}

/** `redactSecrets` (known exact values) followed by `redactShapes`
 * (credential-shaped values generally) — the combination every emission
 * path in this package uses. */
export function redactText(text: string, secrets: readonly (string | undefined)[]): string {
  return redactShapes(redactSecrets(text, secrets));
}

/** Recursively redact every string value in a JSON-like structure with
 * `redactText`. Used to sanitize a `NormalizedEvent` (or any object) before
 * it is emitted or logged. */
export function redactDeep<T>(value: T, secrets: readonly (string | undefined)[]): T {
  const activeSecrets = secrets.filter((secret): secret is string => Boolean(secret));
  return redactAny(value, activeSecrets) as T;
}

function redactAny(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAny(item, secrets));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactAny(val, secrets);
    }
    return result;
  }
  return value;
}

/** Recursively redact an error's `.cause` chain — a `cause` may itself be an
 * `Error` (redact it the same way, preserving ITS class too), a string, or
 * any other JSON-ish value. */
function redactCause(cause: unknown, secrets: readonly (string | undefined)[]): unknown {
  if (cause instanceof Error) return redactError(cause, secrets);
  if (typeof cause === "string") return redactText(cause, secrets);
  if (cause !== null && typeof cause === "object") return redactDeep(cause, secrets);
  return cause;
}

/**
 * Redact a thrown/caught error's message, stack, and (recursively) its
 * `.cause` before it is rethrown, logged, or otherwise surfaced — an error
 * from a spawned process can legitimately quote its own env or command
 * line, which is exactly where a credential would otherwise leak.
 *
 * Preserves the error's actual prototype/class (fix-round 2 item 6): the
 * previous version collapsed every redacted error to a plain `Error` with
 * `.name` copied over as a string, so `redactError(err) instanceof
 * LocalRunnerRefused` was false even when `err` was one — a caller
 * upstream of a redaction point (e.g. a test, or future orchestration code)
 * that does an `instanceof` check on a specific error class would silently
 * stop matching the moment that error passed through redaction. Builds via
 * `Object.create(Object.getPrototypeOf(error))` rather than calling the
 * original constructor, since a constructor might require arguments this
 * function doesn't have.
 */
export function redactError(error: unknown, secrets: readonly (string | undefined)[]): Error {
  if (error instanceof Error) {
    const redacted = Object.create(Object.getPrototypeOf(error)) as Error & { cause?: unknown };
    redacted.message = redactText(error.message, secrets);
    redacted.name = error.name;
    if (error.stack) redacted.stack = redactText(error.stack, secrets);
    if ("cause" in error) {
      redacted.cause = redactCause((error as { cause?: unknown }).cause, secrets);
    }
    return redacted;
  }
  return new Error(redactText(String(error), secrets));
}
