import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as publicSurface from "../src/index.js";
import * as poolsModule from "../src/pools.js";
import { PROVISIONERS, countScannedFiles, scanModes } from "./support/scanRunnerLoginReaders.js";
import { RECEIPT_LOGIN_NAME, receiptProvisionerViolation, scanReceiptLoginReaders } from "./support/scanReceiptLoginReaders.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NAME = RECEIPT_LOGIN_NAME;
const FILE_FLOOR = 1500;

/** D#7 DP4b-1 (R-7-DP4b-5): pools.ts is the only reader of the receipt-login variable, as it is for the runner login (CARRY-8). */
describe("pools.ts is the only reader of the receipt-login variable", () => {
  it("the real repo is clean: no source anywhere reads it, spells it out, or imports the worker's internals", () => {
    // A floor, so a scan that lists no files cannot pass as clean; and it listed through git, which leaves untracked build output out.
    expect(countScannedFiles(REPO_ROOT)).toBeGreaterThan(FILE_FLOOR);
    expect(scanModes(REPO_ROOT)).toEqual({ apps: "git", packages: "git", sites: "git", scripts: "git" });
    expect(scanReceiptLoginReaders(REPO_ROOT)).toEqual([]);
  });

  it("is not vacuous: pools.ts really reads the variable, and the settings manifest really names it", () => {
    expect(readFileSync(path.join(REPO_ROOT, "packages/worker/src/pools.ts"), "utf8")).toContain(NAME);
    expect(readFileSync(path.join(REPO_ROOT, "apps/web/env-manifest.ts"), "utf8")).toContain(NAME);
  });

  it("the name is not exported by the package entry or by pools.ts, and the Worker hands out no receipt pool", () => {
    for (const ns of [publicSurface, poolsModule] as Record<string, unknown>[]) {
      expect(Object.keys(ns).filter((k) => /RECEIPT_LOGIN/.test(k))).toEqual([]);
      expect(Object.values(ns).filter((v) => typeof v === "string" && v.includes(NAME))).toEqual([]);
    }
  });
});

describe("the receipt scan goes red on each way around it", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** A throwaway repo root holding `files` (relative path -> content). */
  function fixture(files: Record<string, string>): string[] {
    const root = mkdtempSync(path.join(tmpdir(), "rcpt-reader-"));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    }
    return scanReceiptLoginReaders(root);
  }

  const read = `export const x = process.env.${NAME};\n`;

  it("a clean fixture is clean, including the one allowed reader and a helper that indexes with a parameter", () => {
    expect(
      fixture({
        "packages/worker/src/pools.ts": read,
        "apps/web/app/api/a/route.ts": "const need = (name: string) => process.env[name];\nexport const v = need('OTHER_URL');\n",
      }),
    ).toEqual([]);
  });

  it("a second module that names it, in the worker package or outside it", () => {
    expect(fixture({ "packages/worker/src/decisionIntake.ts": read })).toHaveLength(1);
    expect(fixture({ "packages/api/src/routes/answer.ts": read })).toHaveLength(1);
    expect(fixture({ "apps/web/app/api/x/route.ts": read })).toHaveLength(1);
    expect(fixture({ "scripts/some.mjs": read })).toHaveLength(1);
  });

  it("a route directory named test, build or dist is source and is scanned", () => {
    for (const dir of ["test", "tests", "build", "dist", "coverage"]) {
      expect(fixture({ [`apps/web/app/api/runs/${dir}/route.ts`]: read }), dir).toHaveLength(1);
    }
  });

  it("in a git checkout: a tracked build/ route is scanned, untracked ignored output is not", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rcpt-reader-git-"));
    roots.push(root);
    const put = (rel: string, content: string): void => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    };
    execFileSync("git", ["-C", root, "init", "-q"]);
    put(".gitignore", "generated-out\n");
    put("apps/web/app/api/runs/build/route.ts", read);
    put("apps/web/generated-out/leftover.js", read);
    execFileSync("git", ["-C", root, "add", "apps/web/app", ".gitignore"]);
    expect(scanReceiptLoginReaders(root).map((v) => v.split(":")[0])).toEqual([path.join("apps", "web", "app", "api", "runs", "build", "route.ts")]);
  });

  it("indirect reads: a folded name, a constant key, a joined name, destructuring with a computed key or rest, enumeration", () => {
    const half = NAME.slice(0, 13);
    const rest = NAME.slice(13);
    const cases: Record<string, string> = {
      concat: `export const v = process.env["${half}" + "${rest}"];\n`,
      constKey: `const K = "${NAME}";\nexport const v = process.env[K];\n`,
      splitConst: `const A = "${half}";\nexport const v = process.env[A + "${rest}"];\n`,
      join: `export const v = process.env[["${NAME.split("_").join('","')}"].join("_")];\n`,
      computedDestructure: "const k = pick();\nconst { [k]: v } = process.env;\n",
      restDestructure: "const { A, ...others } = process.env;\n",
      entries: "export const all = Object.entries(process.env);\n",
      spread: "export const all = { ...process.env };\n",
    };
    for (const [label, content] of Object.entries(cases)) {
      expect(fixture({ "apps/web/app/api/x/route.ts": content }), label).toHaveLength(1);
    }
  });

  it("importing or re-exporting pools.ts from outside the package", () => {
    expect(fixture({ "apps/web/app/api/x/route.ts": "import { make } from '@fx/worker/src/pools.js';\nexport const v = make;\n" })).toHaveLength(1);
    expect(fixture({ "apps/web/lib/re.ts": "export * from '../../../packages/worker/src/pools.js';\n" })).toHaveLength(1);
    expect(fixture({ "apps/web/lib/dyn.ts": "const m = await import('@fx/' + 'worker/src/' + 'pools.js');\n" })).toHaveLength(1);
  });

  // The staging credentials script and its test may name the variable to provision it; by exact path, never to read it.
  const [provTest] = PROVISIONERS;
  const names = `const VARS = ['${NAME}'];\nexport const w = (v: string) => run('env', 'add', '${NAME}', v);\n`;

  it("an allowlisted provisioner path that only names the variable is clean; the same text at any other path is not", () => {
    expect(fixture({ [provTest!]: names })).toEqual([]);
    expect(fixture({ "packages/db/test/other.test.ts": names })).toHaveLength(1);
    expect(fixture({ "apps/web/app/api/x/route.ts": names })).toHaveLength(1);
  });

  it("an allowlisted provisioner path goes red on each way of reading the variable", () => {
    const cases: Record<string, string> = {
      processEnvDot: names + `export const a = process.env.${NAME};\n`,
      processEnvBracket: names + `export const a = process.env['${NAME}'];\n`,
      optionalBracket: names + `export const a = process.env?.['${NAME}'];\n`,
      destructure: names + `const { ${NAME} } = process.env;\n`,
      computedKey: names + "export const a = process.env[VARS[0]];\n",
      enumerate: names + "export const a = Object.keys(process.env);\n",
      wholeCopy: names + "const childEnv = { ...process.env };\nspawn('x', [], { env: childEnv });\n",
      nameAsIdentifier: names + `const ${NAME} = 1;\n`,
    };
    for (const [label, content] of Object.entries(cases)) {
      expect(receiptProvisionerViolation(content), label).toBeTruthy();
      expect(fixture({ [provTest!]: content }), label).toHaveLength(1);
    }
  });

  it("the real provisioner files, where they exist, only name the variable", () => {
    for (const rel of PROVISIONERS) {
      // The ops script and its test are private overlay files; the public tree has neither.
      if (!existsSync(path.join(REPO_ROOT, rel))) continue;
      expect(receiptProvisionerViolation(readFileSync(path.join(REPO_ROOT, rel), "utf8")), rel).toBeUndefined();
    }
  });

  it("the settings manifest may name it as data only; code in it is refused", () => {
    expect(fixture({ "apps/web/env-manifest.ts": `export const A = "${NAME}";\n` })).toEqual([]);
    expect(fixture({ "apps/web/env-manifest.ts": `export const A = process.env.${NAME};\n` })).toHaveLength(1);
  });
});
