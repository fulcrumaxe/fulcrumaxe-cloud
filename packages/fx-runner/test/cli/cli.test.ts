import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";

async function run(argv: string[], home: string | null = "/nonexistent-home"): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli({ argv, home: home ?? undefined, stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

describe("command line", () => {
  it("prints usage for --help (exit 0) and for no command (exit 2)", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("register --code");
    expect((await run([])).code).toBe(2);
  });

  it("refuses an unknown command, an unknown or repeated option, a stray argument, and a missing value, all with exit 2", async () => {
    for (const argv of [["frobnicate"], ["constructor"], ["status", "--verbose"], ["status", "extra"], ["revoke", "--reason"], ["revoke", "--local=yes"], ["revoke", "--local", "--local"], ["register", "--code"]]) {
      const result = await run(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.out).toBe("");
    }
  });

  it("accepts --name=value as well as --name value", async () => {
    const result = await run(["revoke", "--reason=x", "--local"], "/nonexistent-home");
    expect(result.code).not.toBe(2);
  });

  it("without a usable home directory it says so rather than writing into the current directory", async () => {
    const result = await run(["status"], null);
    expect(result.code).toBe(1);
    expect(result.err).toContain("home directory");
  });

  it("keeps the registration code out of argv-derived error text", async () => {
    const result = await run(["register", "--code", "fxrr_secretsecretsecretsecretsecretsecret", "--credential-mode", "nope", "--cloud-url", "https://example.com"]);
    expect(result.code).toBe(2);
    expect(result.err).not.toContain("secretsecret");
  });
});

describe("bin/fx-runner.mjs", () => {
  const text = readFileSync(path.join(PACKAGE_DIR, "bin", "fx-runner.mjs"), "utf8");

  it("reads the environment only by name, never as a whole", () => {
    const reads = [...text.matchAll(/process\.env(\.\w+|\[[^\]]*\]|[^\w.[])/g)].map((m) => m[1]);
    expect(reads).toEqual([".ANTHROPIC_API_KEY", ".ANTHROPIC_AUTH_TOKEN", ".HOME", ".FX_RUNNER_HOME", ".HOME", ".XDG_CACHE_HOME", ".HOME", ".XDG_CACHE_HOME", ".HOME", ".XDG_CONFIG_HOME", ".PATH"]);
    expect(text).not.toMatch(/\.\.\.\s*process|Object\.\w+\(\s*process\.env|globalThis|\bglobal\b/);
  });
});
