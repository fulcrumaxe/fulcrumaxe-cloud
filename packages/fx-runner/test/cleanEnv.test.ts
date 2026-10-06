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
    expect(FIXED_ENV).toEqual({ DISABLE_UPDATES: "1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
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
    ["escaped identifier", "const e = \\u0070rocess.env.HOME;"],
    ["string with // ahead of the code", 'const u = "http://x"; Object.keys(process?.env);'],
    ["inside a template substitution", "const s = `${Object.keys(process.env)}`;"],
    ["inside a nested template", "const s = `a${`b${process.env}`}`;"],
    ["Function constructor", 'const f = Function("return pro" + "cess")();'],
    ["new Function", 'const f = new Function("return 1");'],
    ["indirect eval", '(0, eval)("1");'],
    ["eval alias", "const e = eval;"],
    ["proc environ", 'readFileSync("/proc/self/environ");'],
  ];

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
    expect(env).toMatchObject({ HOME: "/home/someone", PATH: "/usr/bin", DISABLE_UPDATES: "1", [SUBSCRIPTION_TOKEN_VAR]: "host-oauth-value" });
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
    expect(env.DISABLE_UPDATES).toBe("1");
  });

  it("refuses an empty key and an unknown mode", () => {
    expect(() => cleanEnv({ mode: "api_key", apiKey: "" })).toThrow(TypeError);
    expect(() => cleanEnv({ mode: "other" } as never)).toThrow(TypeError);
  });
});
