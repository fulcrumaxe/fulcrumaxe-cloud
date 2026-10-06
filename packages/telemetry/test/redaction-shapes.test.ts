import { describe, expect, it } from "vitest";
import {
  redactDeep,
  redactError,
  redactShapes,
  SCAN_CHUNK_CHARS,
  TELEMETRY_SHAPES,
  TOKEN_SHAPE_PATTERN_SOURCES,
} from "@fx/runtime/src/redact.js";

/**
 * Every fixture is assembled at run time, never written as a literal, so no
 * secret scanner (GitHub push protection included) flags this file.
 */
const A = "AbCdEf0123456789"; // 16 token-alphabet characters
const alnum = (n: number): string => A.repeat(Math.ceil(n / A.length)).slice(0, n);
const hex40 = "0123456789abcdef".repeat(3).slice(0, 40);

interface Row {
  shape: string; // a TELEMETRY_SHAPES name, or "existing"
  sample: string;
  /** The part of `sample` that must be gone from the output. */
  secret: string;
}

function row(shape: string, secret: string, prefix = "", suffix = ""): Row {
  return { shape, sample: prefix + secret + suffix, secret };
}

const ROWS: Row[] = [
  row("existing", ["sk", "ant", "oat01"].join("-") + "-" + alnum(30)),
  row("existing", ["sk", "ant", "api03"].join("-") + "-" + alnum(30)),
  row("existing", ["sk", "ant", "admin01"].join("-") + "-" + alnum(30)),
  row("existing", "vck" + "_" + alnum(30)),
  row("github_pat", "github" + "_pat_" + alnum(40)),
  row("github_prefixed_token", "ghp" + "_" + alnum(40)),
  row("github_prefixed_token", "ghs" + "_" + alnum(40)),
  row("github_prefixed_token", "gho" + "_" + alnum(40)),
  row("github_prefixed_token", "ghu" + "_" + alnum(40)),
  row("github_prefixed_token", "ghr" + "_" + alnum(40)),
  row("classic_gh_pat", hex40, "token: "),
  row("slack_token", "xox" + "b-" + "1234567890-" + alnum(12)),
  row("slack_token", "xox" + "p-" + "1234567890-" + alnum(12)),
  row("slack_token", "xox" + "a-" + "1234567890-" + alnum(12)),
  row("slack_token", "xox" + "r-" + "1234567890-" + alnum(12)),
  row("openai_proj_key", "sk-" + "proj-" + alnum(40) + "_" + alnum(10)),
  row("openai_legacy_key", "sk" + "-" + alnum(48), "key was "),
  row("vercel_token", "vc" + "p_" + alnum(30)),
  row("vercel_token", "vc" + "i_" + alnum(30)),
  row("vercel_token", "vc" + "a_" + alnum(30)),
  row("stripe_key", "rk" + "_test_" + alnum(24)),
  // Context secrets: the value has no shape of its own.
  row("url_query_secret", "plainvalue123", "https://h.example/cb?access_token="),
  row("url_userinfo", "hunter2pass", "https://alice:", "@h.example/p"),
  row("secret_header", "opaque-value-123", "x-api-key: "),
  row("env_secret", "opaquevalue9", "DB_PASSWORD="),
  row("label_secret", "opaquevalue9", "db_password: "),
  row("json_secret", "opaquevalue9", '{"clientSecret":"', '"}'),
  row("secret_header", "opaque-value-123", "x-auth-token: "),
  row("sk_ant_key", ["sk", "ant", "zzz"].join("-") + "-" + alnum(24)),
  row("sk_ant_family", ["sk", "ant", "zzz42"].join("-") + "-" + alnum(12)),
  row("github_short_token", "gh" + "s_" + alnum(12)),
  row("fxrr", "fx" + "rr_" + alnum(12)),
  row("aws_access_key", "AK" + "IA" + "ABCDEFGH01234567"),
  row("postgres_uri", "postgres://app_user:" + alnum(14) + "@db.internal:5432/main"),
  row("postgres_uri", "postgresql://app_user:" + alnum(14) + "@db.internal/main?sslmode=require"),
  row("bearer_token", alnum(32), "Bearer "),
  row("gh_token_env", alnum(30), "GH_" + "TOKEN="),
  row("jwt_token", "ey" + "Jhbgc" + alnum(10) + "." + "ey" + "J" + alnum(20) + "." + alnum(20)),
  row("fxat", "fx" + "at_" + alnum(30)),
  row("whsec", "wh" + "sec_" + alnum(30)),
  row("stripe_key", "sk" + "_live_" + alnum(24)),
  row("stripe_key", "sk" + "_test_" + alnum(24)),
  row("stripe_key", "rk" + "_live_" + alnum(24)),
  row("session_cookie", alnum(40), "__Host-fx" + "_session="),
  row("session_cookie", alnum(40), "__Host-fx" + "_ops_session="),
];

/** Wrappers a secret must be found inside: a string, a nested object, an array element. */
const embeddings: Array<[string, (s: string) => unknown]> = [
  ["a string", (s) => `before ${s} after`],
  ["a nested object", (s) => ({ a: { b: { c: `x ${s}` } } })],
  ["an array element", (s) => ["clean", { list: [`y ${s}`] }]],
];

describe("redactDeep: one row per shape, in a string, a nested object and an array", () => {
  for (const { shape, sample, secret } of ROWS) {
    for (const [where, wrap] of embeddings) {
      it(`${shape} (${sample.slice(0, 14)}...) in ${where}`, () => {
        const out = JSON.stringify(redactDeep(wrap(sample), []));
        expect(out).not.toContain(secret);
        expect(out).toContain("[redacted]");
      });
    }
  }

  it("every engine and cloud shape has at least one row (drop a pattern and its row goes red)", () => {
    const covered = new Set(ROWS.map((r) => r.shape));
    for (const shape of TELEMETRY_SHAPES) expect(covered.has(shape.name), shape.name).toBe(true);
  });
});

describe("keep-the-context shapes", () => {
  it("classic_gh_pat keeps its keyword and does not touch a bare git SHA", () => {
    expect(redactDeep(`token: ${hex40}`, [])).toBe("token: [redacted]");
    expect(redactDeep(`Authorization: token ${hex40}`, [])).toBe("Authorization: [redacted]");
    expect(redactDeep(`commit ${hex40} fixed it`, [])).toBe(`commit ${hex40} fixed it`);
  });

  it("bearer, GH_TOKEN and the session cookies keep the label only", () => {
    expect(redactDeep(`call with Bearer ${alnum(30)} now`, [])).toBe("call with Bearer [redacted] now");
    expect(redactDeep(`call with bearer ${alnum(30)} now`, [])).toBe("call with Bearer [redacted] now");
    expect(redactDeep(`GH_${"TOKEN"}=${alnum(30)} next`, [])).toBe("GH_TOKEN=[redacted] next");
    const cookie = `session __Host-fx${"_session"}=${alnum(40)}; theme=dark`;
    expect(redactDeep(cookie, [])).toBe("session __Host-fx_session=[redacted]; theme=dark");
  });
});

describe("context secrets: the value is redacted by where it sits", () => {
  it("URL query parameters with a credential name, any case, keeping the rest of the URL", () => {
    for (const name of ["access_token", "token", "api_key", "apikey", "key", "secret", "password", "auth", "ACCESS_TOKEN", "ApiKey"]) {
      expect(redactDeep(`https://h.example/p?a=1&${name}=plainvalue123&b=2#f`, [])).toBe(
        "https://h.example/p?a=1&" + name + "=[redacted]&b=2#f",
      );
    }
  });

  it("URL userinfo keeps the user and host", () => {
    expect(redactDeep("clone https://alice:hunter2pass@git.example/repo.git", [])).toBe(
      "clone https://alice:[redacted]@git.example/repo.git",
    );
  });

  it("header values: Authorization, x-api-key, api-key, Cookie and Set-Cookie, plain or JSON-encoded", () => {
    for (const name of ["Authorization", "x-api-key", "api-key", "Cookie", "Set-Cookie"]) {
      expect(redactDeep(`${name}: opaque value 123\nnext line`, [])).toBe(`${name}: [redacted]\nnext line`);
    }
    expect(redactDeep('{"authorization":"Basic dXNlcjpwYXNz","route":"/x"}', [])).toBe('{"authorization":"[redacted]","route":"/x"}');
    expect(redactDeep("Cookie: a=1; b=2; c=3", [])).toBe("Cookie: [redacted]");
  });

  it("ENV-style NAME=value where NAME holds KEY, TOKEN, SECRET, PASSWORD, PASS or CREDENTIAL", () => {
    for (const name of ["API_KEY", "GITHUB_TOKEN", "client_secret", "DB_PASSWORD", "DBPASS", "AWS_CREDENTIAL", "stripe.key"]) {
      expect(redactDeep(`export ${name}=opaquevalue9 && run`, [])).toBe(`export ${name}=[redacted] && run`);
    }
  });

  it("leaves ordinary log text alone", () => {
    const ordinary = [
      "GET /v1/runs?page=2&sort=asc&limit=50 200 12ms",
      "run r-123 finished in 4s for account a-9 (status=ok count=3)",
      "https://example.com/docs/keys-and-tokens#overview",
      "connected to postgres at db.internal:5432 as app_user",
      "the task-force reviewed risk-management notes; commit " + hex40,
      "user=alice host=build-7 path=/srv/app retries=3",
      "TypeError: Cannot read properties of undefined (reading 'length') at parse (/srv/app/dist/x.js:10:5)",
    ];
    for (const text of ordinary) expect(redactDeep(text, [])).toBe(text);
  });

  it("does not redact ordinary prose or a bare prefix", () => {
    const text = "the sk_live_ prefix is documented; GH_TOKEN is read from env.";
    expect(redactDeep(text, [])).toBe(text);
  });

  it("an OpenAI-style legacy key needs a boundary and a long unbroken run", () => {
    expect(redactDeep("see risk-" + alnum(40), [])).toBe("see risk-" + alnum(40));
    expect(redactDeep("sk-" + alnum(20), [])).toBe("sk-" + alnum(20));
  });
});

describe("chunked scan of long strings: nothing is dropped, every match is redacted", () => {
  const MIB = 1024 * 1024;
  const key = "sk" + "_live_" + alnum(24);
  // Starts with a space so a token's character run ends where the token does.
  const pad = (n: number): string => (n === 0 ? "" : (" " + "lorem ipsum ".repeat(Math.ceil(n / 12))).slice(0, n));

  it("a 1 MiB string keeps its full length with tokens at the start, straddling a chunk boundary, and at the end", () => {
    const at = [0, SCAN_CHUNK_CHARS - 10, 2 * SCAN_CHUNK_CHARS - 10, MIB - key.length];
    let text = "";
    let cursor = 0;
    for (const p of at) {
      text += pad(p - cursor) + key;
      cursor = p + key.length;
    }
    text += pad(MIB - cursor);
    expect(text.length).toBe(MIB);
    const out = redactShapes(text);
    expect(out).not.toContain(key);
    expect(out.match(/\[redacted\]/g)).toHaveLength(at.length);
    expect(out.length).toBe(MIB - at.length * (key.length - "[redacted]".length));
  });

  it("a token with an unbounded tail that spans several windows is redacted whole", () => {
    const out = redactShapes("a " + "vck" + "_" + "z".repeat(300_000) + " tail " + "x-api-key: " + "q w ".repeat(100_000) + "\nend");
    expect(out).toBe("a [redacted] tail x-api-key: [redacted]\nend");
  });

  it("gives exactly the result of one unchunked pass over a long mixed string", () => {
    const pieces = [
      `see https://u:${alnum(12)}@h.example/x?token=${alnum(20)}&k=1 `,
      `${"ey" + "J"}${alnum(30)}.${alnum(30)}.${alnum(30)} `,
      `Cookie: a=${alnum(20)}; b=2\n`,
      `plain words and numbers 12345 `,
      `${"vck" + "_"}${alnum(30)} DB_PASSWORD=${alnum(10)} `,
    ];
    let text = "";
    for (let i = 0; text.length < 3 * SCAN_CHUNK_CHARS + 1000; i++) text += pieces[(i * 7) % pieces.length]!;
    let expected = text;
    for (const source of TOKEN_SHAPE_PATTERN_SOURCES) expected = expected.replace(new RegExp(source, "g"), "[redacted]");
    for (const s of TELEMETRY_SHAPES) expected = expected.replace(new RegExp(s.source, s.flags), s.replacement);
    expect(redactShapes(text)).toBe(expected);
  });
});

describe("adversarial placements", () => {
  const key = "sk" + "_live_" + alnum(24);
  const jwt = "ey" + "J" + alnum(18) + "." + alnum(18) + "." + alnum(18);

  it("tokens in URL query strings and fragments", () => {
    const urls = [
      `https://api.example.com/v1?api_key=${key}&x=1`,
      `https://api.example.com/cb?token=${hex40}`,
      `https://api.example.com/cb?access_token=${jwt}#frag`,
      `wss://h.example.com/s?auth=${"vck" + "_" + alnum(30)}`,
    ];
    for (const url of urls) {
      const out = redactDeep(url, []);
      for (const secret of [key, hex40, jwt, "vck" + "_" + alnum(30)]) expect(out).not.toContain(secret);
    }
  });

  it("a token inside a JSON-encoded string, where it is followed by an escaped quote", () => {
    const body = JSON.stringify({ cookie: `__Host-fx${"_session"}=${alnum(40)}`, k: key });
    const out = redactDeep(body, []);
    expect(out).not.toContain(alnum(40));
    expect(out).not.toContain(key);
  });

  it("an error's message, stack and cause, via redactError", () => {
    const secret = ["sk", "ant", "api03"].join("-") + "-" + alnum(30);
    const err = new Error(`call failed with ${secret}`, { cause: new Error(`inner ${key}`) });
    const out = redactError(err, []);
    expect(`${out.message}\n${out.stack}\n${String((out as { cause?: Error }).cause?.message)}`).not.toMatch(
      new RegExp(`${secret}|${key}`),
    );
  });

  it("a repeated secret is redacted at every occurrence", () => {
    const out = redactDeep(`${key} and again ${key}`, []);
    expect(out).toBe("[redacted] and again [redacted]");
  });
});
