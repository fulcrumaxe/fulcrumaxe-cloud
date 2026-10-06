import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ENV_MANIFEST } from "../env-manifest";
import { DOCS_BEGIN, DOCS_END, renderEnvDocs, replaceGeneratedBlock } from "../lib/env/docs";
import { namesOnlyViolations, RUNNER_LOGIN_NAME, scanRunnerLoginReaders } from "../../../packages/worker/test/support/scanRunnerLoginReaders";
import { DYNAMIC_KEY, scanEnvReads, scanFile, spelledNames } from "./support/envScan";

const ROOT = path.join(__dirname, "..", "..", "..");

/**
 * Names the scan can pick up that are not environment variables the app
 * reads. A name goes here only with the reason, and only when it appears in a
 * file that reads env through a variable (so every env-shaped literal in that
 * file is a candidate).
 */
const NOT_ENV_READS: Record<string, string> = {
  BUILD_ID: "the .next/BUILD_ID file name in the SSE benchmark, not a variable",
  VERCEL_ORG_ID: "named in the deployed-environment deny-list (packages/runtime/src/env-detect.ts), which looks at keys; nothing reads its value",
  VERCEL_TOKEN: "named in the deployed-environment deny-list (packages/runtime/src/env-detect.ts), which looks at keys; nothing reads its value",
};

/**
 * Files that read env through a computed key (`env[name]`, `cfg[k]`) and spell no env-shaped name of
 * their own, so the scan has no candidate name to check. Each needs a reason that says where the names
 * come from; a new computed read anywhere else fails the coverage test until it is listed here.
 */
const COMPUTED_KEY_FILES: Record<string, string> = {
  "apps/web/lib/env/check.ts": "the manifest checker: it looks up exactly the names ENV_MANIFEST lists",
  "packages/github/src/createRepo.ts": "takes the App kind's client id and secret names from its caller; those names are spelled and listed through packages/github/src/appCredentials.ts",
  "packages/runner/src/fakeSandbox.ts": "the `env` it indexes is a sandbox environment map handed to a fake sandbox, not this process's environment",
};

const KNOWN = new Set(ENV_MANIFEST.map((e) => e.name));

function isListed(name: string, prefix: boolean): boolean {
  if (!prefix) return KNOWN.has(name);
  // `FX_CURSOR_KEY_V${version}`: a versioned family. Any listed name that starts with the fixed head covers it.
  return [...KNOWN].some((known) => known.startsWith(name));
}

describe("env manifest coverage", () => {
  const reads = scanEnvReads(ROOT);

  it("lists every environment variable the apps/web and packages source reads", () => {
    const unlisted = reads
      .filter((r) => (r.name === DYNAMIC_KEY ? !(r.file in COMPUTED_KEY_FILES) : !isListed(r.name, r.prefix) && !(r.name in NOT_ENV_READS)))
      .map((r) => `${r.name}${r.prefix ? "*" : ""} (${r.how}) in ${r.file}`);
    expect([...new Set(unlisted)].sort()).toEqual([]);
  });

  it("has no computed-key allowlist entry that is not needed any more", () => {
    const seen = new Set(reads.filter((r) => r.name === DYNAMIC_KEY).map((r) => r.file));
    expect(Object.keys(COMPUTED_KEY_FILES).filter((file) => !seen.has(file))).toEqual([]);
  });

  it("is not blind: the scan finds reads of each shape the source uses", () => {
    const find = (name: string) => reads.find((r) => r.name === name);
    expect(find("FX_APP_ORIGIN")).toMatchObject({ how: "direct", prefix: false }); // process.env.X
    expect(find("GITHUB_INSTALL_STATE_SECRET")).toMatchObject({ how: "direct" }); // d.env.X
    expect(find("FX_GH_FORWARD_SUFFIX")).toMatchObject({ how: "direct" }); // env["X"]
    expect(find("FX_CURSOR_KEY_V")).toMatchObject({ prefix: true }); // env[`X${n}`]
    expect(find("GITHUB_APP_SITEKIT_PRIVATE_KEY_PEM")).toMatchObject({ how: "dynamic" }); // env[names.x]
    expect(find("STRIPE_PRICE_ID_SCALE")).toMatchObject({ how: "dynamic" }); // env[TABLE[x]]
    expect(reads.length).toBeGreaterThan(60);
  });

  it("has no allowlist entry that is not needed any more", () => {
    const seen = new Set(reads.map((r) => r.name));
    expect(Object.keys(NOT_ENV_READS).filter((name) => !seen.has(name))).toEqual([]);
  });

  it("lists no name that the source never spells (a stale entry)", () => {
    const spelled = spelledNames(ROOT);
    // A versioned family (FX_KEK_V1) is spelled as the template head `FX_KEK_V` in the source.
    const familyHeads = [...spelled].filter((s) => /^[A-Z][A-Z0-9_]*_V$/.test(s));
    const stale = ENV_MANIFEST.filter((e) => !spelled.has(e.name) && !familyHeads.some((head) => e.name.startsWith(head)));
    expect(stale.map((e) => e.name)).toEqual([]);
  });

  it("keeps each entry well formed", () => {
    const names = ENV_MANIFEST.map((e) => e.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    for (const entry of ENV_MANIFEST) {
      expect(entry.name, entry.name).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
      expect(entry.feature.length, entry.name).toBeGreaterThan(0);
      expect(entry.note.length, entry.name).toBeGreaterThan(0);
      expect(entry.requiredIn.every((k) => k === "staging" || k === "production" || k === "local"), entry.name).toBe(true);
      if (entry.scope === "tooling" || entry.scope === "platform") expect(entry.requiredIn, entry.name).toEqual([]);
      // A required setting that is missing must have a visible effect, not "none".
      if (entry.requiredIn.length > 0) expect(entry.whenMissing, entry.name).not.toBe("none");
    }
  });

  it("marks every key, secret, token and database login as secret", () => {
    const secretShaped = /(^|_)(SECRET|KEY|TOKEN|PEM|PASSWORD)(_|$)|KEK_V[0-9]|^(BENCH_)?DATABASE_URL/;
    const wrong = ENV_MANIFEST.filter((e) => secretShaped.test(e.name) && !e.secret).map((e) => e.name);
    expect(wrong).toEqual([]);
  });

  it("names the setting behind the incident: the cursor key is required where /api/v1/events is served", () => {
    const cursor = ENV_MANIFEST.find((e) => e.name === "FX_CURSOR_KEY_V1");
    expect(cursor).toMatchObject({ secret: true, validation: { type: "base64-32" } });
    expect(cursor?.requiredIn).toEqual(["staging", "production"]);
  });
});

/**
 * The runner-login and kick-secret guards in packages/worker and packages/pipeline exempt
 * apps/web/env-manifest.ts by exact path because it names variables, never reads them. This is what
 * keeps that exemption from becoming a read path: the file must pass a STRUCTURAL allow-list over its
 * syntax tree (namesOnlyViolations, shared with the CARRY-8 scan). It may hold type-only imports and
 * exports, type aliases, interfaces, and `export const NAME = <literal>`; every other kind of node is
 * refused by kind, not by word, so a spelling trick cannot get a call past it.
 */
describe("apps/web/env-manifest.ts stays names-only", () => {
  it("passes the structural allow-list", () => {
    expect(namesOnlyViolations(readFileSync(path.join(ROOT, "apps/web/env-manifest.ts"), "utf8"))).toEqual([]);
  });

  // [source, a fragment of the reason it must be refused]
  const BYPASSES: Array<[string, string]> = [
    // The four the security review listed: a deny-list of words cannot stop these, the allow-list refuses the call.
    ['export const A = (async () => {}).constructor("return pro" + "cess")();', "CallExpression"],
    ['export const A = [].constructor.constructor("return process")();', "CallExpression"],
    ['export const A = (() => {}).constructor("return process")();', "CallExpression"],
    ['export const A = this["pro" + "cess"];', "ElementAccessExpression"],
    // More ways to reach process, the environment or code.
    ["export const A = process.env.X;", "member access on something other than a const"],
    ['export const A = process["env"];', "ElementAccessExpression"],
    ["export const A = import.meta.env.X;", "member access on something other than a const"],
    ["export const A = globalThis.process;", "member access on something other than a const"],
    ['export const A = new Function("return process")();', "CallExpression"],
    ['export const A = eval("1");', "CallExpression"],
    ['export const A = require("node:fs");', "CallExpression"],
    ['export const A = await import("./x");', "AwaitExpression"],
    ['export const A = import("./x");', "CallExpression"],
    ["export const A = Reflect.get(globalThis, 'process');", "CallExpression"],
    ["export const A = String.raw`process`;", "TaggedTemplateExpression"],
    ["export const B = 'x'; export const A = `${B}`;", "TemplateExpression"],
    ['export const B = ["x"]; export const A = B["constructor"];', "ElementAccessExpression"],
    ["export const B = []; export const A = B.constructor;", "member access not allowed: .constructor"],
    ["export const B = {}; export const A = B.__proto__;", "member access not allowed: .__proto__"],
    ["export const B = {}; export const A = B.prototype;", "member access not allowed: .prototype"],
    ["export const A = { __proto__: null };", "object key not allowed: __proto__"],
    ['export const A = { ["pro" + "cess"]: 1 };', "object key not allowed"],
    ["export const A = { get x() { return 1; } };", "object member not allowed: GetAccessor"],
    ["export const A = { x() { return 1; } };", "object member not allowed: MethodDeclaration"],
    ["export const B = { a: 1 }; export const A = { ...B };", "object member not allowed: SpreadAssignment"],
    ["export const B = [1]; export const A = [...B];", "SpreadElement"],
    ['export const A = "a" + "b";', "BinaryExpression"],
    ["export const A = true ? 1 : 2;", "ConditionalExpression"],
    ["export const A = () => 1;", "ArrowFunction"],
    ["export const A = function () {};", "FunctionExpression"],
    ["export const A = class {};", "ClassExpression"],
    ["export const A = void 0;", "VoidExpression"],
    ["export const A = typeof 1;", "TypeOfExpression"],
    ["export const A = undefined;", "not a const of this file"],
    ["export const A = missing.value;", "member access on something other than a const"],
    ["export const A = /x/;", "RegularExpressionLiteral"],
    ["export const A = 1n;", "BigIntLiteral"],
    ["export const A = <const>[1];", "TypeAssertionExpression"],
    ["export const A = [1]!;", "NonNullExpression"],
    ["export const A = ;", "does not parse"],
    // Statements.
    ["process.env.X;", "statement not allowed: ExpressionStatement"],
    ['"use strict";', "statement not allowed: ExpressionStatement"],
    ["function f() {}", "statement not allowed: FunctionDeclaration"],
    ["export function f() {}", "statement not allowed: FunctionDeclaration"],
    ["export class C {}", "statement not allowed: ClassDeclaration"],
    ["export enum E { A }", "statement not allowed: EnumDeclaration"],
    ["export const enum E { A }", "statement not allowed: EnumDeclaration"],
    ["export namespace N {}", "statement not allowed: ModuleDeclaration"],
    ["export default {};", "statement not allowed: ExportAssignment"],
    ["export = {};", "statement not allowed: ExportAssignment"],
    ["declare const A: string;", "a const must be written `export const`"],
    ["export declare const A: string;", "a const must be written `export const`"],
    ["const A = 1;", "a const must be written `export const`"],
    ["export let A = 1;", "only const is allowed"],
    ["export var A = 1;", "only const is allowed"],
    ["export const { a } = { a: 1 };", "a const name must be a plain identifier"],
    ["export const [a] = [1];", "a const name must be a plain identifier"],
    ["export const A: string;", "a const needs a literal value"],
    ["if (true) {}", "statement not allowed: IfStatement"],
    ["for (;;) {}", "statement not allowed: ForStatement"],
    ["export const A = 1;\nimport.meta;", "statement not allowed: ExpressionStatement"],
    // Imports and exports that survive type erasure.
    ['import { x } from "node:crypto";', "runtime import"],
    ['import x from "./x";', "runtime import"],
    ['import * as x from "./x";', "runtime import"],
    ['import "./side-effect";', "runtime import"],
    ['import { type T } from "./t";', "runtime import"],
    ['import x = require("./x");', "statement not allowed: ImportEqualsDeclaration"],
    ['export * from "./other";', "runtime export"],
    ['export { x } from "./other";', "runtime export"],
    ['export { type T } from "./other";', "runtime export"],
    ["export const A = 1; export { A as B };", "runtime export"],
  ];

  it.each(BYPASSES)("goes red on %s", (text, why) => {
    const violations = namesOnlyViolations(text);
    expect(violations.length, text).toBeGreaterThan(0);
    expect(violations.join(" | "), text).toContain(why);
  });

  it("allows type-only imports and exports, type aliases, interfaces, and literal consts", () => {
    const text = [
      'import type { T } from "./t";',
      'export type { U } from "./u";',
      "export type K = T | 'a';",
      "interface Row { name: string; list: readonly string[] }",
      'export const SP: readonly string[] = ["staging", "production"];',
      "export const NONE = [] as const;",
      "export const N = -1;",
      "export const T1 = `plain`;",
      "export const ROW = { name: 'X', n: 2, on: true, off: false, nothing: null, 'quoted-key': 1, 3: 'c', SP };",
      "export const LIST = [{ a: SP, b: ROW.name }, ROW] satisfies readonly object[];",
      "export const DEEP = ROW.name.length;",
      "export const PARENS = ({ a: 1 }) as { a: number };",
    ].join("\n");
    expect(namesOnlyViolations(text)).toEqual([]);
  });

  it("the real file holds no call, new, element access or substituted template anywhere", () => {
    const text = readFileSync(path.join(ROOT, "apps/web/env-manifest.ts"), "utf8");
    const source = ts.createSourceFile("env-manifest.ts", text, ts.ScriptTarget.ES2022, true);
    const kinds = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isElementAccessExpression(node) || ts.isTemplateExpression(node)) kinds.add(ts.SyntaxKind[node.kind]!);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect([...kinds]).toEqual([]);
  });
});

/** The CARRY-8 scan (packages/worker) exempts the manifest by exact path; it holds that path to the same structural check. */
describe("the runner-login scan applies the names-only check to the exempt path", () => {
  function scanManifestText(text: string): string[] {
    const root = mkdtempSync(path.join(os.tmpdir(), "fx-carry8-"));
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });
    writeFileSync(path.join(root, "apps", "web", "env-manifest.ts"), text);
    return scanRunnerLoginReaders(root);
  }

  it("accepts the real manifest", () => {
    expect(scanManifestText(readFileSync(path.join(ROOT, "apps/web/env-manifest.ts"), "utf8"))).toEqual([]);
  });

  it.each([
    ['export const A = (async () => {}).constructor("return pro" + "cess")();', "CallExpression"],
    ['export const A = [].constructor.constructor("return process")();', "CallExpression"],
    ['export const A = (() => {}).constructor("return process")();', "CallExpression"],
    ['export const A = this["pro" + "cess"];', "ElementAccessExpression"],
    ["export const A = 1;\nfunction read() { return 1; }", "FunctionDeclaration"],
    ['import { x } from "node:fs";\nexport const A = 1;', "runtime import"],
  ])("refuses %s", (text, why) => {
    const found = scanManifestText(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^apps\/web\/env-manifest\.ts: is not names-only \(/);
    expect(found[0]).toContain(why);
  });

  it("still refuses a file that is data only but names the runner-login variable outside a quoted literal", () => {
    const name = RUNNER_LOGIN_NAME;
    expect(scanManifestText(`export const ${name} = "x";`)).toEqual(["apps/web/env-manifest.ts: names the variable outside a quoted literal"]);
    expect(scanManifestText(`export const A = "${name}";`)).toEqual([]);
  });
});

// docs/ops/ is a private overlay directory: the public tree has no staging doc to compare with.
const STAGING_DOC = path.join(ROOT, "docs/ops/staging.md");
describe.skipIf(!existsSync(STAGING_DOC))("docs/ops/staging.md", () => {
  const doc = existsSync(STAGING_DOC) ? readFileSync(STAGING_DOC, "utf8") : "";

  it("carries the settings tables generated from the manifest, unedited", () => {
    const regenerated = replaceGeneratedBlock(doc, renderEnvDocs(ENV_MANIFEST));
    expect(regenerated, "markers missing").not.toBeNull();
    // On failure: node --experimental-strip-types apps/web/scripts/check-env-manifest.mjs --write-docs
    expect(regenerated).toBe(doc);
  });

  it("mentions every deployed setting exactly in the generated block", () => {
    const block = doc.slice(doc.indexOf(DOCS_BEGIN), doc.indexOf(DOCS_END));
    for (const entry of ENV_MANIFEST.filter((e) => e.scope === "web" || e.scope === "build")) {
      expect(block, entry.name).toContain(`\`${entry.name}\``);
    }
  });
});

describe("the env scan itself", () => {
  function scanSource(files: Record<string, string>) {
    const root = mkdtempSync(path.join(os.tmpdir(), "fx-envscan-"));
    mkdirSync(path.join(root, "packages", "x", "src"), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, "packages", "x", "src", name), text);
    return Object.keys(files).flatMap((name) => scanFile(path.join(root, "packages", "x", "src", name), root));
  }

  it("finds direct, destructured, bracket, optional and template reads, and ignores comments", () => {
    const reads = scanSource({
      "a.ts": [
        "// process.env.IN_A_COMMENT",
        "const a = process.env.DIRECT_ONE;",
        "const b = deps.env.NESTED_TWO;",
        "const { DESTRUCTURED_THREE } = process" + ".env;", // split so the repo-wide runner-login scan does not read this fixture as code
        'const c = env["BRACKET_FOUR"];',
        "const d = env?.OPTIONAL_FIVE;",
        "const e = env[`TEMPLATE_V${n}`];",
        'const s = "NOT_AN_ENV_READ";',
      ].join("\n"),
    });
    expect(reads.map((r) => `${r.name}${r.prefix ? "*" : ""}:${r.how}`).sort()).toEqual([
      "BRACKET_FOUR:direct",
      "DESTRUCTURED_THREE:direct",
      "DIRECT_ONE:direct",
      "NESTED_TWO:direct",
      "OPTIONAL_FIVE:direct",
      "TEMPLATE_V*:direct",
    ]);
  });

  it("counts every env-shaped literal in a file that reads env through a variable", () => {
    const reads = scanSource({
      "b.ts": 'const NAMES = ["FIRST_VAR", "SECOND_VAR"]; export const f = (env: any, k: string) => env[k];',
      "c.ts": 'const NAMES = ["NEVER_READ_VAR"]; export const g = (env: any) => env.PLAIN;',
    });
    expect(reads.filter((r) => r.how === "dynamic").map((r) => r.name).sort()).toEqual(["FIRST_VAR", "SECOND_VAR"]);
    expect(reads.filter((r) => r.name === "NEVER_READ_VAR")).toEqual([]);
  });

  const summarize = (reads: ReturnType<typeof scanSource>) => reads.map((r) => `${r.name}${r.prefix ? "*" : ""}:${r.how}`).sort();

  it("follows an alias of process.env, a destructure of it, and bracket reads through it", () => {
    const reads = scanSource({
      "alias.ts": [
        "const cfg = process.env;",
        "const a = cfg.ALIAS_ONE;",
        "const { ALIAS_TWO, ALIAS_RENAMED: renamed } = cfg;",
        'const c = cfg["ALIAS_THREE"];',
        "const d = cfg[`ALIAS_V${n}`];",
        "const again = cfg;", // an alias of an alias
        "const e = again.ALIAS_FOUR;",
        "let late; late = process.env; late.ALIAS_FIVE;",
        "const guarded = overrides ?? process.env; guarded.ALIAS_SIX;",
        "const picked = flag ? process.env : {}; picked.ALIAS_SEVEN;",
        "const viaBracket = process['env']; viaBracket.ALIAS_EIGHT;",
        "const asType = process.env as Record<string, string>; asType.ALIAS_NINE;",
        "const copy = { ...process" + ".env }; copy.ALIAS_TEN;",
        "({ ALIAS_ELEVEN } = cfg);",
      ].join("\n"),
    });
    expect(summarize(reads)).toEqual([
      "ALIAS_ELEVEN:direct",
      "ALIAS_FIVE:direct",
      "ALIAS_FOUR:direct",
      "ALIAS_NINE:direct",
      "ALIAS_ONE:direct",
      "ALIAS_RENAMED:direct",
      "ALIAS_SEVEN:direct",
      "ALIAS_SIX:direct",
      "ALIAS_TEN:direct",
      "ALIAS_THREE:direct",
      "ALIAS_TWO:direct",
      "ALIAS_V*:direct",
      "ALIAS_EIGHT:direct",
    ].sort());
  });

  it("follows parameters, variables and properties typed as an environment map", () => {
    const reads = scanSource({
      "typed.ts": [
        "export function a(e: NodeJS.ProcessEnv) { return e.TYPED_ONE; }",
        "export function b(source: EnvLike) { return source.TYPED_TWO; }",
        "export function c(source: Readonly<ProcessEnv> | undefined) { return source?.TYPED_THREE; }",
        "export function d({ TYPED_FOUR }: ProcessEnv) { return TYPED_FOUR; }",
        "export function f(source = process.env) { return source.TYPED_FIVE; }",
        "export function g(source: typeof process.env) { return source.TYPED_SIX; }",
        "export function h(source: CursorEnv) { return source['TYPED_SEVEN']; }",
        "const held: ProcessEnv = load(); held.TYPED_EIGHT;",
        "class K { private readonly settings: EnvLike = {}; read() { return this.settings.TYPED_NINE; } }",
        "interface Deps { cfg: ProcessEnv }",
        "export const i = (deps: Deps) => deps.cfg.TYPED_TEN;",
      ].join("\n"),
    });
    expect(summarize(reads)).toEqual([
      "TYPED_EIGHT:direct",
      "TYPED_FIVE:direct",
      "TYPED_FOUR:direct",
      "TYPED_NINE:direct",
      "TYPED_ONE:direct",
      "TYPED_SEVEN:direct",
      "TYPED_SIX:direct",
      "TYPED_TEN:direct",
      "TYPED_THREE:direct",
      "TYPED_TWO:direct",
    ]);
  });

  it("flags a read through an alias with a variable key as dynamic, and counts the file's env-shaped literals", () => {
    const noCandidate = scanSource({ "d0.ts": "const cfg = process.env; export const f = (k: string) => cfg[k];" });
    expect(summarize(noCandidate)).toEqual([`${DYNAMIC_KEY}:dynamic`]); // nothing to check, so it is named and must be allow-listed
    const viaAlias = scanSource({ "d1.ts": 'const cfg = process.env; const NAMES = ["DYN_ALIAS_ONE"]; export const f = (k: string) => cfg[k];' });
    expect(summarize(viaAlias)).toEqual(["DYN_ALIAS_ONE:dynamic"]);
    const viaTypedParam = scanSource({ "d2.ts": 'const NAMES = ["DYN_TYPED_TWO"]; export const f = (e: EnvLike, k: string) => e[k];' });
    expect(summarize(viaTypedParam)).toEqual(["DYN_TYPED_TWO:dynamic"]);
    const viaComputedDestructure = scanSource({ "d3.ts": 'const cfg = process.env; const NAMES = ["DYN_COMPUTED_THREE"]; export const f = (k: string) => { const { [k]: v } = cfg; return v; };' });
    expect(summarize(viaComputedDestructure)).toEqual(["DYN_COMPUTED_THREE:dynamic"]);
    const viaRest = scanSource({ "d4.ts": 'const cfg = process.env; const NAMES = ["DYN_REST_FOUR"]; export const { KEEP_ME, ...others } = cfg;' });
    expect(summarize(viaRest)).toEqual(["DYN_REST_FOUR:dynamic", "KEEP_ME:direct"]);
    const viaTemplateOnly = scanSource({ "d5.ts": "const cfg = process.env; export const f = (n: number) => cfg[`TPL_V${n}`];" });
    expect(summarize(viaTemplateOnly)).toEqual(["TPL_V*:direct"]);
  });

  it("does not mistake an unrelated object for the environment", () => {
    const reads = scanSource({
      "plain.ts": [
        "const settings = { PLAIN_ONE: 1 };",
        "const value = settings.PLAIN_ONE;",
        "export function f(options: Options) { return options.PLAIN_TWO; }",
        "const cfg = loadConfig(); cfg.PLAIN_THREE;",
        "const { PLAIN_FOUR } = settings;",
      ].join("\n"),
    });
    expect(reads).toEqual([]);
  });

  it("skips test files and test directories", () => {
    const files = scanEnvReads(ROOT).map((r) => r.file);
    expect(files.filter((f) => /\.test\.|\.spec\.|\/test\/|\/tests\/|node_modules|\.next\//.test(f))).toEqual([]);
  });
});
