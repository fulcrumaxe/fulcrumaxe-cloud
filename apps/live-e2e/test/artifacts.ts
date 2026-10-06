/**
 * Test-only builders: fake secrets and real container formats (zip, gzip, PNG) so the scrub is exercised on
 * the bytes a real run would produce. Fake secrets are assembled at run time from joined pieces: no complete
 * secret-shaped string appears in the source, so a secret scanner has nothing to flag.
 */
import { deflateRawSync, deflateSync, gzipSync, crc32 } from "node:zlib";

/**
 * Deterministic pseudo-random bytes (xorshift32). Tests that scan large base64 text must not use real random
 * bytes: over 16 MB of random base64 a secret shape (the Google key shape, `AIza` plus 35 characters) turns up
 * by chance in roughly one run in three, and the scan is right to report it.
 */
export function noiseBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let x = (seed | 0) || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** A deterministic, distinctive run of letters and digits. */
export function filler(seed: string, length: number): string {
  const alphabet = "AbCdEfGhJkLmNpQrStUvWxYz23456789";
  let out = "";
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  while (out.length < length) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    out += alphabet[h % alphabet.length];
  }
  return out;
}

const b64url = (s: string) => Buffer.from(s).toString("base64url");

export interface Planted {
  /** The static shape (or `runtime-value` / `env-value`) the scrub must report. */
  kind: string;
  /** Text holding the secret in the context it normally appears in. */
  text: string;
  /** The secret itself, to prove it is gone after redaction. */
  secret: string;
}

/** One planted secret per shape the scrub claims to know. */
export function plantedShapes(): Planted[] {
  const f = (seed: string, n = 28) => filler(seed, n);
  const mk = (kind: string, secret: string, wrap: (s: string) => string = (s) => s): Planted => ({ kind, secret, text: wrap(secret) });
  const jwt = [b64url('{"alg":"HS256","typ":"JWT"}'), b64url('{"sub":"user-1","exp":1893456000}'), f("sig", 43)].join(".");
  return [
    mk("stripe-key", ["sk", "_live_", f("a")].join(""), (s) => `charge failed for ${s} today`),
    mk("stripe-key", ["rk", "_live_", f("b")].join(""), (s) => `key=${s}`),
    mk("stripe-key", ["sk", "_test_", f("c")].join(""), (s) => `"stripe":"${s}"`),
    mk("stripe-key", ["rk", "_test_", f("d")].join(""), (s) => `using ${s}.`),
    mk("stripe-webhook-secret", ["whsec", "_", f("e", 32)].join(""), (s) => `signing secret ${s}`),
    mk("anthropic-key", ["sk", "-ant-", "api03-", f("f", 40)].join(""), (s) => `model key ${s}`),
    mk("openai-key", ["sk", "-proj-", f("oa", 48)].join(""), (s) => `key ${s}`),
    mk("slack-token", ["xo", "xb-", f("sl", 12)].join(""), (s) => `slack ${s}`),
    mk("slack-token", ["xo", "xp-", "AbCdEfGh"].join(""), (s) => `bearer ${s}`),
    mk("slack-token", ["xa", "pp-1-", f("sa", 12)].join(""), (s) => `slack ${s}`),
    mk("slack-token", ["xo", "xe-1-", f("se", 12)].join(""), (s) => `slack ${s}`),
    mk("gitlab-token", ["gl", "ptt-", f("gt", 24)].join(""), (s) => `gitlab ${s}`),
    mk("gitlab-token", ["gl", "dt-", f("gd", 24)].join(""), (s) => `gitlab ${s}`),
    mk("gitlab-token", ["gl", "rt-", f("gr", 24)].join(""), (s) => `gitlab ${s}`),
    mk("aws-key-id", ["AK", "IA", f("aw", 16).toUpperCase()].join(""), (s) => `aws ${s} here`),
    mk("google-api-key", ["AI", "za", f("go", 35)].join(""), (s) => `key=${s}`),
    mk("gitlab-token", ["gl", "pat-", f("gl", 24)].join(""), (s) => `gitlab ${s}`),
    mk("npm-token", ["npm", "_", f("np", 36)].join(""), (s) => `//registry:_authToken=${s}`),
    mk("github-token", ["ghp", "_", f("g", 36)].join("")),
    mk("github-token", ["gho", "_", f("h", 36)].join("")),
    mk("github-token", ["ghs", "_", f("i", 36)].join("")),
    mk("github-token", ["github", "_pat_", f("j", 50)].join(""), (s) => `GH ${s}`),
    mk("vercel-token", ["vc", "a", "_", f("k", 40)].join(""), (s) => `vercel token ${s}`),
    mk("vercel-token", ["vc", "p", "_", "ab_", f("kk", 30), "-x"].join(""), (s) => `vercel token ${s}`),
    mk("env-assignment", f("l", 24), (s) => `VERCEL_${"TOKEN"}=${s}`),
    mk("jwt", jwt, (s) => `session ${s} end`),
    mk("authorization-header", f("m", 30), (s) => `Authorization: Basic ${s}`),
    mk("bearer-token", `${f("n", 12)}9${f("o", 20)}`, (s) => `sent bearer ${s} upstream`),
    mk("bearer-token", f("nd", 32).replace(/[0-9]/g, "k"), (s) => `sent bearer ${s} upstream`),
    mk("cookie-header", f("p", 30), (s) => `Cookie: theme=dark; other=${s}`),
    mk("cookie-header", f("q", 30), (s) => `Set-Cookie: sid=${s}; Path=/; HttpOnly`),
    mk("session-cookie", f("r", 40), (s) => `jar ${"__Host-fx_session"}=${s} ok`),
    mk("vercel-bypass-cookie", f("s", 40), (s) => `jar ${"_vercel"}_jwt=${s}`),
    mk("bypass-secret", f("t", 32), (s) => `x-vercel-protection-bypass: ${s}`),
    mk("bypass-secret", f("u", 32), (s) => `https://x.test/?x-vercel-protection-bypass=${s}&x=1`),
    mk("url-credentials", f("v", 20), (s) => `git clone https://bot:${s}@host.test/r.git`),
    mk("url-credentials", f("v2", 24), (s) => `connect postgres://neondb_owner:${s}@ep-x.neon.tech/db`),
    mk("url-credentials", f("v3", 24), (s) => `redis://:${s}@cache.test:6379`),
    mk("url-credentials", f("v4", 24), (s) => `https://:${s}@host.test/`),
    mk("private-key", f("w", 60), (s) => `${"-----BEGIN "}${"PRIVATE KEY"}-----\n${s}\n-----END PRIVATE KEY-----`),
  ];
}

// ---------------------------------------------------------------------------------------------------------
// Containers

export interface ZipFile {
  name: string;
  data: Buffer | string;
  /** Default 8 (deflate). 0 stores. Any other value is written as-is, with deflated bytes, to test refusal. */
  method?: number;
  encrypted?: boolean;
  /** Write sizes after the data in a data descriptor (flag bit 3), as streaming zip writers do. */
  descriptor?: boolean;
  /** Bytes placed after this entry's data that no header refers to (a hole in the archive). */
  gapAfter?: Buffer;
  /** Add an extended-timestamp extra field (id 0x5455) to the local and central headers. */
  timestamp?: boolean;
}

/** A real zip (local headers, central directory, end record), the layout Playwright and `zip` produce. */
export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const method = f.method ?? 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const name = Buffer.from(f.name);
    const flags = (f.encrypted === true ? 1 : 0) | (f.descriptor === true ? 8 : 0);
    const crc = crc32(raw);
    // UT extra field: id 0x5455, 5 bytes (flags + one 32-bit time)
    const extra = f.timestamp === true ? Buffer.from([0x55, 0x54, 5, 0, 1, 0x80, 0x51, 0x01, 0x00]) : Buffer.alloc(0);
    const descriptor = Buffer.alloc(f.descriptor === true ? 16 : 0);
    if (f.descriptor === true) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(raw.length, 12);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const entry = Buffer.concat([local, name, extra, data, descriptor]);
    const hole = f.gapAfter ?? Buffer.alloc(0);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name, extra]));
    locals.push(entry, hole);
    offset += entry.length + hole.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

export function gzip(data: Buffer | string): Buffer {
  return gzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data));
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export type PngTextKind = "tEXt" | "zTXt" | "iTXt" | "iTXt-compressed";

/** A valid 1x1 PNG carrying one text chunk of the given kind. */
export function makePng(keyword: string, text: string | Buffer, kind: PngTextKind): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0, 255, 0, 0]));
  const k = Buffer.from(keyword, "latin1");
  let meta: Buffer;
  if (kind === "tEXt") meta = pngChunk("tEXt", Buffer.concat([k, Buffer.from([0]), (Buffer.isBuffer(text) ? text : Buffer.from(text, "latin1"))]));
  else if (kind === "zTXt") meta = pngChunk("zTXt", Buffer.concat([k, Buffer.from([0, 0]), deflateSync(Buffer.isBuffer(text) ? text : Buffer.from(text))]));
  else {
    const compressed = kind === "iTXt-compressed";
    meta = pngChunk(
      "iTXt",
      Buffer.concat([k, Buffer.from([0, compressed ? 1 : 0, 0]), Buffer.from("en\0"), Buffer.from("\0"), compressed ? deflateSync(Buffer.isBuffer(text) ? text : Buffer.from(text)) : Buffer.from(text)]),
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    meta,
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
