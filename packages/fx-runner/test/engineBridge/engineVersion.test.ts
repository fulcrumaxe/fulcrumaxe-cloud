import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  describe("an installed project, which records the version in .autonomous-team/engine-install.json", () => {
    const install = () => path.join(root, ".autonomous-team", "engine-install.json");
    const put = (text: string, mode = 0o644) => {
      mkdirSync(path.join(root, ".autonomous-team"), { recursive: true });
      writeFileSync(install(), text, { mode });
      chmodSync(install(), mode);
    };
    const good = JSON.stringify({ engine_version: "0.3.0", engine_commit: "abc", source: "x" });

    it("reads engine_version when there is no engine directory", () => {
      put(good);
      expect(readEngineVersion(root, uid)).toEqual({ ok: true, version: "0.3.0" });
    });

    it("reads it when engine/ exists but holds no manifest", () => {
      mkdirSync(path.join(root, "engine"));
      put(good);
      expect(readEngineVersion(root, uid)).toEqual({ ok: true, version: "0.3.0" });
    });

    it("prefers a good engine/manifest.json over the install record", () => {
      mkdirSync(path.join(root, "engine"));
      writeFileSync(path.join(root, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3" }), { mode: 0o644 });
      put(good);
      expect(readEngineVersion(root, uid)).toEqual({ ok: true, version: "1.2.3" });
    });

    it("answers no_manifest when neither file is there", () => {
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "no_manifest" });
      mkdirSync(path.join(root, ".autonomous-team"));
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "no_manifest" });
    });

    it("refuses the install record when it is a symlink", () => {
      mkdirSync(path.join(root, ".autonomous-team"));
      writeFileSync(path.join(root, "real.json"), good, { mode: 0o644 });
      symlinkSync(path.join(root, "real.json"), install());
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
    });

    it("refuses an install record owned by another user", () => {
      put(good);
      expect(readEngineVersion(root, (uid ?? 0) + 1)).toEqual({ ok: false, why: "unsafe_manifest" });
    });

    it("refuses a group-writable install record, and a world-writable one", () => {
      put(good, 0o664);
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
      put(good, 0o646);
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
    });

    it("refuses an install record over 64 KiB, and takes one just under it", () => {
      put(JSON.stringify({ engine_version: "0.3.0", pad: "x".repeat(64 * 1024) }));
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
      put(JSON.stringify({ engine_version: "0.3.0", pad: "x".repeat(60 * 1024) }));
      expect(readEngineVersion(root, uid)).toEqual({ ok: true, version: "0.3.0" });
    });

    it("answers bad_version for text that is not JSON, a missing version and a version that fails the pattern", () => {
      put("not json at all");
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "bad_version" });
      put(JSON.stringify({ engine_commit: "abc" }));
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "bad_version" });
      put(JSON.stringify({ engine_version: "latest; rm -rf" }));
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "bad_version" });
      put("null");
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "bad_version" });
    });

    it("refuses when .autonomous-team is a symlink", () => {
      mkdirSync(path.join(root, "elsewhere"));
      writeFileSync(path.join(root, "elsewhere", "engine-install.json"), good, { mode: 0o644 });
      symlinkSync(path.join(root, "elsewhere"), path.join(root, ".autonomous-team"));
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
    });

    it("refuses when .autonomous-team is a file, or owned by another user", () => {
      writeFileSync(path.join(root, ".autonomous-team"), "x");
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
      rmSync(path.join(root, ".autonomous-team"));
      put(good);
      expect(readEngineVersion(root, (uid ?? 0) + 1)).toEqual({ ok: false, why: "unsafe_manifest" });
    });

    it("does not fall back past an unsafe engine/ or a bad or unsafe manifest, even with a good install record", () => {
      put(good);
      // engine is a symlink
      mkdirSync(path.join(root, "real-engine"));
      symlinkSync(path.join(root, "real-engine"), path.join(root, "engine"));
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
      rmSync(path.join(root, "engine"));
      // engine is a file
      writeFileSync(path.join(root, "engine"), "x");
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
      rmSync(path.join(root, "engine"));
      // bad manifest version
      mkdirSync(path.join(root, "engine"));
      writeFileSync(path.join(root, "engine", "manifest.json"), JSON.stringify({ engine_version: "nope" }), { mode: 0o644 });
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "bad_version" });
      // group-writable manifest
      chmodSync(path.join(root, "engine", "manifest.json"), 0o664);
      expect(readEngineVersion(root, uid)).toEqual({ ok: false, why: "unsafe_manifest" });
    });

    it("never puts anything from the install record in the answer", () => {
      put(JSON.stringify({ engine_version: "SECRET-TOKEN-123" }));
      expect(JSON.stringify(readEngineVersion(root, uid))).not.toContain("SECRET");
    });
  });
});
