import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEngineVersion } from "../../src/engineBridge/engineVersion.js";

const uid = process.getuid?.();
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fx-eb3c-ver-"));
});
afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe("the engine manifest version", () => {
  it("reads a dotted version from engine/manifest.json below the repo root", () => {
    mkdirSync(path.join(root, "engine"));
    writeFileSync(path.join(root, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3" }), { mode: 0o644 });
    expect(readEngineVersion(root, uid)).toEqual({ ok: true, version: "1.2.3" });
  });

  it("answers a closed word, and never throws, when the repo root is a file (ENOTDIR)", () => {
    const file = path.join(root, "a-file");
    writeFileSync(file, "x");
    expect(readEngineVersion(file, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
  });

  it("answers a closed word when the repo root cannot be searched (EACCES), and when it does not exist", () => {
    const locked = path.join(root, "locked");
    mkdirSync(path.join(locked, "engine"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      // Root bypasses directory permissions; as anyone else the lstat fails.
      const answer = readEngineVersion(locked, uid);
      expect(answer.ok).toBe(false);
      if (!answer.ok && process.getuid?.() !== 0) expect(answer.why).toBe("unsafe_manifest");
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(readEngineVersion(path.join(root, "missing"), uid)).toEqual({ ok: false, why: "no_manifest" });
  });
});
