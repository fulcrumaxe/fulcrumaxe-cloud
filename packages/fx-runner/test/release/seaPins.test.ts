import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NODE_PINS, NODE_VERSION, assertSingleFile, distBase, hostPlatform, injectionSteps, parseShasums, verifyNodeArchive } from "../../scripts/build-sea.mjs";
import { ARTIFACT_NAMES, artifactName } from "../../scripts/release-manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A copy of nodejs.org/dist/v22.22.3/SHASUMS256.txt as nodejs.org serves it (R6-1 "real contracts").
const SHASUMS = readFileSync(path.join(HERE, "..", "fixtures", `node-v${NODE_VERSION}-SHASUMS256.txt`), "utf8");

const hash = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Runs `fn` and checks it threw a BuildError with this code. */
function fails(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { code?: string } | undefined)?.code).toBe(code);
}

describe("the pinned Node release", () => {
  it("is a 22.22.x release", () => {
    expect(NODE_VERSION).toMatch(/^22\.22\.\d+$/);
  });

  it("pins every platform the release ships, to the hash nodejs.org lists", () => {
    const sums = parseShasums(SHASUMS);
    expect(Object.keys(NODE_PINS).sort()).toEqual(Object.keys(ARTIFACT_NAMES).sort());
    for (const [platform, pin] of Object.entries(NODE_PINS)) {
      expect(pin.archive, platform).toBe(`node-v${NODE_VERSION}-${platform}.tar.gz`);
      expect(sums.get(pin.archive), platform).toBe(pin.sha256);
    }
  });
});

describe("SHASUMS256.txt parsing", () => {
  it("reads the real file: every line a hash and a name", () => {
    expect(parseShasums(SHASUMS).size).toBe(SHASUMS.trim().split("\n").length);
  });

  it("refuses a line in any other shape, and a name listed twice", () => {
    fails(() => parseShasums("abc  node.tar.gz\n"), "shasums_malformed");
    fails(() => parseShasums(`${"a".repeat(64)} node.tar.gz\n`), "shasums_malformed");
    fails(() => parseShasums(`${"A".repeat(64)}  node.tar.gz\n`), "shasums_malformed");
    fails(() => parseShasums(`${"a".repeat(64)}  x.tar.gz\n${"b".repeat(64)}  x.tar.gz\n`), "shasums_malformed");
  });
});

describe("verifyNodeArchive", () => {
  const bytes = Buffer.from("not really node");

  it("accepts bytes that match both the listing and the pin", () => {
    verifyNodeArchive({ bytes, archive: "a.tar.gz", shasums: new Map([["a.tar.gz", hash(bytes)]]), pinned: hash(bytes) });
  });

  it("refuses bytes whose hash is not the listed one", () => {
    fails(() => verifyNodeArchive({ bytes, archive: "a.tar.gz", shasums: new Map([["a.tar.gz", "0".repeat(64)]]), pinned: hash(bytes) }), "shasums_mismatch");
  });

  it("refuses bytes the listing agrees with when the pin does not (a tampered mirror that also rewrote SHASUMS256.txt)", () => {
    fails(() => verifyNodeArchive({ bytes, archive: "a.tar.gz", shasums: new Map([["a.tar.gz", hash(bytes)]]), pinned: "0".repeat(64) }), "pin_mismatch");
  });

  it("refuses an archive the listing does not name", () => {
    fails(() => verifyNodeArchive({ bytes, archive: "a.tar.gz", shasums: new Map(), pinned: hash(bytes) }), "shasums_missing_entry");
  });
});

describe("the injection plan", () => {
  it("is one injection on Linux", () => {
    expect(injectionSteps("linux-x64")).toEqual([{ kind: "inject" }]);
    expect(injectionSteps("linux-arm64")).toEqual([{ kind: "inject" }]);
  });

  it("on macOS removes the signature, injects into the NODE_SEA segment, signs ad hoc and verifies, in that order", () => {
    for (const platform of ["darwin-arm64", "darwin-x64"]) {
      expect(injectionSteps(platform)).toEqual([
        { kind: "codesign", args: ["--remove-signature"] },
        { kind: "inject", machoSegmentName: "NODE_SEA" },
        { kind: "codesign", args: ["--sign", "-"] },
        { kind: "codesign", args: ["--verify"] },
      ]);
    }
  });
});

describe("the download base", () => {
  it("is nodejs.org unless an https URL is given, and never plain http", () => {
    expect(distBase({})).toBe(`https://nodejs.org/dist/v${NODE_VERSION}`);
    expect(distBase({ FX_SEA_NODE_DIST_URL: "https://mirror.example/dist/" })).toBe("https://mirror.example/dist");
    fails(() => distBase({ FX_SEA_NODE_DIST_URL: "http://127.0.0.1:1/dist" }), "dist_url_refused");
  });
});

describe("what a single executable cannot hold", () => {
  it("accepts plain code and refuses a dynamic import, a native addon and a worker", () => {
    assertSingleFile('const x = require("node:fs");\n// import("x") in a comment\n');
    fails(() => assertSingleFile('const m = await import("./x.js");'), "dynamic_import");
    fails(() => assertSingleFile('const a = require("./addon.node");'), "native_or_worker");
    fails(() => assertSingleFile('new Worker("./w.js")'), "native_or_worker");
  });
});

describe("artifact names", () => {
  it("are one constant, one name per platform, and an unknown platform is an error", () => {
    expect(Object.values(ARTIFACT_NAMES)).toEqual(["fx-runner-darwin-arm64", "fx-runner-darwin-x64", "fx-runner-linux-x64", "fx-runner-linux-arm64"]);
    expect(artifactName("linux-x64")).toBe("fx-runner-linux-x64");
    expect(() => artifactName("win32-x64")).toThrow(/unknown platform/);
    expect(hostPlatform("linux", "x64")).toBe("linux-x64");
  });
});
