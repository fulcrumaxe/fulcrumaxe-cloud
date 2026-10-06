import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Finds every environment variable the cloud source reads, by walking the
 * TypeScript AST of each non-test source file under apps/web and packages/*.
 * Used by env-manifest.test.ts; lives under test/ so the scan skips it.
 *
 * What counts as a read:
 *  - `process.env.NAME`, `<anything>.env.NAME`, `env.NAME` (and `?.`)
 *  - `...env["NAME"]` and a template with a fixed head (`env[`FX_X_V${n}`]`)
 *  - `const { NAME } = process.env` (or any `env`)
 *  - all of the above through an alias: `const cfg = process.env; cfg.X; const { Y } = cfg;
 *    cfg["Z"]`, a copy made by spreading the environment into an object literal, `process["env"]`, and a parameter, variable or
 *    property typed ProcessEnv / NodeJS.ProcessEnv / EnvLike / `*Env`
 *  - a read through a variable (`env[name]`, `cfg[k]`, `const { [k]: v } = cfg`, `const { ...rest } = cfg`): the file is "dynamic", and every
 *    env-shaped string literal in it counts as a possible name. A dynamic file
 *    that only hands names to a helper in another file is out of reach of this
 *    scan; the manifest-side check (every listed name is spelled somewhere in
 *    the source) is what bounds that gap.
 */

export interface EnvRead {
  /** A literal name, or the fixed head of a template such as `FX_CURSOR_KEY_V`. */
  name: string;
  /** True for the head of a template (`FX_CURSOR_KEY_V${version}`). */
  prefix: boolean;
  file: string;
  /** "direct" for a literal read; "dynamic" for a name found in a file that reads env through a variable. */
  how: "direct" | "dynamic";
}

/** The name given to a computed-key read in a file that spells no env-shaped name at all (see scanFile). */
export const DYNAMIC_KEY = "(computed key)";

const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const ENV_SHAPED_LITERAL = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "test", "tests", "__tests__", "fixtures", ".turbo", "coverage", ".vercel"]);
const SOURCE_FILE = /\.(?:ts|tsx|mjs|js|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[a-z]+$|\.d\.ts$/;

/**
 * Packages that are never deployed to Vercel, so the deploy manifest has no business listing what they read.
 * Each needs a reason. This is a list of exact package directories, never a pattern.
 */
export const NOT_DEPLOYED_PACKAGES: Readonly<Record<string, string>> = {
  "packages/fx-runner": "customer-machine runner, not a deployed app: it reads the host's own environment by name and is never built for or run on Vercel",
};

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const skipped = new Set(Object.keys(NOT_DEPLOYED_PACKAGES).map((dir) => path.join(root, dir)));
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !skipped.has(path.join(dir, entry.name))) walk(path.join(dir, entry.name));
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  for (const top of ["apps/web", "packages"]) walk(path.join(root, top));
  return out.sort();
}

/** A type that names an environment map: `ProcessEnv`, `NodeJS.ProcessEnv`, `EnvLike`, and the repo's `Env` / `*Env` aliases, also inside `Readonly<...>`, unions and `typeof process.env`. */
const ENV_TYPE_NAME = /^(?:ProcessEnv|EnvLike|Env|\w+Env)$/;

function typeNamesEnv(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isTypeReferenceNode(type)) {
    const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text;
    return ENV_TYPE_NAME.test(name) || (type.typeArguments?.some(typeNamesEnv) ?? false);
  }
  if (ts.isParenthesizedTypeNode(type)) return typeNamesEnv(type.type);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.some(typeNamesEnv);
  if (ts.isTypeQueryNode(type)) return (ts.isIdentifier(type.exprName) ? type.exprName.text : type.exprName.right.text) === "env";
  return false;
}

/**
 * Decides whether an expression IS an environment map, so a read hanging off it counts. That is
 * `process.env`, `process["env"]`, `env`, `<x>.env`, and anything the file binds to one of those:
 * `const cfg = process.env`, `cfg = process.env`, a copy made by spreading the environment into an object literal,
 * `const cfg = other ?? process.env`, a parameter or variable typed ProcessEnv / EnvLike / `*Env`, a
 * parameter defaulting to one, and a class or interface property of such a type. Bindings are found by
 * name over the whole file (scope-blind on purpose: a false alias only adds a name to check), repeated
 * until no new alias turns up so `const a = cfg; a.X` is followed.
 */
function envMatcher(source: ts.SourceFile): (node: ts.Expression) => boolean {
  const aliases = new Set<string>();
  const envProps = new Set<string>();
  const isEnv = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return node.text === "env" || aliases.has(node.text);
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "env" || envProps.has(node.name.text);
    if (ts.isElementAccessExpression(node)) return (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) && node.argumentExpression.text === "env";
    if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return isEnv(node.expression);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      return (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) && (isEnv(node.left) || isEnv(node.right));
    }
    if (ts.isConditionalExpression(node)) return isEnv(node.whenTrue) || isEnv(node.whenFalse);
    if (ts.isObjectLiteralExpression(node)) return node.properties.some((p) => ts.isSpreadAssignment(p) && isEnv(p.expression));
    return false;
  };
  for (let pass = 0; pass < 10; pass++) {
    const before = aliases.size + envProps.size;
    const find = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ((node.initializer && isEnv(node.initializer)) || typeNamesEnv(node.type))) aliases.add(node.name.text);
      else if (ts.isParameter(node) && ts.isIdentifier(node.name) && ((node.initializer && isEnv(node.initializer)) || typeNamesEnv(node.type))) aliases.add(node.name.text);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isEnv(node.right)) aliases.add(node.left.text);
      else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && ((node.initializer && isEnv(node.initializer)) || typeNamesEnv(node.type))) envProps.add(node.name.text);
      else if (ts.isPropertySignature(node) && ts.isIdentifier(node.name) && typeNamesEnv(node.type)) envProps.add(node.name.text);
      ts.forEachChild(node, find);
    };
    find(source);
    if (aliases.size + envProps.size === before) break;
  }
  return isEnv;
}

export function scanFile(file: string, root: string): EnvRead[] {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, kind);
  const rel = path.relative(root, file).split(path.sep).join("/");
  const reads: EnvRead[] = [];
  let dynamic = false;
  const literals = new Set<string>();
  const isEnvExpression = envMatcher(source);

  /** `const { A, "B": b, [k]: c, ...rest } = <env>`: literal keys are reads; a computed key or a rest is a dynamic read. */
  const bindingReads = (pattern: ts.ObjectBindingPattern): void => {
    for (const el of pattern.elements) {
      if (el.dotDotDotToken || (el.propertyName && ts.isComputedPropertyName(el.propertyName))) {
        dynamic = true;
        continue;
      }
      const key = el.propertyName ?? el.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && ENV_NAME.test(key.text)) reads.push({ name: key.text, prefix: false, file: rel, how: "direct" });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isEnvExpression(node.expression) && ENV_NAME.test(node.name.text)) {
      reads.push({ name: node.name.text, prefix: false, file: rel, how: "direct" });
    } else if (ts.isElementAccessExpression(node) && isEnvExpression(node.expression)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        reads.push({ name: arg.text, prefix: false, file: rel, how: "direct" });
      } else if (ts.isTemplateExpression(arg) && arg.head.text) {
        reads.push({ name: arg.head.text, prefix: true, file: rel, how: "direct" });
      } else {
        dynamic = true;
      }
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isEnvExpression(node.initializer)) {
      bindingReads(node.name);
    } else if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name) && (typeNamesEnv(node.type) || (node.initializer && isEnvExpression(node.initializer)))) {
      bindingReads(node.name);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left) && isEnvExpression(node.right)) {
      // ({ A, [k]: b } = env)
      for (const p of node.left.properties) {
        if (ts.isShorthandPropertyAssignment(p)) {
          if (ENV_NAME.test(p.name.text)) reads.push({ name: p.name.text, prefix: false, file: rel, how: "direct" });
        } else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          if (ENV_NAME.test(p.name.text)) reads.push({ name: p.name.text, prefix: false, file: rel, how: "direct" });
        } else {
          dynamic = true;
        }
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (ENV_SHAPED_LITERAL.test(node.text)) literals.add(node.text);
    } else if (ts.isTemplateExpression(node) && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+_?[A-Z]?$/.test(node.head.text)) {
      // a template with an env-shaped head, e.g. `FX_KEK_V${version}`; kept as a prefix
      literals.add(`${node.head.text}\u0000prefix`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (dynamic && literals.size === 0) {
    // A computed key and no name in the file to blame: say so, so the coverage test can fail it unless it is allow-listed with a reason.
    reads.push({ name: DYNAMIC_KEY, prefix: false, file: rel, how: "dynamic" });
  }
  if (dynamic) {
    for (const lit of literals) {
      if (lit.endsWith("\u0000prefix")) reads.push({ name: lit.slice(0, -"\u0000prefix".length), prefix: true, file: rel, how: "dynamic" });
      else reads.push({ name: lit, prefix: false, file: rel, how: "dynamic" });
    }
  }
  return reads;
}

export function scanEnvReads(root: string): EnvRead[] {
  return listSourceFiles(root).flatMap((file) => scanFile(file, root));
}

/**
 * Every string literal (and fixed template head, and `env.NAME`) anywhere in the scanned source except the
 * manifest itself, which spells every name it lists. The manifest's "is this name real" check.
 */
export function spelledNames(root: string): Set<string> {
  const out = new Set<string>();
  const manifest = path.join(root, "apps", "web", "env-manifest.ts");
  for (const file of listSourceFiles(root)) {
    if (file === manifest) continue;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
    const isEnvExpression = envMatcher(source);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.add(node.text);
      else if (ts.isTemplateExpression(node)) out.add(node.head.text);
      else if (ts.isPropertyAccessExpression(node) && isEnvExpression(node.expression)) out.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}
