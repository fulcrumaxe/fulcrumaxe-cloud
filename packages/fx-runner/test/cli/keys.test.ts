import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { sign, verify } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ed25519PublicJwk, jwkThumbprint } from "@fulcrumaxe/runner-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_FILE, ensureStateDir, stateDirFor } from "../../src/config.js";
import { generateRunnerKey, loadRunnerKey, saveRunnerKey } from "../../src/keys.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-keys-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mode = (p: string): number => statSync(p).mode & 0o777;

describe("runner key", () => {
  it("is Ed25519; the public JWK is exactly kty, crv and x, and its thumbprint is the keyid", () => {
    const key = generateRunnerKey();
    expect(Object.keys(key.publicJwk).sort()).toEqual(["crv", "kty", "x"]);
    expect(Ed25519PublicJwk.safeParse(key.publicJwk).success).toBe(true);
    expect(key.jkt).toBe(jwkThumbprint(key.publicJwk));
    expect(JSON.stringify(key.publicJwk)).not.toContain('"d"');
  });

  it("is stored at mode 0600 in a 0700 directory, and tightens a directory that was wider", () => {
    const dir = path.join(root, "state");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    saveRunnerKey(dir, generateRunnerKey());
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, KEY_FILE))).toBe(0o600);
  });

  it("round-trips: the loaded key signs what the saved public key verifies", () => {
    const dir = path.join(root, "state");
    const key = generateRunnerKey();
    saveRunnerKey(dir, key);
    const loaded = loadRunnerKey(dir)!;
    expect(loaded.jkt).toBe(key.jkt);
    const signature = sign(null, Buffer.from("m"), loaded.privateKey);
    expect(verify(null, Buffer.from("m"), key.privateKey, signature)).toBe(true);
  });

  it("is absent, not an error, before registration", () => {
    expect(loadRunnerKey(path.join(root, "nothing"))).toBeUndefined();
  });

  it("is refused when other users can read the file, when it is a link, or when it is not a key", () => {
    const dir = path.join(root, "state");
    saveRunnerKey(dir, generateRunnerKey());
    const file = path.join(dir, KEY_FILE);
    chmodSync(file, 0o640);
    expect(() => loadRunnerKey(dir)).toThrow(/chmod 600/);
    chmodSync(file, 0o600);
    writeFileSync(file, "not a key", { mode: 0o600 });
    expect(() => loadRunnerKey(dir)).toThrow(/cannot be read/);
    rmSync(file);
    writeFileSync(path.join(root, "elsewhere"), "x", { mode: 0o600 });
    symlinkSync(path.join(root, "elsewhere"), file);
    expect(() => loadRunnerKey(dir)).toThrow(/not a plain file/);
  });

  it("the state directory is refused when it is a link or a file", () => {
    writeFileSync(path.join(root, "f"), "x");
    expect(() => ensureStateDir(path.join(root, "f"))).toThrow();
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "link"));
    expect(() => ensureStateDir(path.join(root, "link"))).toThrow(/plain directory/);
  });

  it("the default state directory is ~/.fx-runner, and a missing home is an error", () => {
    expect(stateDirFor("/home/someone", undefined)).toBe("/home/someone/.fx-runner");
    expect(stateDirFor("/home/someone", "/srv/runner")).toBe("/srv/runner");
    expect(() => stateDirFor(undefined, undefined)).toThrow(/home directory/);
    expect(() => stateDirFor("relative", undefined)).toThrow(/home directory/);
  });
});
