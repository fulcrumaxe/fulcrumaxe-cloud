import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { sidecarLibrary } from "../../bin/sidecarLibrary.mjs";
import { bundleRunner } from "../../scripts/build-sea.mjs";
import { compare } from "../../scripts/release-check.mjs";
import { manifestFor } from "../../scripts/release-manifest.mjs";
import { checksumsText, loadManifest } from "../../scripts/release-render.mjs";
import { SIDECAR_ARCHIVE, SIDECAR_DIR, assertNoBrowsers, buildSidecar, installBeside, installedLibrary, listTree, packSidecar, pinnedVersion, swapSidecar, treeDigest, unpackSidecar, verifySidecar } from "../../scripts/sidecar.mjs";
import { probePlaywright } from "../../src/daemon/playwrightProbe.js";
import { loadSettings, setSetting } from "../../src/runnerSettings.js";
import { APP_SESSION_COOKIE } from "../../src/verifyBrowser/stateScope.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2c-2c: the Playwright sidecar is built into the release, packed into the one signed archive, unpacked and verified like the binary, swapped in atomically, and the loader and the probe
 * trust only the folder the binary was built with. These tests use the REAL pinned library from node_modules (no fake of it), a real child Node for the loader, and fakes only where a failure has to
 * be injected.
 */
const root = mkdtempSync(path.join(tmpRoot(), "sidecar-build-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (label: string): string => path.join(root, `${label}-${(counter += 1)}`);
const EPOCH = 1780000000;
const real = (): { dest: string; built: ReturnType<typeof buildSidecar> } => {
  const dest = path.join(fresh("real"), SIDECAR_DIR);
  return { dest, built: buildSidecar({ dest, epoch: EPOCH }) };
};

/** A tiny stand-in library tree, for the failures that need a hand-made one. */
function fakeLibrary(label: string, version: string, extra: Record<string, string | Buffer> = {}): { dir: string; version: string } {
  const dir = path.join(fresh(label), "playwright-core");
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "playwright-core", version, main: "index.js" }));
  writeFileSync(path.join(dir, "index.js"), "module.exports = { marker: 'fake' };\n");
  for (const [name, content] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return { dir, version };
}

describe("the sidecar folder the build lays down", () => {
  it("is exactly the pinned playwright-core, under node_modules/playwright-core, with its licence files and no types", () => {
    const { dest, built } = real();
    const pin = pinnedVersion();
    expect(pin).toBe("1.63.0");
    expect(built.version).toBe(pin);
    expect(JSON.parse(readFileSync(path.join(dest, "node_modules", "playwright-core", "package.json"), "utf8")).version).toBe(pin);
    expect(readdirSync(dest)).toEqual(["node_modules"]);
    expect(readdirSync(path.join(dest, "node_modules"))).toEqual(["playwright-core"]);
    const names = listTree(dest).map((entry) => entry.path);
    expect(names.every((name) => name.startsWith("node_modules/playwright-core/"))).toBe(true);
    for (const needed of ["LICENSE", "NOTICE", "ThirdPartyNotices.txt", "index.js", "lib/coreBundle.js", "lib/utilsBundle.js"]) expect(names).toContain(`node_modules/playwright-core/${needed}`);
    expect(names.some((name) => /\/types\/|index\.d\.ts$/.test(name))).toBe(false);
  });

  it("holds no browser: no browser-named entry, no download folder, no file past the size of library code", () => {
    const { dest } = real();
    const tree = listTree(dest);
    expect(tree.some((entry) => /\.local-browsers|ms-playwright|chrome-linux|chromium-\d|headless_shell/i.test(entry.path))).toBe(false);
    expect(Math.max(...tree.map((entry) => entry.size))).toBeLessThan(8 * 1024 * 1024);
    expect(tree.reduce((sum, entry) => sum + entry.size, 0)).toBeLessThan(40 * 1024 * 1024);
  });

  it("is the same bytes every time (the digest and the packed archive do not change between two builds)", () => {
    const [a, b] = [real(), real()];
    expect(a.built.digest).toBe(b.built.digest);
    expect(packSidecar(a.dest).equals(packSidecar(b.dest))).toBe(true);
  });

  it("refuses a library at another version than the pin, or one holding a browser or an oversized file, and leaves no folder", () => {
    const wrongVersion = path.join(fresh("v"), SIDECAR_DIR);
    expect(() => buildSidecar({ dest: wrongVersion, source: fakeLibrary("old", "1.62.0") })).toThrow(/version_mismatch/);
    expect(existsSync(wrongVersion)).toBe(false);
    const withBrowser = path.join(fresh("b"), SIDECAR_DIR);
    expect(() => buildSidecar({ dest: withBrowser, source: fakeLibrary("chrome", pinnedVersion(), { ".local-browsers/chromium-1234/chrome-linux/chrome": "x" }) })).toThrow(/browser_inside/);
    expect(existsSync(withBrowser)).toBe(false);
    const huge = path.join(fresh("h"), SIDECAR_DIR);
    expect(() => buildSidecar({ dest: huge, source: fakeLibrary("huge", pinnedVersion(), { "lib/chrome.bin": Buffer.alloc(9 * 1024 * 1024) }) })).toThrow(/file_too_large|browser_inside/);
    expect(existsSync(huge)).toBe(false);
    expect(() => assertNoBrowsers([{ path: "node_modules/playwright-core/x/chromium-1200/y", size: 1, sha256: "" }])).toThrow(/browser_inside/);
  });

  it("refuses to build over a folder that is already there", () => {
    const { dest } = real();
    expect(() => buildSidecar({ dest })).toThrow(/dest_exists/);
  });

  it("the installed library is the pinned one", () => {
    expect(installedLibrary().version).toBe(pinnedVersion());
  });
});

describe("the packed archive", () => {
  it("unpacks to a tree with the same digest, file for file", () => {
    const { dest, built } = real();
    const archive = packSidecar(dest);
    const out = path.join(fresh("unpacked"), SIDECAR_DIR);
    expect(unpackSidecar(archive, out)).toEqual({ digest: built.digest, version: pinnedVersion() });
    expect(treeDigest(listTree(out))).toBe(built.digest);
    expect(verifySidecar(out, built.digest)).toBe(true);
  });

  it("a changed byte in any file is refused and nothing is left behind (the header still names the old digest)", () => {
    const { dest } = real();
    const archive = packSidecar(dest);
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 100] = tampered[tampered.length - 100]! ^ 0xff;
    const out = path.join(fresh("tamper"), SIDECAR_DIR);
    expect(() => unpackSidecar(tampered, out)).toThrow(/file_mismatch/);
    expect(existsSync(out)).toBe(false);
  });

  it("a header whose tree digest disagrees with its (individually correct) files is refused and nothing is left behind", () => {
    const lib = path.join(fresh("digest"), SIDECAR_DIR);
    buildSidecar({ dest: lib, source: { ...fakeLibrary("digest", pinnedVersion()) } });
    const archive = packSidecar(lib);
    const end = archive.indexOf(0x0a, 6);
    const header = JSON.parse(archive.subarray(6, end).toString("utf8")) as { digest: string };
    const forged = Buffer.concat([Buffer.from("FXSC1\n"), Buffer.from(`${JSON.stringify({ ...header, digest: "0".repeat(64) })}\n`), archive.subarray(end + 1)]);
    const out = path.join(fresh("digest-out"), SIDECAR_DIR);
    expect(() => unpackSidecar(forged, out)).toThrow(/digest_mismatch/);
    expect(existsSync(out)).toBe(false);
  });

  it("a header that names a path outside node_modules/playwright-core, a path with .., a duplicate, or trailing bytes is refused", () => {
    const lib = path.join(fresh("small"), SIDECAR_DIR);
    buildSidecar({ dest: lib, source: { ...fakeLibrary("small", pinnedVersion()) } });
    const archive = packSidecar(lib);
    const end = archive.indexOf(0x0a, 6);
    const header = JSON.parse(archive.subarray(6, end).toString("utf8")) as { files: Array<{ path: string; size: number; sha256: string }> };
    const body = archive.subarray(end + 1);
    const remake = (change: (files: Array<{ path: string; size: number; sha256: string }>) => void, trailing = 0): Buffer => {
      const next = { ...header, files: header.files.map((file) => ({ ...file })) };
      change(next.files);
      return Buffer.concat([Buffer.from("FXSC1\n"), Buffer.from(`${JSON.stringify(next)}\n`), body, Buffer.alloc(trailing)]);
    };
    const refuses = (bytes: Buffer): void => {
      const out = path.join(fresh("refused"), SIDECAR_DIR);
      expect(() => unpackSidecar(bytes, out)).toThrow(/bad_archive/);
      expect(existsSync(out)).toBe(false);
    };
    refuses(remake((files) => void (files[0]!.path = "evil/outside.js")));
    refuses(remake((files) => void (files[0]!.path = "node_modules/playwright-core/../../escape.js")));
    refuses(remake((files) => void files.push({ ...files[0]! })));
    refuses(remake(() => undefined, 3));
    refuses(Buffer.from("not an archive"));
    refuses(archive.subarray(0, archive.length - 1));
    expect(existsSync(path.join(root, "escape.js"))).toBe(false);
  });

  it("a tree with a link in it cannot be packed, and a folder that was extended or edited no longer verifies", () => {
    const { dest, built } = real();
    expect(verifySidecar(dest, built.digest)).toBe(true);
    const lib = path.join(dest, "node_modules", "playwright-core");
    writeFileSync(path.join(lib, "extra.js"), "x");
    expect(verifySidecar(dest, built.digest)).toBe(false);
    rmSync(path.join(lib, "extra.js"));
    expect(verifySidecar(dest, built.digest)).toBe(true);
    chmodSync(path.join(lib, "index.js"), 0o644);
    writeFileSync(path.join(lib, "index.js"), `${readFileSync(path.join(lib, "index.js"), "utf8")}\n//x`);
    expect(verifySidecar(dest, built.digest)).toBe(false);
    symlinkSync("/etc/passwd", path.join(lib, "link.js"));
    expect(() => packSidecar(dest)).toThrow(/not_plain/);
    rmSync(path.join(lib, "link.js"));
    // anything beside node_modules/playwright-core is not a sidecar, even without a digest to compare to
    writeFileSync(path.join(dest, "stray.txt"), "x");
    expect(() => packSidecar(dest)).toThrow(/outside_library/);
    expect(verifySidecar(dest)).toBe(false);
  });
});

describe("the atomic swap", () => {
  const folder = (label: string, marker: string): string => {
    const dir = fresh(label);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "marker"), marker);
    return dir;
  };

  it("puts the new folder in place of the old one and leaves nothing beside it", () => {
    const parent = fresh("swap");
    mkdirSync(parent);
    const final = path.join(parent, SIDECAR_DIR);
    mkdirSync(final);
    writeFileSync(path.join(final, "marker"), "old");
    swapSidecar(folder("new", "new"), final);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("new");
    expect(readdirSync(parent)).toEqual([SIDECAR_DIR]);
  });

  it("puts the old folder back when the second step fails, and nothing is half-written", () => {
    const parent = fresh("rollback");
    mkdirSync(parent);
    const final = path.join(parent, SIDECAR_DIR);
    mkdirSync(final);
    writeFileSync(path.join(final, "marker"), "old");
    const next = folder("next", "new");
    let calls = 0;
    const failing = (from: string, to: string): void => {
      calls += 1;
      if (calls === 2) throw new Error("disk went away");
      // the first call is the old folder moving aside; do it for real
      mkdirSync(path.dirname(to), { recursive: true });
      execFileSync("mv", [from, to]);
    };
    expect(() => swapSidecar(next, final, failing)).toThrow(/disk went away/);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("old");
    expect(readdirSync(parent)).toEqual([SIDECAR_DIR]);
    expect(existsSync(next)).toBe(true);
  });

  it("when the rollback rename fails too, both errors are reported, the place is said to be empty, and the old folder is kept aside", () => {
    const parent = fresh("rollback2");
    mkdirSync(parent);
    const final = path.join(parent, SIDECAR_DIR);
    mkdirSync(final);
    writeFileSync(path.join(final, "marker"), "old");
    let calls = 0;
    const failing = (from: string, to: string): void => {
      calls += 1;
      if (calls === 2) throw new Error("disk went away");
      if (calls === 3) throw new Error("and the undo failed");
      execFileSync("mv", [from, to]);
    };
    let thrown: Error | undefined;
    try {
      swapSidecar(folder("next2", "new"), final, failing);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toMatch(/rollback_failed/);
    expect(thrown?.message).toMatch(/disk went away/);
    expect(thrown?.message).toMatch(/and the undo failed/);
    expect(thrown?.message).toMatch(/ABSENT/);
    expect((thrown?.cause as Error).message).toBe("disk went away");
    expect(existsSync(final)).toBe(false);
    const aside = readdirSync(parent).filter((name) => name.startsWith(`${SIDECAR_DIR}.old-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(path.join(parent, aside[0]!, "marker"), "utf8")).toBe("old");
  });

  it("the next swap clears an old-<hex> folder that a swap which died left beside the folder", () => {
    const parent = fresh("stale");
    mkdirSync(path.join(parent, `${SIDECAR_DIR}.old-abcdef012345`), { recursive: true });
    writeFileSync(path.join(parent, `${SIDECAR_DIR}.old-abcdef012345`, "marker"), "stale");
    mkdirSync(path.join(parent, "unrelated.old-aaaaaa"));
    swapSidecar(folder("n3", "three"), path.join(parent, SIDECAR_DIR));
    expect(readdirSync(parent).sort()).toEqual([SIDECAR_DIR, "unrelated.old-aaaaaa"]);
  });

  it("works when there is no old folder yet, and fails cleanly if that one rename fails", () => {
    const parent = fresh("first");
    mkdirSync(parent);
    const final = path.join(parent, SIDECAR_DIR);
    swapSidecar(folder("n1", "one"), final);
    expect(readFileSync(path.join(final, "marker"), "utf8")).toBe("one");
    const empty = fresh("first2");
    mkdirSync(empty);
    expect(() =>
      swapSidecar(folder("n2", "two"), path.join(empty, SIDECAR_DIR), () => {
        throw new Error("no");
      }),
    ).toThrow(/no/);
    expect(readdirSync(empty)).toEqual([]);
  });

  it("installBeside (the local install) lays the folder next to a binary, replaces an old one, and refuses a library that is not the one the binary was built with", () => {
    const dir = fresh("install");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "fx-runner"), "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(path.join(dir, SIDECAR_DIR, "node_modules", "stale"), { recursive: true });
    const built = installBeside({ binaryDir: dir });
    expect(readdirSync(dir).sort()).toEqual(["fx-runner", SIDECAR_DIR]);
    expect(verifySidecar(path.join(dir, SIDECAR_DIR), built.digest)).toBe(true);
    expect(existsSync(path.join(dir, SIDECAR_DIR, "node_modules", "stale"))).toBe(false);
    expect(() => installBeside({ binaryDir: dir, expectedDigest: "0".repeat(64) })).toThrow(/digest_mismatch/);
    expect(verifySidecar(path.join(dir, SIDECAR_DIR), built.digest)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["fx-runner", SIDECAR_DIR]);
  });

  it("the command line lays it down and verifies it, with the exit codes a script can use", () => {
    const dir = fresh("cli");
    mkdirSync(dir);
    const run = (...args: string[]): number => {
      try {
        execFileSync(process.execPath, [path.join(PACKAGE_DIR, "scripts", "sidecar-cli.mjs"), ...args], { stdio: "pipe" });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    expect(run("verify", "--binary-dir", dir)).toBe(1);
    expect(run("install", "--binary-dir", dir)).toBe(0);
    expect(run("verify", "--binary-dir", dir)).toBe(0);
    expect(run("verify", "--binary-dir", dir, "--digest", "1".repeat(64))).toBe(1);
    // An install told which digest the binary carries fails loudly on another library and lays nothing down; with the right one it succeeds.
    const other = fresh("cli-digest");
    mkdirSync(other);
    expect(run("install", "--binary-dir", other, "--digest", "1".repeat(64))).toBe(1);
    expect(existsSync(path.join(other, SIDECAR_DIR))).toBe(false);
    expect(run("install", "--binary-dir", other, "--digest", "xyz")).toBe(2);
    const wanted = treeDigest(listTree(path.join(dir, SIDECAR_DIR)));
    expect(run("install", "--binary-dir", other, "--digest", wanted)).toBe(0);
    expect(run("verify", "--binary-dir", other, "--digest", wanted)).toBe(0);
    expect(run("nonsense")).toBe(2);
  });
});

describe("the loader trusts only the folder the binary was built with", () => {
  const probeFile = path.join(root, "load.mjs");
  writeFileSync(
    probeFile,
    `import { sidecarLibrary } from ${JSON.stringify(pathToFileURL(path.join(PACKAGE_DIR, "bin", "sidecarLibrary.mjs")).href)};
const options = process.argv[3] === undefined ? {} : { digest: process.argv[3] === "none" ? undefined : process.argv[3] };
const lib = sidecarLibrary(process.argv[2], "playwright-core", options);
let loaded;
try { loaded = typeof (await lib.load()).chromium; } catch (e) { loaded = "ERR:" + e.message; }
console.log(JSON.stringify({ available: lib.available(), loaded }));
`,
  );
  const ask = (dir: string, digest?: string): { available: boolean; loaded: string } => JSON.parse(execFileSync(process.execPath, [probeFile, dir, ...(digest === undefined ? [] : [digest])], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" })) as { available: boolean; loaded: string };

  it("the real library in the real folder loads (the browser types are really there) when the digest is the baked one", () => {
    const { dest, built } = real();
    expect(ask(dest, built.digest)).toEqual({ available: true, loaded: "object" });
  });

  it("a folder with an edited file, an added file, or another digest is not available, and loading says playwright_missing", () => {
    const { dest, built } = real();
    expect(ask(dest, "f".repeat(64))).toEqual({ available: false, loaded: "ERR:playwright_missing" });
    expect(ask(dest, "")).toEqual({ available: false, loaded: "ERR:playwright_missing" });
    expect(ask(dest, "none")).toEqual({ available: false, loaded: "ERR:playwright_missing" });
    writeFileSync(path.join(dest, "node_modules", "playwright-core", "added.js"), "x");
    expect(ask(dest, built.digest)).toEqual({ available: false, loaded: "ERR:playwright_missing" });
    rmSync(path.join(dest, "node_modules", "playwright-core", "added.js"));
    expect(ask(dest, built.digest).available).toBe(true);
    writeFileSync(path.join(dest, "node_modules", "playwright-core", "lib", "coreBundle.js"), "module.exports = { chromium: 'evil' };\n");
    expect(ask(dest, built.digest)).toEqual({ available: false, loaded: "ERR:playwright_missing" });
  });

  it("a second library tree next to playwright-core, or a link in the folder, is refused", () => {
    const { dest, built } = real();
    mkdirSync(path.join(dest, "node_modules", "other"));
    writeFileSync(path.join(dest, "node_modules", "other", "index.js"), "x");
    expect(ask(dest, built.digest).available).toBe(false);
    rmSync(path.join(dest, "node_modules", "other"), { recursive: true });
    symlinkSync(path.join(dest, "node_modules", "playwright-core"), path.join(dest, "node_modules", "alias"));
    expect(ask(dest, built.digest).available).toBe(false);
  });

  it("an absent folder is not available (and not an error)", () => {
    expect(ask(path.join(fresh("absent"), SIDECAR_DIR), "a".repeat(64))).toEqual({ available: false, loaded: "ERR:playwright_missing" });
  });

  it("without a digest option (running from source) the folder is only fenced, as before", () => {
    const { dest } = real();
    expect(sidecarLibrary(dest).available()).toBe(true);
  });
});

describe("the probe follows the sidecar", () => {
  function machine() {
    const home = fresh("probe");
    mkdirSync(home);
    const stateDir = path.join(home, ".fx-runner");
    mkdirSync(stateDir, { mode: 0o700 });
    const exe = path.join(home, "chromium");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    const dir = path.join(home, ".config", "fx-runner", "verify");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, "storage-state.json"), JSON.stringify({ cookies: [{ name: APP_SESSION_COOKIE, value: "s", domain: "app.example.test", path: "/", expires: -1 }], origins: [] }), { mode: 0o600 });
    setSetting(stateDir, "verify.test_account", "fx-test-user");
    setSetting(stateDir, "verify.browser.base_url", "https://app.example.test");
    setSetting(stateDir, "verify.browser.executable", exe);
    return (available: () => boolean) => probePlaywright({ settings: () => loadSettings(stateDir).verify, home, uid: process.getuid?.() ?? 0, now: Date.now, playwrightAvailable: available });
  }

  it("passes with the sidecar next to the binary, and reports playwright_missing without it, with an edited one, and with one built for another binary", () => {
    const probe = machine();
    const { dest, built } = real();
    const lib = sidecarLibrary(dest, "playwright-core", { digest: built.digest });
    expect(probe(() => lib.available())).toEqual({ ok: true });
    const other = sidecarLibrary(dest, "playwright-core", { digest: "c".repeat(64) });
    expect(probe(() => other.available())).toEqual({ ok: false, reason: "playwright_missing" });
    const absent = sidecarLibrary(path.join(fresh("none"), SIDECAR_DIR), "playwright-core", { digest: built.digest });
    expect(probe(() => absent.available())).toEqual({ ok: false, reason: "playwright_missing" });
    writeFileSync(path.join(dest, "node_modules", "playwright-core", "index.js"), "module.exports = {};\n");
    expect(probe(() => lib.available())).toEqual({ ok: false, reason: "playwright_missing" });
  });
});

describe("the release files", () => {
  it("the bundle carries the digest of the sidecar and none of the library", async () => {
    const digest = "d".repeat(64);
    const text = await bundleRunner(EPOCH, digest);
    expect(text).toContain(digest);
    expect(await bundleRunner(EPOCH)).not.toContain(digest);
  }, 60_000);

  it("the manifest lists the archive as one more entry, the render keeps the four-platform rules and adds it to the checksums", () => {
    const dir = fresh("manifest");
    mkdirSync(dir);
    for (const name of ["fx-runner-linux-x64", "fx-runner-linux-arm64", "fx-runner-darwin-arm64", "fx-runner-darwin-x64"]) writeFileSync(path.join(dir, name), name);
    const without = manifestFor(dir, "1.2.3");
    expect(without).toHaveLength(4);
    writeFileSync(path.join(dir, SIDECAR_ARCHIVE), packSidecar(real().dest));
    const entries = manifestFor(dir, "1.2.3");
    expect(entries).toHaveLength(5);
    expect(entries[4]).toMatchObject({ version: "1.2.3", artifact: "playwright-sidecar" });
    const file = path.join(dir, "m.json");
    writeFileSync(file, JSON.stringify(entries));
    const loaded = loadManifest(file);
    expect(loaded.entries).toHaveLength(4);
    expect(loaded.sidecar?.sha256).toBe(entries[4]!.sha256);
    expect(checksumsText(loaded)).toContain(`${entries[4]!.sha256}  ${SIDECAR_ARCHIVE}\n`);
    writeFileSync(file, JSON.stringify([...entries, entries[4]]));
    expect(() => loadManifest(file)).toThrow(/twice/);
    writeFileSync(file, JSON.stringify(without));
    expect(loadManifest(file).sidecar).toBeUndefined();
  });

  it("two builds are compared on the sidecar too: a differing archive or folder fails the reproducibility check", () => {
    const [a, b] = [fresh("ca"), fresh("cb")];
    for (const dir of [a, b]) {
      mkdirSync(dir);
      writeFileSync(path.join(dir, "fx-runner-linux-x64"), "same");
    }
    buildSidecar({ dest: path.join(a, SIDECAR_DIR), source: fakeLibrary("fa", pinnedVersion()) });
    buildSidecar({ dest: path.join(b, SIDECAR_DIR), source: fakeLibrary("fb", pinnedVersion(), { "lib/more.js": "x" }) });
    expect(() => compare(a, b)).toThrow(/fx-runner-playwright is not reproducible/);
    rmSync(path.join(b, SIDECAR_DIR), { recursive: true });
    buildSidecar({ dest: path.join(b, SIDECAR_DIR), source: fakeLibrary("fc", pinnedVersion()) });
    expect(() => compare(a, b)).not.toThrow();
    writeFileSync(path.join(a, SIDECAR_ARCHIVE), packSidecar(path.join(a, SIDECAR_DIR)));
    expect(() => compare(a, b)).toThrow(/disagree/);
    writeFileSync(path.join(b, SIDECAR_ARCHIVE), "different");
    expect(() => compare(a, b)).toThrow(/not reproducible/);
  });
});
