import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_FLAGS } from "../../../src/engines/claude/argv.js";
import { MIN_CLAUDE_VERSION, compareVersions, parseVersion, resolveClaudePath, storedBinarySource, versionSupported } from "../../../src/engines/claude/pin.js";
import { cleanEnv } from "../../../src/job/cleanEnv.js";
import { PACKAGE_DIR } from "../../helpers/srcFiles.js";
import { DEFAULT_VERSION, FULL_HELP, countingSpawn, helpWithout, makeFake, type Fake } from "./harness.js";

afterEach(() => vi.unstubAllEnvs());

const tempDir = (): string => mkdtempSync(path.join(tmpdir(), "r4b12_pin-"));

function source(fake: Fake, over: { storedPath?: string; cacheDir?: string } = {}) {
  const counted = countingSpawn();
  const load = storedBinarySource({ storedPath: over.storedPath ?? fake.binary, cacheDir: over.cacheDir ?? tempDir(), spawn: counted.spawn });
  return { load: () => load(cleanEnv({ mode: "subscription" })), spawns: counted.spawns };
}

describe("versions", () => {
  it("parses the first word of --version output, and nothing else", () => {
    expect(parseVersion("2.1.289 (Claude Code)\n")).toBe("2.1.289");
    for (const bad of ["", "claude 2.1.289", "v2.1.289", "2.1", "2.1.289.4", "2.1.x", "\u0000 2.1.289"]) expect(parseVersion(bad), bad).toBeUndefined();
  });

  it("compares numerically, field by field", () => {
    expect(compareVersions("2.1.10", "2.1.9")).toBeGreaterThan(0);
    expect(compareVersions("2.2.0", "2.1.999")).toBeGreaterThan(0);
    expect(compareVersions("2.1.259", "2.1.259")).toBe(0);
    expect(compareVersions("2.1.258", "2.1.259")).toBeLessThan(0);
  });

  it("the minimum is 2.1.294, the canary-verified build: 2.1.293 is below it, 2.1.294 and 2.1.295 are not", () => {
    expect(MIN_CLAUDE_VERSION).toBe("2.1.294");
    expect([versionSupported("2.1.293"), versionSupported("2.1.294"), versionSupported("2.1.295")]).toEqual([false, true, true]);
  });
});

describe("minimum version, before each job", () => {
  it.each([["2.1.293", false], ["2.1.294", true], ["2.1.295", true]] as const)("--version %s: accepted is %s", async (version, accepted) => {
    const fake = makeFake({ version: `${version} (Claude Code)` });
    const { load } = source(fake);
    if (accepted) await expect(load()).resolves.toEqual({ path: fake.binary, version });
    else await expect(load()).rejects.toMatchObject({ code: "claude_version_unsupported", message: expect.stringContaining("upgrade") });
  });

  it("unparseable --version output is refused, and no help is read", async () => {
    const fake = makeFake({ version: "not a version" });
    await expect(source(fake).load()).rejects.toMatchObject({ code: "claude_version_unsupported" });
    expect(fake.calls()).toEqual(["--version "]);
  });
});

describe("resolve once, at setup", () => {
  it("returns the absolute real path of the first runnable claude on the given search path, links resolved", () => {
    const real = makeFake().binary;
    const dir = tempDir();
    symlinkSync(real, path.join(dir, "claude"));
    expect(resolveClaudePath(["relative/dir", dir].join(path.delimiter))).toBe(real);
  });

  it("refuses with claude_binary_missing when nothing runnable is found, or the file is not executable", () => {
    const empty = tempDir();
    expect(() => resolveClaudePath(empty)).toThrow(expect.objectContaining({ code: "claude_binary_missing" }));
    const plain = tempDir();
    writeFileSync(path.join(plain, "claude"), "#!/bin/sh\n", { mode: 0o644 });
    expect(() => resolveClaudePath(plain)).toThrow(expect.objectContaining({ code: "claude_binary_missing" }));
  });

  it("at job time PATH is never consulted: a decoy placed first on PATH is never run, the stored path is", async () => {
    const decoy = makeFake();
    const dir = path.join(decoy.dir, "path");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "claude"), `#!/bin/sh\necho decoy >> '${decoy.dir}/decoy-ran.txt'\n`);
    chmodSync(path.join(dir, "claude"), 0o755);
    vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
    const fake = makeFake();
    const { load, spawns } = source(fake);
    await load();
    expect(new Set(spawns)).toEqual(new Set([fake.binary]));
    expect(existsSync(path.join(decoy.dir, "decoy-ran.txt"))).toBe(false);
  });

  it("a relative stored path is not looked up on PATH: it is refused, with no spawn", async () => {
    const { load, spawns } = source(makeFake(), { storedPath: "claude" });
    await expect(load()).rejects.toMatchObject({ code: "claude_binary_missing" });
    expect(spawns).toEqual([]);
  });

  it("a stored path that is gone, a directory or not executable is claude_binary_missing, with no spawn", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "plain"), "#!/bin/sh\n", { mode: 0o644 });
    for (const storedPath of [path.join(dir, "gone"), dir, path.join(dir, "plain")]) {
      const { load, spawns } = source(makeFake(), { storedPath });
      await expect(load()).rejects.toMatchObject({ code: "claude_binary_missing" });
      expect(spawns).toEqual([]);
    }
  });
});

describe("flag capability check", () => {
  it("passes when --help lists every flag the argument list uses", async () => {
    await expect(source(makeFake()).load()).resolves.toMatchObject({ version: DEFAULT_VERSION });
  });

  it.each(REQUIRED_FLAGS.map((flag) => [flag]))("a --help without %s refuses the job, naming the flag, with no model run", async (flag) => {
    const fake = makeFake({ help: helpWithout(FULL_HELP, flag) });
    await expect(source(fake).load()).rejects.toMatchObject({ code: "claude_flags_unsupported", message: expect.stringContaining(flag) });
    expect(fake.calls()).toEqual(["--version ", "--help "]);
  });

  it("a flag that is only the start of a longer name does not count", async () => {
    await expect(source(makeFake({ help: helpWithout(FULL_HELP, "--tools", "--tools-extra") })).load()).rejects.toMatchObject({ code: "claude_flags_unsupported", message: expect.stringContaining("--tools") });
  });

  it("an unreadable --help is refused as unsupported", async () => {
    const fake = makeFake();
    writeFileSync(fake.binary, readFileSync(fake.binary, "utf8").replace('--help) cat "$D/help.txt"; exit 0;;', "--help) exit 2;;"), { mode: 0o755 });
    await expect(source(fake).load()).rejects.toMatchObject({ code: "claude_flags_unsupported" });
  });

  it("reads --help once per version: a second job on the same version does not run it again", async () => {
    const fake = makeFake();
    const cacheDir = tempDir();
    await source(fake, { cacheDir }).load();
    await source(fake, { cacheDir }).load();
    expect(fake.calls().filter((call) => call.startsWith("--help"))).toHaveLength(1);
    expect(statSync(path.join(cacheDir, "claude-flags.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path.join(cacheDir, "claude-flags.json"), "utf8"))).toEqual({ [DEFAULT_VERSION]: { missing: [] } });
  });

  it("a refusal is cached too, so a missing flag is not re-asked", async () => {
    const fake = makeFake({ help: "Usage: claude\n" });
    const cacheDir = tempDir();
    await expect(source(fake, { cacheDir }).load()).rejects.toMatchObject({ code: "claude_flags_unsupported" });
    await expect(source(fake, { cacheDir }).load()).rejects.toMatchObject({ code: "claude_flags_unsupported" });
    expect(fake.calls().filter((call) => call.startsWith("--help"))).toHaveLength(1);
  });

  it("a new version busts the cache: the older version's good answer does not excuse the newer build", async () => {
    const cacheDir = tempDir();
    await source(makeFake(), { cacheDir }).load();
    const newer = makeFake({ version: "2.1.300 (Claude Code)", help: "Usage: claude\n" });
    await expect(source(newer, { cacheDir }).load()).rejects.toMatchObject({ code: "claude_flags_unsupported" });
    expect(newer.calls().filter((call) => call.startsWith("--help"))).toHaveLength(1);
  });

  it("never follows a link planted at the old fixed temp name, and leaves no temp file behind", async () => {
    const cacheDir = tempDir();
    const victim = path.join(tempDir(), "victim.txt");
    writeFileSync(victim, "keep me");
    symlinkSync(victim, path.join(cacheDir, "claude-flags.json.tmp"));
    await source(makeFake(), { cacheDir }).load();
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(JSON.parse(readFileSync(path.join(cacheDir, "claude-flags.json"), "utf8"))).toEqual({ [DEFAULT_VERSION]: { missing: [] } });
    expect(readdirSync(cacheDir).filter((name) => name.endsWith(".tmp") && name !== "claude-flags.json.tmp")).toEqual([]);
  });

  it("a planted file at the old fixed name does not block the write either", async () => {
    const cacheDir = tempDir();
    writeFileSync(path.join(cacheDir, "claude-flags.json.tmp"), "squatter");
    await expect(source(makeFake(), { cacheDir }).load()).resolves.toBeDefined();
    expect(JSON.parse(readFileSync(path.join(cacheDir, "claude-flags.json"), "utf8"))).toEqual({ [DEFAULT_VERSION]: { missing: [] } });
  });

  it("the temp file is made with an exclusive create under a random name", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "src", "engines", "claude", "pin.ts"), "utf8");
    expect(text).toMatch(/flag: "wx"/);
    expect(text).toMatch(/randomBytes\(6\)/);
    expect(text).not.toMatch(/\$\{cacheFile\}\.tmp/);
  });

  it("a damaged cache is ignored and rewritten", async () => {
    const cacheDir = tempDir();
    writeFileSync(path.join(cacheDir, "claude-flags.json"), "{ not json");
    await expect(source(makeFake(), { cacheDir }).load()).resolves.toBeDefined();
    expect(JSON.parse(readFileSync(path.join(cacheDir, "claude-flags.json"), "utf8"))).toEqual({ [DEFAULT_VERSION]: { missing: [] } });
  });
});
