import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXED_ENV, HOST_ENV_ALLOWLIST, SUBSCRIPTION_TOKEN_VAR, cleanEnv } from "../src/job/cleanEnv.js";
import { ENV_READER_FILE, envAccessViolations } from "./helpers/envGuard.js";
import { srcFiles } from "./helpers/srcFiles.js";

/** Names that must never reach the agent, set in the host environment by every test below. */
const STRAY = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY", "GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "FOO_SECRET", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR",
  "SSH_AUTH_SOCK", "AWS_SECRET_ACCESS_KEY",
] as const;

function stubHost(): void {
  for (const name of STRAY) vi.stubEnv(name, `host-${name.toLowerCase()}`);
  vi.stubEnv(SUBSCRIPTION_TOKEN_VAR, "host-oauth-value");
  vi.stubEnv("HOME", "/home/someone");
  vi.stubEnv("PATH", "/usr/bin");
}

beforeEach(stubHost);
afterEach(() => vi.unstubAllEnvs());

describe("cleanEnv allowlist", () => {
  it("is a constant list, deep-equal to the documented one", () => {
    expect([...HOST_ENV_ALLOWLIST]).toEqual(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"]);
    expect(FIXED_ENV).toEqual({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
    expect(Object.isFrozen(HOST_ENV_ALLOWLIST)).toBe(true);
  });

  it("src names `process` only in the environment reader, and only as process.env.NAME or process.env[name]", () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(4);
    for (const [name, text] of files) expect(envAccessViolations(text, name), name).toEqual([]);
    expect(files.some(([name, text]) => name === ENV_READER_FILE && text.includes("process.env["))).toBe(true);
  });

  // Every bypass from both security reviews, and the older forms. Each is judged as if it sat in the environment
  // reader itself, the one file where reading the environment by name is allowed.
  const BYPASSES: Array<[string, string]> = [
    ["spread", "const e = { ...process.env };"],
    ["key listing", "Object.keys(process.env);"],
    ["loop", "for (const k in process.env) {}"],
    ["alias", "const e = process.env;"],
    ["alias of process", "const p = process;"],
    ["destructure env", "const { env } = process;"],
    ["named import of env", 'import { env as hostEnv } from "node:process"; const e = { ...hostEnv };'],
    ["namespace import", 'import * as proc from "node:process"; Object.entries(proc.env);'],
    ["bare module name", 'import { env } from "process";'],
    ["dynamic import", 'const p = await import("node:process");'],
    ["template-literal import", "const p = await import(`node:process`);"],
    ["globalThis computed", 'const e = globalThis["process"]["env"];'],
    ["globalThis member", "const e = globalThis.process.env;"],
    ["global member", "const e = global.process.env;"],
    ["computed env", 'const e = process["env"];'],
    ["optional chain", "Object.keys(process?.env ?? {});"],
    ["line break before the dot", "Object.keys(process\n  .env);"],
    ["space before the dot", "Object.keys(process .env);"],
    ["comment before the dot", "Object.keys(process/**/.env);"],
    ["line comment before the dot", "Object.keys(process // x\n.env);"],
    ["optional chain on a lookup", "const v = process?.env.HOME;"],
    ["env passed on after a lookup form", "f(process.env.HOME, process.env);"],
    ["escaped identifier", "const e = Object.keys(\\u0070rocess.env);"],
    ["string with // ahead of the code", 'const u = "http://x"; Object.keys(process?.env);'],
    ["inside a template substitution", "const s = `${Object.keys(process.env)}`;"],
    ["inside a nested template", "const s = `a${`b${process.env}`}`;"],
    ["Function constructor", 'const f = Function("return pro" + "cess")();'],
    ["new Function", 'const f = new Function("return 1");'],
    ["indirect eval", '(0, eval)("1");'],
    ["eval alias", "const e = eval;"],
    ["proc environ", 'readFileSync("/proc/self/environ");'],
    ["regex with a quote", 'const QUOTE = /"/; Object.keys(process.env);'],
    ["regex with a backtick", "const TICK = /`/;\n({ ...process.env });"],
    ["regex with //", "const S = /https:\\/\\//; Object.keys(process.env);"],
    ["regex with /*", "const STAR = /[/*]/;\n({ ...process.env });"],
    ["constructor call", '(() => 0).constructor("return pro" + "cess")();'],
    ["constructor call by string key", '(() => 0)["constructor"]("return 1")();'],
    // Review round 2 (security): escaped names, escaped specifiers, uncalled constructor, built-in modules.
    ["globalThis with a built key", "const e = globalThis['pro' + 'cess']['env'];"],
    ["escaped globalThis", "const e = \\u0067lobalThis.x;"],
    ["escaped global", "const e = \\u0067lobal.x;"],
    ["escaped module specifier, static", "import { env } from 'node\\u003aprocess';"],
    ["escaped module specifier, dynamic", "const p = await import('node\\u003aprocess');"],
    ["escaped module specifier, re-export", "export { env } from 'node\\u003aprocess';"],
    ["plain module specifier, re-export", "export * from 'node:process';"],
    ["escaped proc path", "readFileSync('\\u002fproc\\u002fself/environ');"],
    ["proc path in a template", "readFileSync(`/proc/${pid}/environ`);"],
    ["constructor stored", "const F = (() => 0).constructor; F('return 1')();"],
    ["constructor new-ed", "new ((() => 0).constructor)('return 1');"],
    ["constructor via Reflect", "Reflect.construct(x.constructor, ['return 1']);"],
    ["constructor destructured", "const { constructor: F } = () => 0;"],
    ["constructor by string key, uncalled", "const F = (() => 0)['constructor'];"],
    ["node:vm", "import vm from 'node:vm'; vm.runInThisContext('1');"],
    ["bare vm", "import vm from 'vm'; vm.runInThisContext('1');"],
    ["node:module", "import { createRequire } from 'node:module'; createRequire(import.meta.url);"],
    ["node:worker_threads", "import { Worker } from 'node:worker_threads';"],
    ["child_process, bare name", "import { execSync } from 'child_process'; execSync('printenv');"],
    ["child_process, prefixed", "import { execSync } from 'node:child_process'; execSync('printenv');"],
    ["child_process type import", "import type { spawn } from 'node:child_process';"],
    ["import type of a built-in", "type T = import('node:child_process').ChildProcess;"],
    ["spawn with no env, outside the engine files", "import { spawn } from 'node:child_process'; spawn('ls', []);"],
    ["spawn with env, outside the engine files", "import { spawn } from 'node:child_process'; spawn('ls', [], { env, shell: false });"],
    ["fs in the reader", "import { readFileSync } from 'node:fs'; readFileSync('x');"],
    ["require", "const m = require('node:fs');"],
    ["dynamic import of a variable", "const m = await import(name);"],
  ];

  // The engine slice's shape: node:child_process only in capture.ts and engine.ts, every spawn with env and no shell.
  const CAPTURE = "src/engines/claude/capture.ts";
  const SPAWN_IMPORT = "import { spawn } from 'node:child_process';\n";
  const SPAWN_BAD: Array<[string, string]> = [
    ["no options", "spawn('x', []);"],
    ["options without env", "spawn('x', [], { shell: false });"],
    ["shell true", "spawn('x', [], { env, shell: true });"],
    ["shell not a literal false", "spawn('x', [], { env, shell: flag });"],
    ["spread options", "spawn('x', [], { ...opts });"],
    ["options in a variable", "spawn('x', [], opts);"],
    ["spawnSync", "spawnSync('x', [], { env });"],
    ["exec", "exec('x');"],
    ["execFile", "execFile('x');"],
    ["fork", "fork('x');"],
    ["execSync as a member", "cp.execSync('x');"],
    // Review round 3: aliasing the import, a no-op env, and a path built in pieces.
    ["env undefined", "spawn('x', [], { env: undefined, shell: false });"],
    ["env null", "spawn('x', [], { env: null, shell: false });"],
    ["env an object literal", "spawn('x', [], { env: {}, shell: false });"],
    ["env a method", "spawn('x', [], { env() { return {}; }, shell: false });"],
    ["duplicate env", "spawn('x', [], { env, env: undefined, shell: false });"],
    ["duplicate shell", "spawn('x', [], { env, shell: false, shell: false });"],
    ["options as the second argument", "spawn('x', { env, shell: false }, opts);"],
    ["a fourth argument", "spawn('x', [], { env, shell: false }, extra);"],
    ["spread arguments", "spawn(...args);"],
    ["aliased import", "import { spawn as run } from 'node:child_process'; run('x', [], { env, shell: false });"],
    ["alias by assignment", "const s = spawn; s('x', [], { env, shell: false });"],
    ["alias by assignment of the seam name", "const spawnFn = spawn;"],
    ["member by string key", "const s = cp['spawn'];"],
    ["spawn.call", "spawn.call(null, 'x', [], { env, shell: false });"],
    ["spawn.apply", "spawn.apply(null, ['x']);"],
    ["Reflect.apply", "Reflect.apply(spawn, null, ['x']);"],
    ["passed as a value", "run(spawn);"],
    ["shorthand property value", "run({ spawn });"],
    ["renamed re-export", "export { spawn as run } from 'node:child_process';"],
    ["local re-export", "export { spawn };"],
    ["namespace import", "import * as cp from 'node:child_process'; cp.spawn('x', [], { env, shell: false });"],
    ["default import", "import cp from 'node:child_process'; cp.spawn('x', [], { env, shell: false });"],
    ["import equals", "import cp = require('node:child_process');"],
    ["dynamic import", "const cp = await import('node:child_process');"],
    ["import type of the module", "type T = typeof import('node:child_process').spawn;"],
    ["another named import", "import { spawnSync } from 'node:child_process';"],
    ["seam default in the wrong shape", "const other = config.spawn ?? spawn;"],
    ["seam default with a different operator", "const spawnFn = config.spawn || spawn;"],
    ["property read, not passed to runCapture", "const s = opts.spawn;"],
    ["proc as a path segment", "const p = path.join('/proc', 'self', 'environ');"],
    ["proc segment alone", "const p = path.join('proc', 'self');"],
    ["environ alone", "const f = 'environ';"],
  ];

  it.each(SPAWN_BAD.slice(11))("the guard flags a spawn bypass in the engine file: %s", (_name, call) => {
    expect(envAccessViolations(SPAWN_IMPORT + call, "src/engines/claude/engine.ts"), call).not.toEqual([]);
  });

  it("the guard allows the injection seam in the engine file, and only there and only in that shape", () => {
    const engine = "src/engines/claude/engine.ts";
    const seam =
      "import { spawn, type ChildProcess } from 'node:child_process';\n" +
      "const spawnFn = config.spawn ?? spawn;\n" +
      "const child = spawnFn(binary.path, argv, { cwd: workdir, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });\n" +
      "await authPresent(mode, { binaryPath: p, env, spawn: spawnFn });\n";
    expect(envAccessViolations(seam, engine)).toEqual([]);
    expect(envAccessViolations(seam.replace("env, shell", "env: cleanEnv(x), shell"), engine)).toEqual([]);
    expect(envAccessViolations(seam, "src/engines/claude/capture.ts")).not.toEqual([]);
    expect(envAccessViolations("const c = spawnFn(cmd, args, { env, shell: false });\nexport type SpawnFn = typeof spawn;\nimport type { spawn } from 'node:child_process';", "src/engines/claude/capture.ts")).toEqual([]);
    expect(envAccessViolations("const r = await runCapture(opts.spawn, opts.p, ['--version'], env, 5);", "src/engines/claude/pin.ts")).toEqual([]);
    expect(envAccessViolations("opts.spawn('x', [], { env, shell: false });", "src/engines/claude/pin.ts")).not.toEqual([]);
    expect(envAccessViolations("const s = opts.spawn;", "src/engines/claude/pin.ts")).not.toEqual([]);
  });

  it("the guard requires a spawn-prefixed name for anything typed SpawnFn or typeof spawn", () => {
    const capture = "src/engines/claude/capture.ts";
    const head = "import type { spawn } from 'node:child_process';\nexport type SpawnFn = typeof spawn;\n";
    expect(envAccessViolations(head + "export function a(spawnFn: SpawnFn, o: { spawn: SpawnFn }) {}", capture)).toEqual([]);
    expect(envAccessViolations(head + "export function a(run: SpawnFn) {}", capture)).toEqual(["a spawn-typed name that does not start with spawn"]);
    expect(envAccessViolations(head + "export function a(o: { launch: typeof spawn }) {}", capture)).toEqual(["a spawn-typed name that does not start with spawn"]);
    expect(envAccessViolations(head + "let go: SpawnFn;", capture)).toEqual(["a spawn-typed name that does not start with spawn"]);
  });

  it.each(SPAWN_BAD)("the guard flags a spawn problem in the engine files: %s", (_name, call) => {
    expect(envAccessViolations(SPAWN_IMPORT + call, CAPTURE), call).not.toEqual([]);
  });

  it("the guard allows an engine-shaped spawn with env, and the fs and path imports each file needs", () => {
    expect(envAccessViolations(SPAWN_IMPORT + "const child = spawn('x', [], { cwd, env, shell: false, stdio: ['ignore'] });", CAPTURE)).toEqual([]);
    expect(envAccessViolations("const c = spawnFn(cmd, [...args], { env, shell: false });\nimport type { spawn } from 'node:child_process';", CAPTURE)).toEqual([]);
    expect(envAccessViolations("import path from 'node:path'; import { spawn } from 'node:child_process';", "src/engines/claude/engine.ts")).toEqual([]);
    expect(envAccessViolations("import { readFileSync } from 'node:fs'; import path from 'node:path';", "src/engines/claude/pin.ts")).toEqual([]);
    // The same calls anywhere else fail, and so does a built-in a file was not given.
    expect(envAccessViolations(SPAWN_IMPORT + "spawn('x', [], { env, shell: false });", "src/engines/claude/pin.ts")).not.toEqual([]);
    expect(envAccessViolations("import { readFileSync } from 'node:fs';", "src/engines/claude/capture.ts")).not.toEqual([]);
    expect(envAccessViolations("import { readFileSync } from 'node:fs';", "src/job/prompt.ts")).not.toEqual([]);
    expect(envAccessViolations("import vm from 'node:vm';", "src/engines/claude/engine.ts")).not.toEqual([]);
  });

  it.each(BYPASSES)("the guard flags a bypass: %s", (_name, sample) => {
    expect(envAccessViolations(sample), sample).not.toEqual([]);
  });

  it("the guard allows the named lookups in the reader, and flags the same lookups anywhere else", () => {
    for (const good of ["const a = process.env.HOME;", "const a = process.env[name];", "const a = process.env[SUBSCRIPTION_TOKEN_VAR];", "// process .env is only a word here\nconst a = 1;", 'const s = "process env";']) {
      expect(envAccessViolations(good, ENV_READER_FILE), good).toEqual([]);
    }
    expect(envAccessViolations("const a = process.env.HOME;", "src/job/prompt.ts")).not.toEqual([]);
    expect(envAccessViolations("const a = process.env[name];", "src/index.ts")).not.toEqual([]);
  });
});

describe("tool subprocesses do not inherit the credential", () => {
  it("pins the subprocess scrub in the fixed set, and it is on in both modes", () => {
    expect(FIXED_ENV.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(cleanEnv({ mode: "subscription" }).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(cleanEnv({ mode: "api_key", apiKey: "config-api-key-value" }).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  });

  it("a shell value for the switch cannot turn it off", () => {
    vi.stubEnv("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "0");
    expect(cleanEnv({ mode: "subscription" }).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  });
});

describe("cleanEnv in subscription mode", () => {
  it("holds only allowlisted names, the fixed set and the subscription token", () => {
    const env = cleanEnv({ mode: "subscription" });
    const allowed = new Set<string>([...HOST_ENV_ALLOWLIST, ...Object.keys(FIXED_ENV), SUBSCRIPTION_TOKEN_VAR]);
    expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
    for (const name of STRAY) expect(env, name).not.toHaveProperty(name);
    expect(env).toMatchObject({ HOME: "/home/someone", PATH: "/usr/bin", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", [SUBSCRIPTION_TOKEN_VAR]: "host-oauth-value" });
  });

  it("copies nothing else a shell could hold, and returns a fresh object each time", () => {
    vi.stubEnv("SOME_NEW_VARIABLE", "x");
    const first = cleanEnv({ mode: "subscription" });
    expect(first).not.toHaveProperty("SOME_NEW_VARIABLE");
    first.PATH = "changed";
    expect(cleanEnv({ mode: "subscription" }).PATH).toBe("/usr/bin");
  });

  it("omits the subscription token when the shell has none", () => {
    vi.stubEnv(SUBSCRIPTION_TOKEN_VAR, "");
    expect(cleanEnv({ mode: "subscription" })).not.toHaveProperty(SUBSCRIPTION_TOKEN_VAR);
  });
});

describe("cleanEnv in API-key mode", () => {
  it("holds only the key from local config: not the shell's key and not the subscription token", () => {
    const env = cleanEnv({ mode: "api_key", apiKey: "config-api-key-value" });
    expect(env.ANTHROPIC_API_KEY).toBe("config-api-key-value");
    expect(env).not.toHaveProperty(SUBSCRIPTION_TOKEN_VAR);
    for (const name of STRAY.filter((n) => n !== "ANTHROPIC_API_KEY")) expect(env, name).not.toHaveProperty(name);
    expect(Object.values(env)).not.toContain("host-anthropic_api_key");
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(env).not.toHaveProperty("DISABLE_UPDATES");
  });

  it("refuses an empty key and an unknown mode", () => {
    expect(() => cleanEnv({ mode: "api_key", apiKey: "" })).toThrow(TypeError);
    expect(() => cleanEnv({ mode: "other" } as never)).toThrow(TypeError);
  });
});
