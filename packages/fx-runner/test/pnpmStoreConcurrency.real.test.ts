import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { jobEnvFor } from "../src/sandbox/allowances.js";

/**
 * D#6 C43-3, with the real pnpm: two jobs on one repo share one package store (`<cache>/pnpm-store/<storeKey>`), and each job installs into it.
 * Two `pnpm install --frozen-lockfile` runs start at the same moment against one store, on an empty store and again on a warm one, each with
 * the environment the runner builds for a job (`jobEnvFor` then `cleanEnv`, so the store settings are the real ones, store integrity checks on).
 * Both must succeed, leave identical installs, and leave a store that `pnpm store status` and a third install accept.
 * The packages are local tarballs, so no network is used; they share file contents, so the two installs write the same store entries.
 * What this cannot show: pnpm's behaviour with a registry fetch in flight, and a pnpm version other than the one on the PATH.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const probe = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 30_000 });
const hasPnpm = probe.status === 0 && /^\d+\.\d+\.\d+/.test(probe.stdout.trim());
const major = hasPnpm ? Number(probe.stdout.trim().split(".")[0]) : 0;
const hasTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).status === 0;

const PACKAGES = 8;
const FILES_PER_PACKAGE = 40;

let scratch: string;
let store: string;

afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

const envFor = (name: string): Record<string, string> => cleanEnv({ mode: "subscription" }, { jobEnv: jobEnvFor({ tempDir: path.join(scratch, "tmp", name), store, commandTimeoutS: 1800 }) });

function pnpm(args: string[], cwd: string, name: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = execFile("pnpm", args, { cwd, env: envFor(name), encoding: "utf8", timeout: 100_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, out: `${stdout}${stderr}` });
    });
    child.stdin?.end();
  });
}

/** The relative path and the hash of every file in an install's top-level packages. */
function treeHash(project: string): string {
  const lines: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${rel}/${entry.name}`);
      else if (entry.isFile()) lines.push(`${rel}/${entry.name} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  for (let n = 0; n < PACKAGES; n++) walk(path.join(project, "node_modules", `fxc-pkg-${n}`), `fxc-pkg-${n}`);
  return lines.join("\n");
}

describe.skipIf(!hasPnpm || major < 11 || !hasTar)("C43-3: two jobs install into one pnpm store at the same time (real pnpm)", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "fxc43-pnpm-"));
    store = path.join(scratch, "pnpm-store", "repo-id-1");
    mkdirSync(path.join(scratch, "pkgs"), { recursive: true });
    const dependencies: Record<string, string> = {};
    for (let n = 0; n < PACKAGES; n++) {
      const root = path.join(scratch, "src", `fxc-pkg-${n}`, "package");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: `fxc-pkg-${n}`, version: "1.0.0" }));
      for (let f = 0; f < FILES_PER_PACKAGE; f++) {
        // Half of each package is the same text in every package (the same store entry written by every install), half is its own.
        writeFileSync(path.join(root, `file-${f}.js`), f % 2 === 0 ? `module.exports = "shared ${f}";\n${"x".repeat(2000)}\n` : `module.exports = "pkg ${n} file ${f}";\n`);
      }
      execFileSync("tar", ["-czf", path.join(scratch, "pkgs", `fxc-pkg-${n}.tgz`), "-C", path.join(scratch, "src", `fxc-pkg-${n}`), "package"]);
      dependencies[`fxc-pkg-${n}`] = `file:../pkgs/fxc-pkg-${n}.tgz`;
    }
    for (const project of ["p1", "p2", "p3"]) {
      mkdirSync(path.join(scratch, project), { recursive: true });
      writeFileSync(path.join(scratch, project, "package.json"), JSON.stringify({ name: "fxc-project", version: "1.0.0", private: true, dependencies }));
    }
    const locked = await pnpm(["install", "--lockfile-only", "--ignore-scripts"], path.join(scratch, "p1"), "lock");
    expect(locked.code, locked.out).toBe(0);
    for (const project of ["p2", "p3"]) writeFileSync(path.join(scratch, project, "pnpm-lock.yaml"), readFileSync(path.join(scratch, "p1", "pnpm-lock.yaml")));
  });

  it("two simultaneous installs on an empty store both succeed and leave identical installs", async () => {
    const [one, two] = await Promise.all([
      pnpm(["install", "--frozen-lockfile", "--ignore-scripts"], path.join(scratch, "p1"), "job-1"),
      pnpm(["install", "--frozen-lockfile", "--ignore-scripts"], path.join(scratch, "p2"), "job-2"),
    ]);
    expect(one.code, one.out).toBe(0);
    expect(two.code, two.out).toBe(0);
    expect(treeHash(path.join(scratch, "p1"))).toBe(treeHash(path.join(scratch, "p2")));
    expect(treeHash(path.join(scratch, "p1")).split("\n")).toHaveLength(PACKAGES * (FILES_PER_PACKAGE + 1));
  });

  it("the store both jobs used passes pnpm's own check, and a third install from it succeeds with the same files", async () => {
    expect(readdirSync(store).length).toBeGreaterThan(0); // the jobs really used the shared store directory
    for (const [project, name] of [["p1", "check-1"], ["p2", "check-2"]] as const) {
      const status = await pnpm(["store", "status"], path.join(scratch, project), name);
      expect(status.code, status.out).toBe(0);
    }
    const third = await pnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], path.join(scratch, "p3"), "job-3");
    expect(third.code, third.out).toBe(0);
    expect(treeHash(path.join(scratch, "p3"))).toBe(treeHash(path.join(scratch, "p1")));
  });

  it("three rounds of two simultaneous installs on the warm store, from clean node_modules, keep succeeding", async () => {
    for (let round = 0; round < 3; round++) {
      for (const project of ["p1", "p2"]) rmSync(path.join(scratch, project, "node_modules"), { recursive: true, force: true });
      const [one, two] = await Promise.all([
        pnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], path.join(scratch, "p1"), `warm-${round}-1`),
        pnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], path.join(scratch, "p2"), `warm-${round}-2`),
      ]);
      expect(one.code, one.out).toBe(0);
      expect(two.code, two.out).toBe(0);
      expect(treeHash(path.join(scratch, "p1"))).toBe(treeHash(path.join(scratch, "p2")));
    }
    const status = await pnpm(["store", "status"], path.join(scratch, "p1"), "status-final");
    expect(status.code, status.out).toBe(0);
  });
});
