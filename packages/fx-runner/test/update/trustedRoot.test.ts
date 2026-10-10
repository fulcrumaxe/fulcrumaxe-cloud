import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Metadata, MetadataKind } from "@tufjs/models";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { TUF_BUILD } from "../../src/update/buildConfig.js";
import { TRUSTED_ROOT_SHA256, TRUSTED_ROOT_TEXT, assertPinnedRoot } from "../../src/update/trustedRoot.js";

/** The runner's compiled-in trusted root (D#6 R6-W). Only public material is involved; no test here reads or makes a private key. */

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = path.join(PKG, "..", "..");
const tufFile = (name: string): Buffer => readFileSync(path.join(PKG, "tuf", name));
const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

interface RootJson {
  signed: {
    version: number;
    expires: string;
    keys: Record<string, { keytype: string; scheme: string; keyval: { public: string } }>;
    roles: Record<string, { keyids: string[]; threshold: number }>;
  };
}
const parsed = JSON.parse(TRUSTED_ROOT_TEXT) as RootJson;

/** The key id TUF gives an Ed25519 key: SHA-256 of the canonical JSON of its description. */
const keyIdOf = (publicHex: string): string =>
  sha256(`{"keytype":"ed25519","keyval":{"public":"${publicHex}"},"scheme":"ed25519"}`);

const hexOfJwk = (name: string): string => {
  const jwk = JSON.parse(tufFile(name).toString("utf8")) as { kty: string; crv: string; x: string };
  expect(jwk.kty).toBe("OKP");
  expect(jwk.crv).toBe("Ed25519");
  const der = createPublicKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "spki" });
  return der.subarray(-32).toString("hex");
};

describe("the compiled trusted root", () => {
  it("parses as a first root with a future expiry", () => {
    expect(parsed.signed.version).toBe(1);
    expect(Date.parse(parsed.signed.expires)).toBeGreaterThan(Date.now());
    expect(Object.keys(parsed.signed.roles).sort()).toEqual(["root", "snapshot", "targets", "timestamp"]);
  });

  it("verifies its own signature through the reference model", () => {
    const root = Metadata.fromJSON(MetadataKind.Root, JSON.parse(TRUSTED_ROOT_TEXT));
    expect(() => root.verifyDelegate("root", root)).not.toThrow();
  });

  it("names each key by the id TUF derives from the key itself", () => {
    for (const [id, key] of Object.entries(parsed.signed.keys)) expect(id).toBe(keyIdOf(key.keyval.public));
  });

  it("holds exactly the three public keys in tuf/*.pub.json, each in the right role", () => {
    const want = { root: hexOfJwk("root.pub.json"), targets: hexOfJwk("targets.pub.json"), online: hexOfJwk("online.pub.json") };
    const { roles, keys } = parsed.signed;
    expect(Object.keys(keys).sort()).toEqual([keyIdOf(want.root), keyIdOf(want.targets), keyIdOf(want.online)].sort());
    expect(roles.root).toEqual({ keyids: [keyIdOf(want.root)], threshold: 1 });
    expect(roles.targets).toEqual({ keyids: [keyIdOf(want.targets)], threshold: 1 });
    expect(roles.snapshot).toEqual({ keyids: [keyIdOf(want.online)], threshold: 1 });
    expect(roles.timestamp).toEqual({ keyids: [keyIdOf(want.online)], threshold: 1 });
  });

  it("matches its pinned hash, and the pin is a plain SHA-256", () => {
    expect(TRUSTED_ROOT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(TRUSTED_ROOT_TEXT)).toBe(TRUSTED_ROOT_SHA256);
  });

  it("is byte for byte tuf/1.root.json, which has no trailing newline", () => {
    const file = tufFile("1.root.json");
    expect(file.toString("utf8")).toBe(TRUSTED_ROOT_TEXT);
    expect(sha256(file)).toBe(TRUSTED_ROOT_SHA256);
    expect(file[file.length - 1]).not.toBe(0x0a);
  });

  it("is what the build trusts", () => {
    expect(TUF_BUILD.root).toBe(TRUSTED_ROOT_TEXT);
  });

  it("refuses any text that is not the pinned one", () => {
    expect(assertPinnedRoot(TRUSTED_ROOT_TEXT)).toBe(TRUSTED_ROOT_TEXT);
    expect(() => assertPinnedRoot(`${TRUSTED_ROOT_TEXT}\n`)).toThrow(/pinned hash/);
    expect(() => assertPinnedRoot(TRUSTED_ROOT_TEXT.replace('"version":1', '"version":2'))).toThrow(/pinned hash/);
    expect(() => assertPinnedRoot(TRUSTED_ROOT_TEXT, "0".repeat(64))).toThrow(/pinned hash/);
  });
});

describe("the release workflows and the trusted root", () => {
  const files = ["runner-release.yml", "tuf-timestamp.yml"];
  const workflowText = (name: string): string => readFileSync(path.join(REPO, ".github", "workflows", name), "utf8");

  it("set TRUSTED_ROOT to the committed file, from the checked-out main", () => {
    for (const name of files) {
      const wf = load(workflowText(name)) as { env?: Record<string, string> };
      expect(wf.env?.TRUSTED_ROOT).toBe("packages/fx-runner/tuf/1.root.json");
    }
  });

  it("pass the root only as $TRUSTED_ROOT, never a path under a downloaded directory", () => {
    const downloaded = /(?:^|[\s"'=/])(?:meta|files|artifacts)\/[^\s"']*root[^\s"']*\.json/;
    for (const name of files) {
      const text = workflowText(name);
      expect(text).not.toMatch(downloaded);
      const uses = text.split("\n").filter((line) => /--trusted-root|signing-configured|prepare-metadata/.test(line));
      expect(uses.length).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line).toMatch(/"\$TRUSTED_ROOT"/);
        for (const match of line.matchAll(/--trusted-root\s+([^\s;]+)/g)) expect(match[1]).toBe('"$TRUSTED_ROOT"');
      }
    }
  });
});
