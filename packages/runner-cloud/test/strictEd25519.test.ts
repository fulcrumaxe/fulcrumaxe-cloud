import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isUsableEd25519Key } from "../src/index.js";

const b64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64url");
const P_MINUS_1 = "ecff" + "ff".repeat(29) + "7f";

describe("isUsableEd25519Key", () => {
  it("accepts real keys", () => {
    for (let i = 0; i < 25; i++) {
      const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string };
      expect(isUsableEd25519Key(jwk.x)).toBe(true);
    }
  });

  it("refuses an all-zero x, the identity, every point of order 2, 4 and 8, and the sign-flipped forms", () => {
    const small = [
      "00".repeat(32), // y = 0: order 4
      "00".repeat(31) + "80", // y = 0, sign bit set: order 4
      "01" + "00".repeat(31), // identity, order 1
      "01" + "00".repeat(30) + "80", // identity, sign bit set (not even a point)
      P_MINUS_1, // y = -1: order 2
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", // order 8
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85", // order 8, other sign
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", // order 8
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa", // order 8, other sign
    ];
    for (const hex of small) expect(isUsableEd25519Key(b64(hex)), hex).toBe(false);
  });

  it("refuses non-canonical encodings, off-curve points and malformed text", () => {
    expect(isUsableEd25519Key(b64("edff" + "ff".repeat(29) + "7f"))).toBe(false); // y = p
    expect(isUsableEd25519Key(b64("eeff" + "ff".repeat(29) + "7f"))).toBe(false); // y = p + 1
    expect(isUsableEd25519Key(b64("02" + "00".repeat(31)))).toBe(false); // y = 2 is not on the curve
    for (const x of ["", "short", "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}!`]) expect(isUsableEd25519Key(x), x).toBe(false);
  });

  it("matters: whatever forgeries the platform's OpenSSL accepts under a small-order key, the gate refuses every such key", () => {
    // R = the key's own bytes, S = 0. Whether OpenSSL accepts these depends on the build (some reject them), so the
    // count is recorded rather than asserted; the gate assertion below runs either way.
    const keys = ["00".repeat(32), "01" + "00".repeat(31), P_MINUS_1, "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"];
    let accepted = 0;
    for (const hex of keys) {
      const bytes = Buffer.from(hex, "hex");
      const forged = Buffer.concat([bytes, Buffer.alloc(32)]);
      let key;
      try {
        key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" });
      } catch {
        continue; // this OpenSSL refuses to load the key at all
      }
      for (let i = 0; i < 64; i++) if (verify(null, Buffer.from(`message ${i}`), key, forged)) accepted++;
      expect(isUsableEd25519Key(bytes.toString("base64url")), hex).toBe(false);
    }
    console.info(`platform OpenSSL accepted ${accepted} small-order forgeries of ${keys.length * 64}`);
    for (const hex of keys) expect(isUsableEd25519Key(b64(hex)), hex).toBe(false);
  });
});
