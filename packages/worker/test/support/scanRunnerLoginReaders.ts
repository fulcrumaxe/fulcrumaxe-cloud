import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The CARRY-8 scan. The runner-login variable's name is built here, not written,
 * so this file (and every test that uses it) never names it in source.
 */
export const RUNNER_LOGIN_NAME = ["FX", "RUNNER", "LOGIN", "URL"].join("_");

const NAME_RE = new RegExp(`(?<![A-Za-z0-9_])${RUNNER_LOGIN_NAME}(?![A-Za-z0-9_])`);
/**
 * Only these names are skipped, at any depth. Build output is excluded because
 * git does not track it (see `listFiles`), never by directory name: a route
 * called `build` or `dist` is source and is scanned.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", ".claude"]);
const SCANNED = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|json|sql|sh)$/;
/** The one file allowed to name the variable, and the package whose own files may import it. */
export const ONLY_READER = path.join("packages", "worker", "src", "pools.ts");
const OWN_TEST_DIR = path.join("packages", "worker", "test") + path.sep;
const WORKER_DIR = path.join("packages", "worker") + path.sep;


/** Joins adjacent string literals ("a" + "b") and literal-array joins (["a","b"].join("_")) until stable. */
function fold(source: string): string {
  const concat = new RegExp(String.raw`(['"\`])([^'"\`\\\n]*)\1\s*\+\s*(['"\`])([^'"\`\\\n]*)\3`, "g");
  const join = new RegExp(
    String.raw`\[\s*((?:(['"\`])[^'"\`\\\n]*\2\s*,?\s*)+)\]\s*\.join\(\s*(['"\`])([^'"\`\\\n]*)\3\s*\)`,
    "g",
  );
  let text = source;
  for (let i = 0; i < 20; i++) {
    const next = text
      .replace(concat, (_m, _q1, a, _q2, b) => `"${a}${b}"`)
      .replace(join, (_m, items: string, _q, _q2, sep: string) => {
        const parts = [...items.matchAll(/(['"`])([^'"`\\\n]*)\1/g)].map((m) => m[2]);
        return `"${parts.join(sep)}"`;
      });
    if (next === text) break;
    text = next;
  }
  return text;
}

/** True when a bracket expression made only of literals and constants (`a + B + "c"`) evaluates to the name. */
function bracketResolvesToName(source: string): boolean {
  const consts = new Map<string, string>();
  for (const m of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(['"`])([^'"`\\\n]*)\2/g)) consts.set(m[1]!, m[3]!);
  for (const m of source.matchAll(/\[([^\[\]\n]+)\]/g)) {
    let value = "";
    let ok = true;
    for (const token of m[1]!.split("+").map((t) => t.trim())) {
      const lit = /^(['"`])([^'"`\\\n]*)\1$/.exec(token);
      if (lit) value += lit[2];
      else if (consts.has(token)) value += consts.get(token);
      else ok = false;
    }
    if (ok && NAME_RE.test(value)) return true;
  }
  return false;
}

/** Why `source` reads the variable, or names a way to, outside the one allowed file; undefined when clean. */
export function violationIn(source: string, insideWorkerPackage: boolean, underApps = true): string | undefined {
  if (NAME_RE.test(source)) return "names the variable";
  if (NAME_RE.test(fold(source))) return "builds the variable's name from literals";
  if (bracketResolvesToName(source)) return "indexes with a key that resolves to the name";
  // Enumeration is checked on the apps (the request path); tests and benches elsewhere enumerate freely.
  if (underApps && /Object\.(keys|entries|values|assign)\(\s*process\.env|\.\.\.\s*process\.env/.test(source)) return "enumerates process.env";
  if (underApps && /\{[^}]*(\[|\.\.\.)[^}]*\}\s*=\s*process\.env/.test(source)) return "destructures process.env with a computed key or rest";
  const folded = fold(source);
  if (!insideWorkerPackage && /(?:from|import|require)\s*\(?\s*['"`][^'"`]*worker\/src\//.test(folded)) {
    return "imports a worker internal module";
  }
  if (!insideWorkerPackage && /export\s+(?:\*|\{[^}]*\})\s+from\s*['"`][^'"`]*worker\/src\//.test(folded)) {
    return "re-exports a worker internal module";
  }
  return undefined;
}

/**
 * THREAT MODEL. This guard catches ACCIDENTAL reads of the runner-login variable by application
 * code, and keeps the allowlist narrow. Deliberate obfuscation by an author is a code-review
 * matter, not something a source scan can settle. Known limits, out of scope here:
 * constructor.constructor("return process")(), a child process running printenv, and reading
 * /proc/self/environ; a spawn or exec with no `env` option, which inherits the whole parent
 * environment (the wrapper's own `vercel whoami` and `vercel link` do exactly this, by design);
 * and any further deliberate-obfuscation form. The allowlist exists so that provisioning can NAME the variable (it writes
 * the name to Vercel); it is not a licence to read it.
 *
 * The only files besides pools.ts that may spell the name, and only to PROVISION it:
 * they write the variable's name to Vercel and never read its value. Exactly these
 * paths; a copy anywhere else is still a violation. Each is still checked below
 * (provisionerViolation) for every other way of reading or reaching the variable.
 */
export const PROVISIONERS: readonly string[] = [
  path.join("packages", "db", "test", "staging-role-creds.test.ts"),
  path.join("scripts", "ops", "staging-role-creds.mjs"),
];

/**
 * Names only, never reads. The web app's settings manifest lists every variable by name so /api/health
 * and the build gate can check it. An exact path. The file must pass namesOnlyViolations (a structural
 * allow-list over its syntax tree: it can hold data and types, and nothing that runs), and it still goes
 * through provisionerViolation, so it may spell the name only inside a quoted literal. The same
 * structural check runs in apps/web/test/env-manifest.test.ts.
 */
export const NAMES_ONLY: readonly string[] = [path.join("apps", "web", "env-manifest.ts")];

/**
 * A STRUCTURAL ALLOW-LIST for a file that may only name variables. Returns why `text` is not such a
 * file; an empty list means it is. Nothing is banned by word. A file passes only if every top-level
 * statement is one of:
 *  - a type-only import (`import type ...`) or type-only export (`export type { ... }`);
 *  - a type alias or interface;
 *  - `export const NAME = <literal>`, where the literal is built from object and array literals,
 *    string (and no-substitution template), number, boolean and null literals, `as` / `satisfies`
 *    (the type operand is free), parentheses, and references to other top-level consts of the file,
 *    with plain `.name` access on those references.
 * Everything else is refused by kind: calls, `new`, tagged templates, template substitutions, element
 * access, `this`, functions, classes, enums, operators, spreads, computed keys, getters, methods and any
 * other statement. Without a call or a computed key there is no route to `process`, however the
 * strings are spelled, so a bypass like `(() => {}).constructor("return process")()` fails on its
 * first node, not on a word. (`.constructor`, `.prototype` and `__proto__` are refused anyway.)
 */
export function namesOnlyViolations(text: string): string[] {
  const source = ts.createSourceFile("names-only.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found = new Set<string>();
  const kindName = (node: ts.Node): string => ts.SyntaxKind[node.kind] ?? String(node.kind);
  const parseErrors = (source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (parseErrors && parseErrors.length > 0) found.add("does not parse");

  const consts = new Set<string>();
  for (const stmt of source.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) if (ts.isIdentifier(decl.name)) consts.add(decl.name.text);
    }
  }

  const FORBIDDEN_MEMBERS = new Set(["constructor", "prototype", "__proto__"]);

  const literal = (node: ts.Expression): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    ) {
      return;
    }
    if (ts.isIdentifier(node)) {
      if (!consts.has(node.text)) found.add(`value refers to ${node.text}, which is not a const of this file`);
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      literal(node.expression);
    } else if (ts.isPrefixUnaryExpression(node)) {
      if (!(node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand))) found.add(`expression not allowed: ${kindName(node)}`);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) literal(el);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const key = prop.name;
          if (!(ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key))) found.add(`object key not allowed: ${kindName(key)}`);
          else if (key.text === "__proto__") found.add("object key not allowed: __proto__");
          literal(prop.initializer);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          if (!consts.has(prop.name.text) || prop.objectAssignmentInitializer) found.add(`value refers to ${prop.name.text}, which is not a const of this file`);
        } else {
          found.add(`object member not allowed: ${kindName(prop)}`);
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      let base: ts.Expression = node;
      while (ts.isPropertyAccessExpression(base)) {
        if (!ts.isIdentifier(base.name) || FORBIDDEN_MEMBERS.has(base.name.text)) found.add(`member access not allowed: .${base.name.getText(source)}`);
        base = base.expression;
      }
      if (!ts.isIdentifier(base) || !consts.has(base.text)) found.add("member access on something other than a const of this file");
    } else {
      found.add(`expression not allowed: ${kindName(node)}`);
    }
  };

  const modifiersAreOnlyExport = (node: ts.Node): boolean => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).every((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!stmt.importClause?.isTypeOnly) found.add("runtime import");
    } else if (ts.isExportDeclaration(stmt)) {
      if (!stmt.isTypeOnly) found.add("runtime export");
    } else if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      if (!modifiersAreOnlyExport(stmt)) found.add(`modifier not allowed on ${kindName(stmt)}`);
    } else if (ts.isVariableStatement(stmt)) {
      const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) ?? [] : [];
      if (mods.length !== 1 || mods[0]!.kind !== ts.SyntaxKind.ExportKeyword) found.add("a const must be written `export const`");
      if ((stmt.declarationList.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) found.add("only const is allowed");
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) found.add("a const name must be a plain identifier");
        if (!decl.initializer) found.add("a const needs a literal value");
        else literal(decl.initializer);
      }
    } else {
      found.add(`statement not allowed: ${kindName(stmt)}`);
    }
  }
  return [...found].sort();
}

/** The string a literal's source text denotes: \n-style, \xHH, \uHHHH, \u{H}, line continuations and identity escapes (\X is X). */
function decodeEscapes(text: string): string {
  return text.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g, (_m, brace, u4, x2, cont, other) => {
    if (brace) return String.fromCodePoint(parseInt(brace, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    if (cont) return "";
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
    return simple[other as string] ?? (other as string);
  });
}

/** Returns code with comments dropped and each literal replaced by "§n" (its text goes in `literals`). Template `${}` bodies count as code. */
function tokenize(source: string, literals: string[]): string {
  let code = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === "#" && i === 0 && source[1] === "!") {
      while (i < n && source[i] !== "\n") i++;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let text = "";
      let inner = "";
      i++;
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") {
          text += source[i]! + (source[i + 1] ?? "");
          i += 2;
        } else if (c === "`" && source[i] === "$" && source[i + 1] === "{") {
          let depth = 1;
          let j = i + 2;
          while (j < n && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            j++;
          }
          inner += ` ${tokenize(source.slice(i + 2, j - 1), literals)} `;
          text += source.slice(i, j);
          i = j;
        } else {
          text += source[i];
          i++;
        }
      }
      i++;
      literals.push(decodeEscapes(text));
      code += `"§${literals.length - 1}"${inner}`;
    } else {
      code += c;
      i++;
    }
  }
  return code;
}

/** True when the function that `createRequire(...)` returns is later called with anything but one string literal directly followed by `)`. */
function calledWithComputedArgument(code: string, fn: string): boolean {
  for (const m of code.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) break;
    }
    if (!/^\s*\(\s*"§\d+"\s*\)/.test(code.slice(i + 1))) return true;
  }
  return false;
}

/**
 * Why a provisioner file reads the variable or reaches the worker, or undefined when it only names it.
 * The name may appear only inside a quoted literal. Any use of the environment object must be
 * `process.env.IDENT` or `process.env["literal"]`, with a key that is not the runner-login name:
 * computed keys, destructuring, aliasing, Reflect/Object/JSON on it, iteration, and reaching
 * `process` through another route are all refused. Imports of worker internals are refused too.
 */
export function provisionerViolation(source: string): string | undefined {
  const rest = source;
  const literals: string[] = [];
  const code = tokenize(rest, literals);

  if (code.includes(RUNNER_LOGIN_NAME)) return "names the variable outside a quoted literal";
  if (code.includes("\\")) return "has an escape sequence outside a quoted literal (it can spell an identifier)";
  if (literals.some((l) => l === "process" || l === "node:process")) return "imports or requires the process module";
  // import() and require() take exactly one string literal, directly followed by `)`.
  for (const m of code.matchAll(/\b(?:import|require)\s*\(/g)) {
    if (!/^\s*"§\d+"\s*\)/.test(code.slice(m.index + m[0].length))) return "imports or requires a module by a computed specifier";
  }
  if (calledWithComputedArgument(code, "createRequire")) return "calls a require function with a computed specifier";
  if (/\b(?:globalThis|global|eval|Function)\b/.test(code)) return "reaches process or code through globalThis, global, eval or Function";

  // process["env"] is process.env; any other computed process key could be one.
  let norm = code.replace(/\bprocess\s*(?:\?\.)?\s*\[\s*"§(\d+)"\s*\]/g, (m, i: string) => (literals[Number(i)] === "env" ? "process.env" : m));
  norm = norm.replace(/\bprocess\s*\?\.\s*env\b/g, "process.env");
  if (/\bprocess\s*\[/.test(norm)) return "indexes process with a computed key";
  if (/(?<![.\w$])process\b(?!\s*\.\s*(?:env|argv|exitCode)\b)/.test(norm)) return "uses process as a value";

  const envUse = /\bprocess\s*\.\s*env\b/g;
  for (let m = envUse.exec(norm); m; m = envUse.exec(norm)) {
    const after = norm.slice(m.index + m[0].length);
    if (/^\s*\??\.\s*[A-Za-z_$][\w$]*/.test(after)) continue;
    const lit = /^\s*\??\.?\s*\[\s*"§(\d+)"\s*\]/.exec(after);
    if (lit) {
      if (literals[Number(lit[1])]!.includes(RUNNER_LOGIN_NAME)) return "reads the variable by a literal key";
      continue;
    }
    return "uses the environment as a value or with a computed key";
  }

  // An environment-named parameter or alias indexed or dotted into.
  if (/(?<![.\w$])env\s*\??\.?\s*(?:\.|\[)/.test(norm)) return "accesses an object named env";
  return violationIn(rest.split(RUNNER_LOGIN_NAME).join("MASKED_NAME"), false, true);
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * The files to scan under `top`: what git tracks plus what it does not ignore,
 * so untracked build output (dist, .next, coverage) is out because git says so.
 * A root that is not a git checkout (a fixture) is walked instead, skipping only
 * SKIP_DIRS.
 */
function listFiles(root: string, top: string): string[] {
  let listed: string[];
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", top], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    listed = out.split("\0").filter(Boolean).map((f) => path.join(root, f));
  } catch {
    try {
      listed = walk(path.join(root, top), []);
    } catch {
      return [];
    }
  }
  // Judged on the path below `root`: a checkout that itself sits under a skipped directory
  // (a `.claude/worktrees/...` worktree) must still be scanned.
  return listed.filter((f) => SCANNED.test(f) && !path.relative(root, f).split(path.sep).some((seg) => SKIP_DIRS.has(seg)));
}

/** Where the scan looks. `scripts` is included so the allowlisted ops script is scanned like the rest, not only checked by hand. */
export const SCANNED_TOPS = ["apps", "packages", "sites", "scripts"] as const;

/** How many files the scan reads under `root`; a floor on this keeps a scan that finds no files from passing. */
export function countScannedFiles(root: string): number {
  return SCANNED_TOPS.reduce((n, top) => n + listFiles(root, top).length, 0);
}

/** Every file under apps, packages, sites and scripts of `root` (except the one allowed reader) that reads or can reach the variable. */
export function scanRunnerLoginReaders(root: string): string[] {
  const found: string[] = [];
  for (const top of SCANNED_TOPS) {
    const files = listFiles(root, top);
    for (const file of files) {
      const rel = path.relative(root, file);
      if (rel === ONLY_READER) continue;
      // This test's own directory holds the fixtures' source text.
      if (rel.startsWith(OWN_TEST_DIR)) continue;
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue; // listed by git but deleted in the working tree
      }
      if (PROVISIONERS.includes(rel) || NAMES_ONLY.includes(rel)) {
        const shape = NAMES_ONLY.includes(rel) ? namesOnlyViolations(source) : [];
        const bad = shape.length > 0 ? `is not names-only (${shape.join("; ")})` : provisionerViolation(source);
        if (bad) found.push(`${rel}: ${bad}`);
        continue;
      }
      const why = violationIn(source, rel.startsWith(WORKER_DIR), top === "apps");
      if (why) found.push(`${rel}: ${why}`);
    }
  }
  return found.sort();
}

