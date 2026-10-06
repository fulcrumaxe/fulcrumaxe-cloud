import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as publicSurface from "../src/index.js";
import * as poolsModule from "../src/pools.js";
import { PROVISIONERS, RUNNER_LOGIN_NAME, countScannedFiles, provisionerViolation, scanModes, scanRunnerLoginReaders } from "./support/scanRunnerLoginReaders.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NAME = RUNNER_LOGIN_NAME;
const FILE_FLOOR = 1500;

/** CARRY-8: the runner login sits in the web deployment's environment (one Vercel project), so the code boundary is what keeps a web route from reading it. */
describe("CARRY-8: pools.ts is the only reader of the runner-login variable", () => {
  it("the real repo is clean: no source anywhere (test and tests directories included) reads it, spells it out, or imports the worker's internals", () => {
    // A floor, so a scan that lists no files (it once did, in a worktree) cannot pass as clean.
    expect(countScannedFiles(REPO_ROOT)).toBeGreaterThan(FILE_FLOOR);
    // And it listed through git, which leaves untracked build output out; a directory walk would include it.
    expect(scanModes(REPO_ROOT)).toEqual({ apps: "git", packages: "git", sites: "git", scripts: "git" });
    expect(scanRunnerLoginReaders(REPO_ROOT)).toEqual([]);
  });

  it("the name is not exported by the package entry or by pools.ts", () => {
    for (const ns of [publicSurface, poolsModule] as Record<string, unknown>[]) {
      expect(Object.keys(ns).filter((k) => /RUNNER_LOGIN|RUN_WRITER/.test(k))).toEqual([]);
      expect(Object.values(ns).filter((v) => typeof v === "string" && v.includes(NAME))).toEqual([]);
    }
  });
});

describe("the scan goes red on each way around it", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** A throwaway repo root holding `files` (relative path -> content). */
  function fixture(files: Record<string, string>): string[] {
    const root = mkdtempSync(path.join(tmpdir(), "carry8-"));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    }
    return scanRunnerLoginReaders(root);
  }

  const read = `export const x = process.env.${NAME};\n`;

  it("a clean fixture is clean (including the allowed reader and a helper that indexes with a parameter)", () => {
    expect(
      fixture({
        "packages/worker/src/pools.ts": read,
        "apps/web/app/api/a/route.ts": "const need = (name: string) => process.env[name];\nexport const v = need('OTHER_URL');\n",
      }),
    ).toEqual([]);
  });

  it("a route directory named test", () => {
    expect(fixture({ "apps/web/app/api/x/test/route.ts": read })).toHaveLength(1);
    expect(fixture({ "apps/web/app/api/x/tests/route.ts": read })).toHaveLength(1);
  });

  it("a route directory named build, and one named dist, coverage, or a tracked build tree", () => {
    for (const dir of ["build", "dist", "coverage"]) {
      expect(fixture({ [`apps/web/app/api/runs/${dir}/route.ts`]: read }), dir).toHaveLength(1);
    }
    expect(fixture({ "packages/pipeline/src/build/continuation.ts": read })).toHaveLength(1);
  });

  it("in a git checkout: a tracked build/ or dist/ route is scanned, untracked ignored output is not", () => {
    const root = mkdtempSync(path.join(tmpdir(), "carry8-git-"));
    roots.push(root);
    const put = (rel: string, content: string): void => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    };
    execFileSync("git", ["-C", root, "init", "-q"]);
    put(".gitignore", "generated-out\n");
    put("apps/web/app/api/runs/build/route.ts", read);
    put("apps/web/app/api/runs/dist/route.ts", read);
    put("apps/web/generated-out/leftover.js", read);
    execFileSync("git", ["-C", root, "add", "apps/web/app", ".gitignore"]);
    expect(scanRunnerLoginReaders(root).map((v) => v.split(":")[0])).toEqual([
      path.join("apps", "web", "app", "api", "runs", "build", "route.ts"),
      path.join("apps", "web", "app", "api", "runs", "dist", "route.ts"),
    ]);
  });

  it("a dynamic import whose path is built by concatenation", () => {
    expect(fixture({ "apps/web/lib/dyn.ts": "const m = await import('@fx/' + 'worker/src/' + 'pools.js');\n" })).toHaveLength(1);
  });

  it("every JS/TS extension, .jsx first", () => {
    for (const ext of ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]) {
      expect(fixture({ [`apps/web/app/p/page.${ext}`]: read }), ext).toHaveLength(1);
    }
  });

  it("importing pools.ts from outside the package, and re-exporting it", () => {
    expect(
      fixture({ "apps/web/app/api/x/route.ts": "import { RUNNER_LOGIN_ENV } from '@fx/worker/src/pools.js';\nexport const v = process.env[RUNNER_LOGIN_ENV];\n" }),
    ).toHaveLength(1);
    expect(fixture({ "apps/web/lib/re.ts": "export * from '../../../packages/worker/src/pools.js';\n" })).toHaveLength(1);
    expect(fixture({ "apps/web/lib/re2.ts": "const m = await import('@fx/worker/src/pools.js');\n" })).toHaveLength(1);
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

  it("a file inside the worker package other than pools.ts may not name it either", () => {
    expect(fixture({ "packages/worker/src/compositionRoot.ts": read })).toHaveLength(1);
  });

  // The staging credentials script and its test name the variable to provision it in Vercel.
  // They are allowlisted by exact path, and must never read its value or reach the worker.
  const [provTest] = PROVISIONERS;
  const names = `const VARS = ['${NAME}'];\nexport const w = (v: string) => run('env', 'add', '${NAME}', v);\n`;

  it("the real provisioner files only name the variable: no env access to it, no worker import", () => {
    expect(PROVISIONERS).toHaveLength(2);
    for (const rel of PROVISIONERS) {
      // The ops script and its test are private overlay files; the public tree has neither.
      if (!existsSync(path.join(REPO_ROOT, rel))) continue;
      const source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(source, rel).toContain(NAME); // they do name it, so the allowlist is not vacuous
      expect(provisionerViolation(source), rel).toBeUndefined();
    }
  });

  it("an allowlisted path that only names the variable is clean; the same text at any other path is not", () => {
    expect(fixture({ [provTest!]: names })).toEqual([]);
    expect(fixture({ "packages/db/test/other.test.ts": names })).toHaveLength(1);
    expect(fixture({ "apps/web/app/api/x/route.ts": names })).toHaveLength(1);
  });

  it("an allowlisted path goes red on every way of reading the variable or reaching the worker", () => {
    const head = NAME.slice(0, 8);
    const tail = NAME.slice(8);
    const cases: Record<string, string> = {
      processEnvDot: names + `export const a = process.env.${NAME};\n`,
      processEnvBracket: names + `export const a = process.env['${NAME}'];\n`,
      optionalChain: names + `export const a = process.env?.${NAME};\n`,
      optionalBracket: names + `export const a = process.env?.['${NAME}'];\n`,
      destructure: names + `const { ${NAME} } = process.env;\n`,
      destructureRenamed: names + `const { ${NAME}: runner } = process.env;\n`,
      destructureQuotedRenamed: names + `const { '${NAME}': runner } = process.env;\n`,
      destructureRest: names + "const { A, ...others } = process.env;\n",
      keySplitAcrossLines: names + `export const a = process.env[\n  '${head}' +\n  '${tail}'\n];\n`,
      computedKey: names + "export const a = process.env[VARS[0]];\n",
      processBracketEnv: names + `export const a = process['env'].${NAME};\n`,
      processBracketBoth: names + `export const a = process['env']['${NAME}'];\n`,
      processComputed: names + "export const a = process[VARS[0]].X;\n",
      aliasEnv: names + "const e = process.env;\nexport const a = e.X;\n",
      aliasProcess: names + "const p = process;\nexport const a = p.env.X;\n",
      reflectGet: names + `export const a = Reflect.get(process.env, '${NAME}');\n`,
      jsonStringify: names + "export const a = JSON.stringify(process.env);\n",
      forIn: names + "for (const k in process.env) { void k; }\n",
      forOf: names + "for (const [k] of Object.entries(process.env)) { void k; }\n",
      fromEntries: names + "export const a = Object.fromEntries(Object.entries(process.env));\n",
      enumerate: names + "export const a = Object.keys(process.env);\n",
      spread: names + "export const a = { ...process.env };\n",
      secondWholeCopy: names + "const c = { ...process.env };\nexport const a = c;\n",
      globalThisRoute: names + "export const a = globalThis.process.env.X;\n",
      hiddenInTemplate: names + `export const a = \`x \${process.env['${NAME}']}\`;\n`,
      hiddenComputedInTemplate: names + "export const a = `x ${process.env[VARS[0]]}`;\n",
      envParam: names + `export const a = (env: Record<string, string>) => env.${NAME};\n`,
      envParamBracket: names + `export const a = (env: Record<string, string>) => env[VARS[0] ?? '${NAME}'];\n`,
      nameAsIdentifier: names + `const ${NAME} = 1;\n`,
      wholeCopyThenChild: names + "const childEnv = { ...process.env };\nspawn('x', [], { env: childEnv });\n",
      wholeCopyWithDeletes: names + "const childEnv = { ...process.env };\nfor (const v of VARS) delete childEnv[v.name];\nspawn('x', [], { env: childEnv });\n",
      importDefault: names + "import proc from 'process';\n",
      importNodeDefault: names + "import proc from 'node:process';\n",
      importNamespace: names + "import * as p from 'node:process';\n",
      importNamed: names + "import { env as e } from 'node:process';\n",
      importSideEffectNamed: names + "import { env } from 'process';\n",
      dynamicImport: names + "const p = await import('node:process');\n",
      dynamicImportComputed: names + "const p = await import(VARS[0]);\n",
      requireProcess: names + "const p = require('process');\n",
      requireComputed: names + "const p = require(VARS[0]);\n",
      createRequireProcess: names + "const r = createRequire(import.meta.url);\nconst p = r('node:process');\n",
      createRequireChained: names + "const p = createRequire(import.meta.url)('process');\n",
      createRequireComputed: names + "const p = createRequire(new URL('x', import.meta.url))(VARS[0]);\n",
      escapedNameInKey: names + `export const a = process.env['${NAME.slice(0, 3)}\\${NAME.slice(3)}'];\n`,
      unicodeEscapedKey: names + `export const a = process.env['\\u0046${NAME.slice(1)}'];\n`,
      unicodeBraceKey: names + `export const a = process.env['\\u{46}${NAME.slice(1)}'];\n`,
      hexEscapedKey: names + `export const a = process.env['\\x46${NAME.slice(1)}'];\n`,
      lineContinuationKey: names + `export const a = process.env['${NAME.slice(0, 9)}\\\n${NAME.slice(9)}'];\n`,
      escapedProcessModule: names + "import p from 'pro\\cess';\n",
      escapedEnvKeyOnProcess: names + `export const a = process['\\env'][\'${NAME}\'];\n`,
      concatImport: names + "const p = await import('pro' + 'cess');\n",
      templateImport: names + "const m = 'node';\nconst p = await import(`${m}:process`);\n",
      variableImport: names + "const m = 'process';\nconst p = await import(m);\n",
      concatRequire: names + "const p = require('pro' + 'cess');\n",
      concatCreateRequire: names + "const p = createRequire(import.meta.url)('pro' + 'cess');\n",
      importWithSecondArgument: names + "const p = await import('./x.ts', { with: {} });\n",
      hexEscape: names + "const p\\x72ocess = 1;\n",
      workerImport: names + "import { x } from '../../worker/src/pools.js';\n",
    };
    for (const [label, content] of Object.entries(cases)) {
      expect(provisionerViolation(content), label).toBeTypeOf("string");
      expect(fixture({ [provTest!]: content }), label).toHaveLength(1);
    }
  });

  it("an allowlisted path may still use plain env keys, an explicit child environment and literal imports", () => {
    const fine = [
      names + "export const a = process.env.PATH;\nexport const b = process.env['HOME'];\nexport const c = process.env?.TMPDIR;\n",
      names + "const x = `${process.env.PATH}:more`;\n",
      names + "const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME };\nspawn('vercel', [], { env: childEnv });\n",
      names + "const { Pool } = createRequire(new URL('x', import.meta.url))('pg');\nconst m = await import('../x.ts');\n",
      names + "const text = 'line\\n\\t\\\\ \\$ \\' done';\nconst t = `a\\${b} ${process.env.PATH}`;\n",
    ];
    for (const content of fine) expect(provisionerViolation(content), content).toBeUndefined();
  });

  it("scripts/ is scanned: another script naming it is a violation, and so is the allowlisted one reading it", () => {
    expect(fixture({ "scripts/ops/other.mjs": names })).toHaveLength(1);
    expect(fixture({ [PROVISIONERS[1]!]: names })).toEqual([]);
    expect(fixture({ [PROVISIONERS[1]!]: names + `export const a = process.env.${NAME};\n` })).toHaveLength(1);
  });

  it("a checkout that itself sits under a skipped directory (a .claude worktree) is still scanned", () => {
    const outer = mkdtempSync(path.join(tmpdir(), "carry8-"));
    roots.push(outer);
    const root = path.join(outer, ".claude", "worktrees", "agent-x");
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });
    writeFileSync(path.join(root, "apps", "web", "route.ts"), read);
    expect(scanRunnerLoginReaders(root)).toHaveLength(1);
  });
});
