import { randomBytes } from "node:crypto";

/**
 * Criterion 1: `^fxat_[0-9A-Za-z]{43}[0-9A-Za-z]{6}$`. `fxat_` + 32
 * random bytes base62-encoded to a fixed 43 chars (62^43 > 2^256, every
 * value fits once zero-padded), + a CRC32 checksum over the prefix+secret,
 * base62-encoded to a fixed 6 chars (62^6 > 2^32). The checksum lets
 * verifyChecksum reject a typo without a DB lookup (criterion 7) -- a
 * format guard only, never a substitute for the real hash comparison.
 */
export const TOKEN_PREFIX = "fxat_";
const SECRET_WIDTH = 43;
const CHECKSUM_WIDTH = 6;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const TOKEN_FORMAT_RE = /^fxat_[0-9A-Za-z]{43}[0-9A-Za-z]{6}$/;

/** Encodes `buf` as base62, left-padded to exactly `width` chars. Callers always pass a width large enough (see file header). */
function encodeBase62(buf: Buffer, width: number): string {
  let n = BigInt(`0x${buf.toString("hex") || "0"}`);
  if (n === 0n) {
    return BASE62_ALPHABET[0]!.repeat(width);
  }
  let out = "";
  while (n > 0n) {
    const remainder = Number(n % 62n);
    out = BASE62_ALPHABET[remainder] + out;
    n /= 62n;
  }
  return out.padStart(width, BASE62_ALPHABET[0]);
}

// Standard CRC32 (IEEE 802.3 / zlib polynomial 0xEDB88320). Hand-rolled
// rather than Node's zlib.crc32 (Node 22.2+) since this package's stated
// engine (Node 18) predates it.
const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(input: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc = CRC32_TABLE[(crc ^ input.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checksumFor(withoutChecksum: string): string {
  const crc = crc32(withoutChecksum);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc, 0);
  return encodeBase62(crcBytes, CHECKSUM_WIDTH);
}

/** Mints a brand-new plaintext token. Never persisted itself -- only `hashToken(generateToken())` (tokens/resolve.ts) is stored. */
export function generateToken(): string {
  const secretPart = encodeBase62(randomBytes(32), SECRET_WIDTH);
  const withoutChecksum = TOKEN_PREFIX + secretPart;
  return withoutChecksum + checksumFor(withoutChecksum);
}

/** Format + checksum validity, no DB access (criterion 7). Also checks TOKEN_FORMAT_RE, so a caller never needs to check that separately. */
export function verifyChecksum(candidate: string): boolean {
  if (!TOKEN_FORMAT_RE.test(candidate)) {
    return false;
  }
  const withoutChecksum = candidate.slice(0, TOKEN_PREFIX.length + SECRET_WIDTH);
  const checksumPart = candidate.slice(TOKEN_PREFIX.length + SECRET_WIDTH);
  return checksumFor(withoutChecksum) === checksumPart;
}

/** display_hint (criterion 2): fxat_... + last 4 chars. Computed once at mint time and stored -- the plaintext is never available again. */
export function displayHint(plaintextToken: string): string {
  return `${TOKEN_PREFIX}...${plaintextToken.slice(-4)}`;
}
