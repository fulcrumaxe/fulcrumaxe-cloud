import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpSignatureError, MAX_CREATED_SKEW_SECONDS, contentDigest, jwkThumbprint, signRequest, verifyRequestSignature, verifyRunnerRequest, type Ed25519Jwk, type HttpSignatureErrorCode } from "../src/httpSignature.js";

// RFC 9421 appendix B.1.4 test key (public half) and the appendix B.2.6 request.
const RFC_PUBLIC_KEY = createPublicKey({ key: Buffer.from("MCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=", "base64"), format: "der", type: "spki" });
const RFC_B26 = {
  method: "POST",
  url: "https://example.com/foo?param=Value&Pet=dog",
  headers: {
    host: "example.com",
    date: "Tue, 20 Apr 2021 02:07:55 GMT",
    "content-type": "application/json",
    "content-digest": "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
    "content-length": "18",
    "signature-input":
      'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
    signature: "sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:",
  } as Record<string, string | undefined>,
  body: '{"hello": "world"}',
};
const RFC_NOW = new Date(1618884473 * 1000);

async function codeOf(promise: Promise<unknown>): Promise<HttpSignatureErrorCode | "resolved"> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    if (!(error instanceof HttpSignatureError)) throw error;
    return error.code;
  }
}

describe("RFC 9421 appendix B.2.6", () => {
  const options = { resolveKey: (keyid: string) => (keyid === "test-key-ed25519" ? RFC_PUBLIC_KEY : undefined), now: RFC_NOW };

  it("accepts the RFC's own signed request", async () => {
    const result = await verifyRequestSignature(RFC_B26, options);
    expect(result).toMatchObject({ keyid: "test-key-ed25519", created: 1618884473, components: ["date", "@method", "@path", "@authority", "content-type", "content-length"] });
  });

  it("rejects it when a covered header changes", async () => {
    const tampered = { ...RFC_B26, headers: { ...RFC_B26.headers, "content-length": "19" } };
    expect(await codeOf(verifyRequestSignature(tampered, options))).toBe("bad_signature");
  });

  it("rejects it when the method changes", async () => {
    expect(await codeOf(verifyRequestSignature({ ...RFC_B26, method: "PUT" }, options))).toBe("bad_signature");
  });
});

describe("jwkThumbprint", () => {
  it("matches the RFC 8037 appendix A.3 Ed25519 example", () => {
    const jwk: Ed25519Jwk = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };
    expect(jwkThumbprint(jwk)).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });
});

describe("contentDigest", () => {
  it("is RFC 9530's sha-256 form", () => {
    const expected = createHash("sha256").update('{"hello": "world"}').digest("base64");
    expect(contentDigest('{"hello": "world"}')).toBe(`sha-256=:${expected}:`);
    expect(contentDigest(undefined)).toBe(contentDigest(""));
  });
});

describe("runner request signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as unknown as Ed25519Jwk;
  const keyid = jwkThumbprint(jwk);
  const NOW = new Date("2026-10-04T12:00:00Z");
  const created = Math.floor(NOW.getTime() / 1000);
  const URL_ = "https://app.example.test/api/runner/claim";
  const NONCE = "bm9uY2Utbm9uY2Utbm9uY2U";
  const resolveKey = (id: string): KeyObject | undefined => (id === keyid ? publicKey : undefined);

  function signed(overrides: { method?: string; url?: string; body?: string; created?: number; nonce?: string; key?: KeyObject } = {}) {
    const method = overrides.method ?? "POST";
    const url = overrides.url ?? URL_;
    const body = overrides.body ?? '{"x":1}';
    const headers = signRequest({
      method,
      url,
      body,
      privateKey: overrides.key ?? privateKey,
      keyid,
      nonce: overrides.nonce ?? NONCE,
      created: overrides.created ?? created,
    });
    return { method, url, body, headers: { ...headers } as Record<string, string | undefined> };
  }

  it("round-trips: the verifier returns the keyid, nonce and covered set", async () => {
    const request = signed();
    const result = await verifyRunnerRequest(request, resolveKey, NOW);
    expect(result).toMatchObject({ keyid, nonce: NONCE, created, components: ["@method", "@target-uri", "content-digest"] });
    expect(request.headers["signature-input"]).toContain('alg="ed25519"');
  });

  it("rejects a tampered body", async () => {
    const request = { ...signed(), body: '{"x":2}' };
    expect(await codeOf(verifyRunnerRequest(request, resolveKey, NOW))).toBe("digest_mismatch");
  });

  it("rejects a changed method", async () => {
    const request = { ...signed(), method: "PUT" };
    expect(await codeOf(verifyRunnerRequest(request, resolveKey, NOW))).toBe("bad_signature");
  });

  it("rejects a changed URI", async () => {
    const request = { ...signed(), url: "https://app.example.test/api/runner/revoke" };
    expect(await codeOf(verifyRunnerRequest(request, resolveKey, NOW))).toBe("bad_signature");
  });

  it("accepts a created time 60 s off and rejects 61 s off, in both directions", async () => {
    expect(MAX_CREATED_SKEW_SECONDS).toBe(60);
    for (const offset of [60, -60]) {
      await verifyRunnerRequest(signed({ created: created + offset }), resolveKey, NOW);
    }
    for (const offset of [61, -61]) {
      expect(await codeOf(verifyRunnerRequest(signed({ created: created + offset }), resolveKey, NOW))).toBe("stale");
    }
  });

  it("rejects a POST that does not carry content-digest", async () => {
    const request = signed();
    delete request.headers["content-digest"];
    expect(await codeOf(verifyRunnerRequest(request, resolveKey, NOW))).toBe("missing_digest");
  });

  it("rejects a signature that does not cover content-digest, even if the header is there", async () => {
    // A signature over only the method and URI, made with the right key.
    const request = signed();
    const params = `("@method" "@target-uri");created=${created};keyid="${keyid}";nonce="${NONCE}";alg="ed25519"`;
    const base = `"@method": POST\n"@target-uri": ${URL_}\n"@signature-params": ${params}`;
    request.headers["signature-input"] = `fx=${params}`;
    request.headers["signature"] = `fx=:${sign(null, Buffer.from(base), privateKey).toString("base64")}:`;
    expect(await codeOf(verifyRunnerRequest(request, resolveKey, NOW))).toBe("missing_digest");
  });

  it("rejects an unsigned request, an unknown key and a key whose id is not its thumbprint", async () => {
    const unsigned = signed();
    delete unsigned.headers["signature"];
    expect(await codeOf(verifyRunnerRequest(unsigned, resolveKey, NOW))).toBe("missing_signature");
    expect(await codeOf(verifyRunnerRequest(signed(), () => undefined, NOW))).toBe("unknown_key");
    const other = generateKeyPairSync("ed25519");
    expect(await codeOf(verifyRunnerRequest(signed(), () => other.publicKey, NOW))).toBe("unknown_key");
  });

  it("rejects a signature made by another key", async () => {
    const other = generateKeyPairSync("ed25519");
    expect(await codeOf(verifyRunnerRequest(signed({ key: other.privateKey }), resolveKey, NOW))).toBe("bad_signature");
  });

  it("requires a nonce and refuses an algorithm other than ed25519", async () => {
    const noNonce = signed();
    noNonce.headers["signature-input"] = noNonce.headers["signature-input"]!.replace(/;nonce="[^"]*"/, "");
    expect(await codeOf(verifyRunnerRequest(noNonce, resolveKey, NOW))).toBe("malformed");
    const otherAlg = signed();
    otherAlg.headers["signature-input"] = otherAlg.headers["signature-input"]!.replace('alg="ed25519"', 'alg="rsa-v1_5-sha256"');
    expect(await codeOf(verifyRunnerRequest(otherAlg, resolveKey, NOW))).toBe("unsupported");
  });

  it("only ever throws HttpSignatureError, whatever the headers hold", async () => {
    for (const junk of ["", "(", "fx=", 'fx=("a" "b"', "fx=:::", "fx=(\"\")", "\u0000"]) {
      const request = signed();
      request.headers["signature-input"] = junk;
      expect(["malformed", "missing_signature"]).toContain(await codeOf(verifyRunnerRequest(request, resolveKey, NOW)));
    }
  });
});
