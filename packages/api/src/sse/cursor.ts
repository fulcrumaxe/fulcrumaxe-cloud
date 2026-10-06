import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { InvalidCursorError } from "../errors.js";

/**
 * D#31 API-5 criterion 6: the account stream's `id` (and the JSON mode's
 * `next_cursor`) is base64url AES-256-GCM ciphertext over
 * `(account_id, serial, issued_at)` under `FX_CURSOR_KEY_V1`.
 *
 * Why sealed, not encoded: `domain_events.seq` is a global serial, so an
 * id that exposed it would let a subscriber estimate the platform's whole
 * event volume from the gaps between its own ids (0627's header). A
 * cursor is also bound to its account inside the ciphertext, so account
 * B presenting account A's cursor fails BEFORE the stream opens (422
 * `invalid_cursor`) -- and nothing a client can do to the string (flip,
 * truncate, extend, re-encode) survives the GCM tag: every such input is
 * the same 422, with no oracle that says which check failed.
 *
 * Wire layout (before base64url): version(1) | nonce(12) | ciphertext(32) | tag(16).
 * Plaintext: account uuid (16 bytes) | serial (uint64 BE) | position time ms (uint64 BE).
 *
 * The position time (`CursorClaims.issuedAtMs`) is NOT "when this string was
 * minted". It is a time T such that every event AFTER the cursor's serial was
 * created at or after T: the created_at of the positioned event, or "now"
 * when the cursor sits at a head that was just read to the end. A polling
 * client re-mints its cursor on every page, so keying staleness to the mint
 * time would let a lagging client walk forward on fresh cursors while the
 * events between its position and now were being purged; keyed to the
 * position, a cursor whose next events may already be gone (T older than
 * retention) is told to resync instead (CWE-672).
 * The version byte is also the key selector: version N reads
 * `FX_CURSOR_KEY_V{N}`, so a rotation adds V2, mints under it, and keeps
 * opening V1 cursors until retention (7 days) has aged them out.
 */

const CURRENT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PLAINTEXT_BYTES = 16 + 8 + 8;
const SEALED_BYTES = 1 + NONCE_BYTES + PLAINTEXT_BYTES + TAG_BYTES;
/** base64url length of exactly SEALED_BYTES; anything else is rejected before decoding. */
const ENCODED_LENGTH = Math.ceil((SEALED_BYTES * 4) / 3);
const MAX_SERIAL = (1n << 63n) - 1n;

/** `domain_events` retention (packages/webhooks DOMAIN_EVENTS_RETENTION_MS): 7 days. */
export const CURSOR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CursorClaims {
  accountId: string;
  serial: bigint;
  /** Position time (see the header): every event after `serial` was created at or after this instant. */
  issuedAtMs: number;
}

export type CursorEnv = Record<string, string | undefined>;

function keyFor(version: number, env: CursorEnv): Buffer {
  const raw = env[`FX_CURSOR_KEY_V${version}`];
  if (!raw) {
    throw new Error(`FX_CURSOR_KEY_V${version} is not set`);
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`FX_CURSOR_KEY_V${version} must decode (base64) to exactly 32 bytes, got ${key.length}`);
  }
  return key;
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error("cursor: accountId must be a UUID");
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Seals a cursor. Throws (a 500 upstream) if the key is missing: the stream fails closed rather than minting an unsealed id. */
export function sealCursor(claims: CursorClaims, env: CursorEnv = process.env): string {
  if (claims.serial < 0n || claims.serial > MAX_SERIAL) {
    throw new Error("cursor: serial out of range");
  }
  const plaintext = Buffer.alloc(PLAINTEXT_BYTES);
  uuidToBytes(claims.accountId).copy(plaintext, 0);
  plaintext.writeBigUInt64BE(claims.serial, 16);
  plaintext.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(claims.issuedAtMs))), 24);

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(CURRENT_VERSION, env), nonce);
  cipher.setAAD(Buffer.from([CURRENT_VERSION]));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sealed = Buffer.concat([Buffer.from([CURRENT_VERSION]), nonce, ct, cipher.getAuthTag()]);
  return sealed.toString("base64url");
}

/**
 * Opens a cursor for `accountId`. Every failure -- wrong length, bad
 * alphabet, unknown version, failed tag, another account's cursor, a
 * serial outside 0..2^63-1 -- throws the SAME `InvalidCursorError`. A
 * missing key is a server misconfiguration and throws a plain Error (500).
 */
export function openCursor(encoded: string, accountId: string, env: CursorEnv = process.env): CursorClaims {
  if (encoded.length !== ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new InvalidCursorError();
  }
  const sealed = Buffer.from(encoded, "base64url");
  if (sealed.length !== SEALED_BYTES) {
    throw new InvalidCursorError();
  }
  const version = sealed[0]!;
  if (version !== CURRENT_VERSION) {
    throw new InvalidCursorError();
  }
  const key = keyFor(version, env);
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const ct = sealed.subarray(1 + NONCE_BYTES, SEALED_BYTES - TAG_BYTES);
  const tag = sealed.subarray(SEALED_BYTES - TAG_BYTES);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from([version]));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new InvalidCursorError();
  }

  const cursorAccount = bytesToUuid(plaintext.subarray(0, 16));
  const serial = plaintext.readBigUInt64BE(16);
  const issuedAt = plaintext.readBigUInt64BE(24);
  if (cursorAccount !== accountId.toLowerCase()) {
    throw new InvalidCursorError();
  }
  if (serial > MAX_SERIAL || issuedAt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidCursorError();
  }
  return { accountId: cursorAccount, serial, issuedAtMs: Number(issuedAt) };
}

/** True when the cursor is older than `domain_events` retention: events after it may have been purged, so the client must resync. */
export function isCursorStale(claims: CursorClaims, nowMs: number): boolean {
  return nowMs - claims.issuedAtMs > CURSOR_RETENTION_MS;
}

/**
 * The run stream's `id`: the run-scoped `seq` (H11's public
 * `RunEventDTO.seq`) as a decimal string. `Last-Event-ID` for a run stream
 * must be a plain non-negative integer within JS's safe range; anything
 * else is the same 422 a forged account cursor gets.
 */
export function parseRunCursor(raw: string): number {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(raw)) {
    throw new InvalidCursorError();
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidCursorError();
  }
  return n;
}
