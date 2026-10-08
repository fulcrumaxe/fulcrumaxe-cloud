import { builtinModules } from "node:module";
import ts from "typescript";

/**
 * The one definition of "reads the process environment as a whole, or could". Every guard test and every fixture for it
 * calls `envAccessViolations`, so the rules cannot be retyped somewhere else and drift.
 *
 * The text is parsed with the TypeScript compiler, so regex literals, strings, templates and comments are tokenised by
 * the real lexer, and identifier and string values are read from `.text`, which is already unescaped. In `src`:
 *  - every `process` identifier is a violation, unless the file is `src/job/cleanEnv.ts` and the identifier is the
 *    object of a non-optional `.env` access that is itself read as `.NAME` or `[identifier]`, also non-optional;
 *  - the identifiers `globalThis` and `global` are violations;
 *  - any string or template text naming the `process` module, or containing the path `/proc/`, is a violation;
 *  - any `constructor` identifier or string is a violation (the Function constructor is reachable through it), as are
 *    the `Function` identifier and any `eval` that is not a direct call;
 *  - node built-in modules are an allowlist, per file (`ALLOWED_BUILTINS`): a built-in named by an import, a
 *    re-export, `import()` or an import type, with or without the `node:` prefix, must be listed for that file. `require`
 *    and an `import()` with a non-literal argument are violations;
 *  - `spawn` may be called only in the files that may import `node:child_process`, and there every call must pass an
 *    object with an `env` property and without `shell: true`; the `exec`, `execSync`, `execFile`, `execFileSync`,
 *    `fork` and `spawnSync` names are refused;
 *  - the same bans run once more on the raw text for `globalThis`/`global`, the process module and `/proc/`.
 */
export const ENV_READER_FILE = "src/job/cleanEnv.ts";

/**
 * The one other file that may name `process`: it signals the agent's process group, which only `process.kill` can do.
 * There `process` is allowed as the object of a non-optional `.kill` or `.platform` access and nowhere else, so it
 * still cannot read the environment.
 */
export const PROCESS_GROUP_FILE = "src/engines/claude/processGroup.ts";

function isGroupSignalUse(node: ts.Identifier): boolean {
  const access = node.parent;
  return ts.isPropertyAccessExpression(access) && access.expression === node && !access.questionDotToken && (access.name.text === "kill" || access.name.text === "platform");
}

const ENGINE_FILES = ["src/engines/claude/capture.ts", "src/engines/claude/engine.ts"];

/**
 * Built-in modules each file may name, keyed by path relative to the package, without the `node:` prefix. Everything
 * not listed is refused, including `vm`, `module`, `worker_threads` and `process`. Add a line only with a reviewed
 * reason; each entry below is read off the engine slice's imports.
 */
export const ALLOWED_BUILTINS: Readonly<Record<string, readonly string[]>> = {
  "src/engines/claude/capture.ts": ["child_process"],
  "src/engines/claude/engine.ts": ["child_process", "path"],
  "src/engines/claude/pin.ts": ["fs", "path"],
  "src/engines/claude/session.ts": ["crypto", "fs", "path"], // crypto: random temp-file names for the index write
  "src/engines/claude/processGroup.ts": [],
  "src/engines/claude/settingsFile.ts": ["fs", "path"],
  "src/engines/claude/stream.ts": ["fs", "path"],
};

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]));
const BANNED_EXEC_NAMES = new Set(["exec", "execSync", "execFile", "execFileSync", "fork", "spawnSync"]);

function isNamedLookup(node: ts.Identifier): boolean {
  const env = node.parent;
  if (!ts.isPropertyAccessExpression(env) || env.expression !== node || env.questionDotToken || env.name.text !== "env") return false;
  const read = env.parent;
  if (ts.isPropertyAccessExpression(read)) return read.expression === env && !read.questionDotToken;
  if (ts.isElementAccessExpression(read)) {
    return read.expression === env && !read.questionDotToken && ts.isIdentifier(read.argumentExpression);
  }
  return false;
}

function isTextToken(node: ts.Node): node is ts.StringLiteralLike | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail {
  return ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
}

/** The module specifier a node loads, if the node is a loader form; `null` for the specifier of a non-literal one. */
function loadedSpecifier(node: ts.Node): { spec: ts.Expression | undefined } | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) return { spec: node.moduleSpecifier };
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return { spec: node.moduleReference.expression };
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return { spec: node.argument.literal as ts.Expression };
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return { spec: node.arguments[0] };
  return undefined;
}

const SPAWN_NAME = /^spawn/i;
const SPAWN_SEAM_FILE = "src/engines/claude/engine.ts";
const CHILD_PROCESS_NAMES = new Set(["spawn", "ChildProcess"]);
const BANNED_STRINGS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

function isChildProcessSpec(spec: string): boolean {
  return spec.replace(/^node:/, "") === "child_process";
}

/** `const spawnFn = <expr> ?? spawn;` in the engine file: the one place the real `spawn` may be named as a value. */
function isSeamDefault(node: ts.Node, file: string): node is ts.BinaryExpression {
  return (
    file === SPAWN_SEAM_FILE &&
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    ts.isIdentifier(node.right) &&
    node.right.text === "spawn" &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node &&
    ts.isIdentifier(node.parent.name) &&
    node.parent.name.text === "spawnFn"
  );
}

/** `SpawnFn` or `typeof spawn`: a value of this type must be named spawn..., or the name checks below cannot see its calls. */
function isSpawnType(type: ts.TypeNode): boolean {
  return (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "SpawnFn") || (ts.isTypeQueryNode(type) && ts.isIdentifier(type.exprName) && type.exprName.text === "spawn");
}

/** True when a spawn-like name is used in a way the narrow allowances do not cover (alias, value, .call, Reflect.apply, ...). */
function spawnValueProblem(node: ts.Identifier, file: string): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent)) return false;
  if ((ts.isPropertySignature(parent) || ts.isParameter(parent) || ts.isTypeAliasDeclaration(parent)) && parent.name === node) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  if (ts.isPropertyAssignment(parent)) {
    if (parent.name === node) return false;
    return !(ts.isIdentifier(parent.name) && parent.name.text === "spawn" && node.text === "spawnFn");
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return !(node.text === "spawnFn" && parent.initializer !== undefined && isSeamDefault(parent.initializer, file));
  }
  if (ts.isBinaryExpression(parent) && parent.right === node && isSeamDefault(parent, file)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return false;
    const seamLeft = ts.isBinaryExpression(parent.parent) && parent.parent.left === parent && isSeamDefault(parent.parent, file);
    const runCaptureArg =
      ts.isCallExpression(parent.parent) &&
      parent.parent.arguments[0] === parent &&
      ts.isIdentifier(parent.parent.expression) &&
      parent.parent.expression.text === "runCapture";
    return !(seamLeft || runCaptureArg);
  }
  return true;
}

/** The loading forms of `node:child_process`: only an unaliased named import of `spawn` (and the `ChildProcess` type). */
function childProcessLoadProblem(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return true;
    return clause.namedBindings.elements.some((el) => el.propertyName !== undefined || !CHILD_PROCESS_NAMES.has(el.name.text));
  }
  return true;
}

function envValueOk(prop: ts.ObjectLiteralElementLike): boolean {
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text !== "undefined" && !prop.objectAssignmentInitializer;
  if (!ts.isPropertyAssignment(prop)) return false;
  const value = prop.initializer;
  if (ts.isIdentifier(value)) return value.text !== "undefined";
  return ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "cleanEnv";
}

/** True when a spawn call is not `spawn(command, argv, { env: <identifier or cleanEnv(...)>, shell: false, ... })`. */
function spawnCallProblem(call: ts.CallExpression): boolean {
  if (call.arguments.length !== 3) return true;
  const options = call.arguments[2]!;
  if (!ts.isObjectLiteralExpression(options)) return true;
  const seen = new Map<string, number>();
  for (const prop of options.properties) {
    if (ts.isSpreadAssignment(prop) || !prop.name || !(ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))) return true;
    const name = prop.name.text;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (name === "env" && !envValueOk(prop)) return true;
    if (name === "shell" && !(ts.isPropertyAssignment(prop) && prop.initializer.kind === ts.SyntaxKind.FalseKeyword)) return true;
  }
  return seen.get("env") !== 1 || (seen.get("shell") ?? 0) > 1;
}

/** Every rule the text breaks, by name. Empty means the text reads the environment only by name, and only where that is allowed. */
export function envAccessViolations(text: string, file: string = ENV_READER_FILE): string[] {
  const found = new Set<string>();
  const allowed = new Set(ALLOWED_BUILTINS[file] ?? []);
  const mayUseChildProcess = ENGINE_FILES.includes(file) && allowed.has("child_process");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (name === "process") {
        if (file === PROCESS_GROUP_FILE) {
          if (!isGroupSignalUse(node)) found.add("process used other than as process.kill or process.platform");
        } else if (file !== ENV_READER_FILE) found.add("process outside the environment reader");
        else if (!isNamedLookup(node)) found.add("process used other than as process.env.NAME or process.env[name]");
      } else if (name === "globalThis" || name === "global") {
        found.add("globalThis or global");
      } else if (name === "constructor") {
        found.add("constructor member");
      } else if (name === "require") {
        found.add("require");
      } else if (name === "Function" && !ts.isTypeReferenceNode(node.parent)) {
        found.add("Function constructor");
      } else if (name === "eval") {
        if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) found.add("eval without a direct call");
      } else if (SPAWN_NAME.test(name) && name !== "spawnSync" && spawnValueProblem(node, file)) {
        found.add("spawn used other than as a direct, checked call");
      } else if (BANNED_EXEC_NAMES.has(name)) {
        const isMember = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
        if (mayUseChildProcess || !isMember) found.add("exec, fork or synchronous spawn");
      }
    }
    if ((ts.isParameter(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.type && isSpawnType(node.type)) {
      if (!SPAWN_NAME.test(node.name.getText(source))) found.add("a spawn-typed name that does not start with spawn");
    }
    if (isTextToken(node)) {
      if (/^(?:node:)?process$/.test(node.text)) found.add("import of the process module");
      if (node.text.includes("/proc/")) found.add("/proc/ path");
      if (node.text === "constructor") found.add("constructor member");
      if (BANNED_STRINGS.has(node.text)) found.add("child process function named by a string");
      if (/environ(?!ment)/i.test(node.text) || node.text.split(/[\\/]/).includes("proc")) found.add("proc path segment or environ file");
    }
    const load = loadedSpecifier(node);
    if (load) {
      const spec = load.spec;
      if (!spec || !(ts.isStringLiteralLike(spec))) {
        found.add("module load with a non-literal specifier");
      } else {
        const bare = spec.text.replace(/^node:/, "");
        if (isChildProcessSpec(spec.text) && childProcessLoadProblem(node)) found.add("child_process loaded other than as an unaliased named import");
        if ((spec.text.startsWith("node:") || BUILTINS.has(bare)) && !allowed.has(bare)) found.add("node built-in module not allowed here");
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (/^spawn/i.test(callee) && callee !== "spawnSync") {
        if (!mayUseChildProcess) found.add("spawn outside the engine files");
        else if (spawnCallProblem(node)) found.add("spawn without an env option, or with a shell");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (/["'`](?:node:)?process["'`]/.test(text)) found.add("import of the process module");
  if (/\b(?:globalThis|global)\b/.test(text)) found.add("globalThis or global");
  if (/\/proc\//.test(text)) found.add("/proc/ path");
  return [...found];
}
