import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FX_AGENT_SETTINGS, PROPOSAL_VERIFIER_ROLE, VERIFIER_DENY, VERIFIER_GUARD_MAX_INPUT, VERIFIER_READ_GUARD, VERIFIER_READ_GUARD_SCRIPT, VERIFIER_WORKDIR, agentSettingsFor, toolsForRole } from "../src/agentConfig.js";

/**
 * D#483 S4-b2a, read confinement (acceptance): the claim verifier's settings and its read guard. The guard is run here exactly as the CLI runs it,
 * through `/bin/sh -c <script> fx-read-guard <checkout>` with the hook's JSON on stdin, so what is asserted is the real script's exit code (2 = the
 * tool call is refused). The checkout is a temporary directory standing in for the sandbox's, holding real symlinks that point out of it. Every case
 * runs under each shell found here (`/bin/sh`, bash, dash; the sandbox's /bin/sh is bash) and must give the same code under all of them.
 * What this cannot show: that the CLI honours the hook and the rules. That is the CLI's documented contract (PreToolUse exit 2 blocks the call;
 * deny rules win over allow rules); no model call is made in tests.
 */
let W = "";
let base = "";
const hookInput = (tool: string, input: Record<string, unknown>): string =>
  JSON.stringify({ session_id: "s", transcript_path: "/root/.claude/projects/x/s.jsonl", cwd: W, permission_mode: "dontAsk", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "toolu_01" });

const shells = ["/bin/sh", ...["bash", "dash"].map((s) => spawnSync("sh", ["-c", `command -v ${s}`], { encoding: "utf8" }).stdout.trim()).filter((s) => s !== "")];
function run(shell: string, stdin: string, workdir = W): { status: number | null; ms: number } {
  const t0 = Date.now();
  const r = spawnSync(shell, ["-c", VERIFIER_READ_GUARD_SCRIPT, "fx-read-guard", workdir], { input: stdin, timeout: 10_000, cwd: base });
  return { status: r.status, ms: Date.now() - t0 };
}
/** The exit code, which must be the same under every shell. */
function guard(stdin: string): number | null {
  const codes = shells.map((sh) => run(sh, stdin).status);
  expect(new Set(codes).size, `same code under ${shells.join(", ")}: ${codes.join(", ")}`).toBe(1);
  return codes[0]!;
}

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), "fx-guard-"));
  W = path.join(base, "sandbox", "repo");
  mkdirSync(path.join(W, "src"), { recursive: true });
  mkdirSync(path.join(W, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(W, "src", "a.ts"), "export {};\n");
  writeFileSync(path.join(W, ".gitignore"), "x\n");
  writeFileSync(path.join(W, ".github", "workflows", "ci.yml"), "on: push\n");
  // Links a repository could commit, pointing outside the tree. The clone writes them as plain files (repoClone.test.ts); here they are real links.
  symlinkSync("../../etc/passwd", path.join(W, "up"));
  symlinkSync("/proc/self/environ", path.join(W, "leak"));
  symlinkSync("/etc", path.join(W, "etcdir"));
  symlinkSync("/proc/self", path.join(W, "src", "inner"));
  symlinkSync("src", path.join(W, "insrc"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("the proposal verifier's read confinement", () => {
  it("allows only Read under the checkout, Glob and Grep; no Bash, LS, edit, write or network tool", () => {
    const s = agentSettingsFor(PROPOSAL_VERIFIER_ROLE) as { permissions: { allow: string[]; deny: string[]; defaultMode: string }; hooks: Record<string, unknown> };
    expect(s.permissions.defaultMode).toBe("dontAsk");
    expect(s.permissions.allow).toEqual([`Read(//vercel/sandbox/repo/**)`, "Glob", "Grep"]);
    expect([...toolsForRole(PROPOSAL_VERIFIER_ROLE)]).toEqual(s.permissions.allow);
    expect(s.permissions.allow.some((t) => /^(Bash|LS|Edit|MultiEdit|Write|NotebookEdit|WebFetch|WebSearch)\b/.test(t) || t === "Read")).toBe(false);
    // The runner's own limit hook stays, and the guard is added before every Read, Glob and Grep.
    expect(s.hooks).toEqual({ PostToolUse: FX_AGENT_SETTINGS.hooks.PostToolUse, PreToolUse: [VERIFIER_READ_GUARD] });
    expect(VERIFIER_READ_GUARD.matcher).toBe("Read|Glob|Grep");
    // The settings' command, word for word: /bin/sh -c '<script>' fx-read-guard <checkout>.
    expect(VERIFIER_READ_GUARD.hooks[0]!.command).toBe(`/bin/sh -c '${VERIFIER_READ_GUARD_SCRIPT}' fx-read-guard ${VERIFIER_WORKDIR}`);
    expect(shells.length).toBeGreaterThan(1);
  });

  it("denies .git, .env files and the places outside the tree, even where an allow would match", () => {
    const deny = (agentSettingsFor(PROPOSAL_VERIFIER_ROLE) as { permissions: { deny: string[] } }).permissions.deny;
    for (const r of ["Read(//vercel/sandbox/repo/.git/**)", "Read(//vercel/sandbox/repo/**/.git/**)", "Read(//vercel/sandbox/repo/**/.env*)", "Read(//proc/**)", "Read(//fx/**)", "Read(//etc/**)", "Read(~/**)"]) {
      expect(deny).toContain(r);
    }
    expect(deny.slice(0, VERIFIER_DENY.length)).toEqual([...VERIFIER_DENY]);
    // Other roles are unchanged: no guard, no extra deny.
    expect((agentSettingsFor("project-manager") as { hooks: Record<string, unknown> }).hooks).toEqual(FX_AGENT_SETTINGS.hooks);
  });

  it("the guard lets in-tree reads through", () => {
    expect(guard(hookInput("Read", { file_path: `${W}/src/a.ts` }))).toBe(0);
    expect(guard(hookInput("Read", { file_path: `${W}/src/new-file.ts` }))).toBe(0);
    expect(guard(hookInput("Read", { file_path: "src/a.ts", offset: 3, limit: 9 }))).toBe(0);
    expect(guard(hookInput("Glob", { pattern: "src/**/*.ts" }))).toBe(0);
    expect(guard(hookInput("Glob", { pattern: "**/*.md", path: W }))).toBe(0);
    expect(guard(hookInput("Glob", { pattern: `${W}/src/*.ts` }))).toBe(0);
    expect(guard(hookInput("Grep", { pattern: "x" }))).toBe(0);
    expect(guard(hookInput("Grep", { pattern: String.raw`\bTODO\b|"quoted"`, path: "src", glob: "*.ts", output_mode: "content" }))).toBe(0);
    expect(guard(hookInput("Read", { file_path: ".github/workflows/ci.yml" }))).toBe(0);
    expect(guard(hookInput("Read", { file_path: ".gitignore" }))).toBe(0);
  });

  it("the guard refuses anything outside the checkout, .git, env files, /proc and home", () => {
    const refused: Array<[string, Record<string, unknown>]> = [
      ["Read", { file_path: "/proc/self/environ" }],
      ["Read", { file_path: "/fx/agent-config/settings.json" }],
      ["Read", { file_path: "/vercel/sandbox/repository-other/a" }],
      ["Read", { file_path: `${W}/../../../etc/passwd` }],
      ["Read", { file_path: `${VERIFIER_WORKDIR}-other/a` }],
      ["Read", { file_path: "~/.claude/credentials.json" }],
      ["Read", { file_path: ".git/config" }],
      ["Read", { file_path: `${W}/.git/HEAD` }],
      ["Read", { file_path: "sub/.git/config" }],
      ["Read", { file_path: ".env" }],
      ["Read", { file_path: "app/.env.local" }],
      ["Read", { file_path: String.raw`../x` }],
      ["Glob", { pattern: "/proc/*/environ" }],
      ["Glob", { pattern: "../**" }],
      ["Glob", { pattern: "**/.env*" }],
      ["Glob", { pattern: "*", path: "/etc" }],
      ["Grep", { pattern: "KEY", path: "/proc/self" }],
      ["Grep", { pattern: "x", path: "." , glob: "**/.git/**" }],
      ["Grep", { pattern: "x", glob: ".env*" }],
      ["Grep", { pattern: "x", path: "../.." }],
      // Brace alternation could name an absolute root inside a relative-looking pattern.
      ["Glob", { pattern: "{/proc/self/environ,a}" }],
      ["Glob", { pattern: "{/etc/*,src/*}" }],
      ["Glob", { pattern: "src/{a,b}.ts" }],
      ["Glob", { pattern: "x,/etc/*" }],
    ];
    for (const [tool, input] of refused) expect(guard(hookInput(tool, input)), `${tool} ${JSON.stringify(input)}`).toBe(2);
  });

  it("the guard resolves real paths: a link out of the checkout is refused for Read, Glob and Grep, and so is a path that does not resolve", () => {
    const refused: Array<[string, Record<string, unknown>]> = [
      ["Read", { file_path: "up" }],
      ["Read", { file_path: `${W}/up` }],
      ["Read", { file_path: "leak" }],
      ["Read", { file_path: "etcdir/passwd" }],
      ["Read", { file_path: "src/inner/environ" }],
      ["Read", { file_path: "insrc" }],
      ["Read", { file_path: "no-such-dir/a.ts" }],
      ["Glob", { pattern: "*", path: "etcdir" }],
      ["Glob", { pattern: "etcdir/*" }],
      ["Glob", { pattern: "src/inner/*" }],
      ["Glob", { pattern: "leak" }],
      ["Glob", { pattern: "**/*", path: "src/inner" }],
      ["Grep", { pattern: "KEY", path: "leak" }],
      ["Grep", { pattern: "KEY", path: "up" }],
      ["Grep", { pattern: "root", path: "etcdir" }],
      ["Grep", { pattern: "KEY", path: "src/inner" }],
      ["Grep", { pattern: "KEY", path: `${W}/etcdir/` }],
    ];
    for (const [tool, input] of refused) expect(guard(hookInput(tool, input)), `${tool} ${JSON.stringify(input)}`).toBe(2);
    // A checkout that does not resolve, or none at all, refuses everything.
    for (const sh of shells) expect(run(sh, hookInput("Read", { file_path: "src/a.ts" }), path.join(base, "missing")).status, sh).toBe(2);
    for (const sh of shells) expect(run(sh, hookInput("Read", { file_path: "src/a.ts" }), "").status, sh).toBe(2);
  });

  it("the guard bounds its input before matching: just under the cap it finishes well inside the hook timeout under bash; over it, exit 2", () => {
    const bash = shells.find((s) => s.endsWith("/bash"));
    expect(bash, "bash is needed for this check").toBeDefined();
    const padded = (size: number, where: string): string => {
      const empty = hookInput("Grep", { pattern: "", path: where });
      return hookInput("Grep", { pattern: "x".repeat(size - empty.length), path: where });
    };
    const near = padded(VERIFIER_GUARD_MAX_INPUT, "src");
    expect(near.length).toBe(VERIFIER_GUARD_MAX_INPUT);
    const ok = run(bash!, near);
    expect(ok.status).toBe(0);
    expect(ok.ms).toBeLessThan(2000);
    // The same size with a path outside: refused, and as fast.
    const no = run(bash!, padded(VERIFIER_GUARD_MAX_INPUT, "/proc/self"));
    expect(no.status).toBe(2);
    expect(no.ms).toBeLessThan(2000);
    for (const sh of shells) {
      expect(run(sh, padded(VERIFIER_GUARD_MAX_INPUT + 1, "src")).status, sh).toBe(2);
      // 150 KB took 5.7 s under bash before the bound (past the 5 s timeout, which lets the call through); now it is refused at once.
      const big = run(sh, padded(150_000, "/proc/self"));
      expect(big.status, sh).toBe(2);
      expect(big.ms, sh).toBeLessThan(2000);
    }
    expect(VERIFIER_READ_GUARD_SCRIPT).toContain(`[ \${#j} -le ${VERIFIER_GUARD_MAX_INPUT} ] || exit 2`);
  });

  it("the guard fails closed on input it cannot read and on other tools", () => {
    expect(guard("")).toBe(2);
    expect(guard("not json")).toBe(2);
    expect(guard(hookInput("Bash", { command: "cat /proc/self/environ" }))).toBe(2);
    expect(guard(JSON.stringify({ tool_name: "Read", tool_input: { file_path: 5 } }))).toBe(2);
    // JSON whitespace the CLI never writes is refused rather than parsed loosely.
    expect(guard(`{"tool_name":"Read","tool_input":{"file_path": "/proc/self/environ"}}`)).toBe(2);
    expect(VERIFIER_READ_GUARD_SCRIPT).not.toContain("'");
  });
});
