/**
 * Strict handling of Ed25519 public keys. Node's verifier is OpenSSL's, and OpenSSL accepts a public key of small
 * order (one of the eight torsion points): for such a key the forgery "R = the key's own bytes, S = 0" verifies for
 * about one message in four, which an attacker can search for by varying the nonce. A runner row must never hold such
 * a key, and a request must never be checked against one, so `isUsableEd25519Key` refuses every key that is not a
 * canonical, on-curve point of full order (it multiplies the point by 8 and refuses if the result is the identity).
 *
 * Plain BigInt arithmetic over the curve's field: nothing to install and nothing to trust but the curve equation.
 */

const P = (1n << 255n) - 19n;

const mod = (a: bigint): bigint => ((a % P) + P) % P;
function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}
const inv = (a: bigint): bigint => pow(a, P - 2n);

const D = mod(-121665n * inv(121666n));
const SQRT_MINUS_ONE = pow(2n, (P - 1n) / 4n);

type Point = readonly [bigint, bigint];

/** Decodes a compressed point (RFC 8032 section 5.1.3). Null for a non-canonical `y`, an off-curve point or a bad sign bit. */
function decode(bytes: Uint8Array): Point | null {
  if (bytes.length !== 32) return null;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return null;
  const y2 = (y * y) % P;
  const x2 = mod((y2 - 1n) * inv(D * y2 + 1n));
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_MINUS_ONE);
  if (mod(x * x - x2) !== 0n) return null;
  if (x === 0n && sign === 1n) return null;
  if ((x & 1n) !== sign) x = P - x;
  return [x, y];
}

/** The twisted Edwards addition law for a = -1 (complete: the denominators never vanish for points on the curve). */
function add([x1, y1]: Point, [x2, y2]: Point): Point {
  const k = (D * x1 * x2 * y1 * y2) % P;
  return [mod((x1 * y2 + x2 * y1) * inv(1n + k)), mod((y1 * y2 + x1 * x2) * inv(1n - k))];
}

/** True when `point` times 8 is the identity, which holds exactly for the eight points of small order. */
function hasSmallOrder(point: Point): boolean {
  let p = point;
  for (let i = 0; i < 3; i++) p = add(p, p);
  return p[0] === 0n && p[1] === 1n;
}

/** True only for the base64url `x` of a canonical Ed25519 public key whose point is on the curve and not of small order. */
export function isUsableEd25519Key(x: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) return false;
  const bytes = Buffer.from(x, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== x) return false;
  const point = decode(bytes);
  return point !== null && !hasSmallOrder(point);
}
