import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyBundle } from "../../src/daemon/vmBundle.js";
import { GUARD_CONFIG, createGit, type GitCapture } from "../../src/daemon/git.js";
import { hostGit, hostGitWrite, readWorkspaceGit, runWorkspaceGit } from "../../src/daemon/hostRead.js";
import { unpinWorkspace } from "../../src/daemon/workspacePin.js";
import { fixtureRepo, git, GIT_ENV, hostDeps, hostWorkspace, scratchDir } from "../vm/workspace/helpers.js";

/**
 * The write verbs of the host-read helper (`fetch`, `reset`, `update-ref`, the bundle apply's). The helper exists so that no workspace git call can drop its fixed
 * protections: a caller's per-call config cannot override them, `fetch` cannot be told to run a program, a write call cannot ride on `readWorkspaceGit`, and the
 * pin, shape and environment checks apply to every call, with or without options.
 */
const refusal = async (promise: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof promise === "function" ? promise() : promise);
    return "ran";
  } catch (error) {
    return (error as { code?: string }).code ?? `OTHER:${(error as Error).message}`;
  }
};

/** A workspace, and a hook directory whose `reference-transaction` hook writes a marker file when git runs it. */
function hostile() {
  const fx = fixtureRepo();
  const ws = hostWorkspace(fx.mirror, fx.commit);
  const hooks = scratchDir("fxh-hooks-");
  const marker = path.join(hooks, "RAN");
  writeFileSync(path.join(hooks, "reference-transaction"), `#!/bin/sh\necho ran >> ${marker}\n`);
  chmodSync(path.join(hooks, "reference-transaction"), 0o755);
  return { fx, ws, hooks, marker, deps: hostDeps() };
}

/** A git runner that records each command's environment (its config entries, in order) and timeout, then really runs it. */
function recording(workspaceEnv: Record<string, string> = {}) {
  const seen: Array<{ args: string[]; env: Record<string, string>; timeoutMs: number }> = [];
  const capture: GitCapture = async (command, args, env, timeoutMs) => {
    seen.push({ args: [...args], env, timeoutMs });
    try {
      const stdout = execFileSync(command, [...args], { env: { ...GIT_ENV(), ...workspaceEnv, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, stdout, timedOut: false };
    } catch (error) {
      return { code: (error as { status?: number }).status ?? 1, stdout: "", timedOut: false };
    }
  };
  const entries = (env: Record<string, string>): Array<[string, string]> => Array.from({ length: Number(env["GIT_CONFIG_COUNT"] ?? 0) }, (_v, i) => [env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!]);
  return { git: createGit({ capture }), seen, entries };
}

describe("a caller's per-call config cannot override the protective config", () => {
  it.each([["core.hooksPath"], ["core.fsmonitor"], ["protocol.allow"], ["protocol.ext.allow"], ["core.attributesFile"], ["submodule.recurse"], ["Core.HooksPath"], ["pack.threads2"], ["core.sshCommand"]])("%s in the option is refused and no hook runs", async (key) => {
    const { ws, hooks, marker, fx, deps } = hostile();
    const code = await refusal(runWorkspaceGit(deps.git, "workspace_failed", ws, hostGitWrite("update-ref", "refs/fx/probe", fx.commit), { config: [[key, key.toLowerCase().includes("hooks") ? hooks : "always"]] }));
    expect(code).toBe("workspace_git_refused");
    expect(existsSync(marker)).toBe(false);
    expect(git(ws, "for-each-ref", "refs/fx")).toBe("");
  });

  it("control: with the one allowed key the call runs, and no hook runs", async () => {
    const { ws, fx, marker, deps } = hostile();
    await runWorkspaceGit(deps.git, "workspace_failed", ws, hostGitWrite("update-ref", "refs/fx/a", fx.commit), { config: [["pack.threads", "1"]] });
    expect(git(ws, "rev-parse", "refs/fx/a")).toBe(fx.commit);
    expect(existsSync(marker)).toBe(false);
  });

  it("with an option passed, the protective entries are all still applied and come last", async () => {
    const { ws, fx } = hostile();
    const rec = recording();
    await runWorkspaceGit(rec.git, "workspace_failed", ws, hostGitWrite("update-ref", "refs/fx/probe", fx.commit), { config: [["pack.threads", "1"]], timeoutMs: 5_000 });
    const run = rec.seen.at(-1)!;
    const entries = rec.entries(run.env);
    const effective = new Map(entries);
    for (const [key, value] of GUARD_CONFIG) expect(effective.get(key), key).toBe(value);
    expect(effective.get("core.attributesFile")).toBe("/dev/null");
    expect(effective.get("submodule.recurse")).toBe("false");
    expect(effective.get("diff.ignoreSubmodules")).toBe("all");
    expect(effective.get("status.submoduleSummary")).toBe("false");
    expect(effective.get("pack.threads")).toBe("1");
    // Nothing a caller set sits after a protective entry.
    const lastPack = entries.map(([k]) => k).lastIndexOf("pack.threads");
    const firstProtective = entries.findIndex(([k], i) => i > lastPack && (k === "core.hooksPath" || k === "core.attributesFile"));
    expect(firstProtective).toBeGreaterThan(lastPack);
    expect(entries.at(-1)![0]).not.toBe("pack.threads");
  });
});

describe("the checks apply to a call that passes options", () => {
  it("an unpinned workspace is refused with options too, before git touches it", async () => {
    const { ws, fx, deps } = hostile();
    unpinWorkspace(ws);
    const code = await refusal(runWorkspaceGit(deps.git, "workspace_failed", ws, hostGitWrite("update-ref", "refs/fx/probe", fx.commit), { config: [["pack.threads", "1"]], timeoutMs: 5_000 }));
    expect(code).toBe("workspace_git_refused");
    expect(git(ws, "for-each-ref", "refs/fx")).toBe("");
  });

  it("the timeout option is the limit the command runs under", async () => {
    const { ws } = hostile();
    const rec = recording();
    await runWorkspaceGit(rec.git, "workspace_failed", ws, hostGit("rev-parse", "HEAD"), { timeoutMs: 1_234 });
    expect(rec.seen.at(-1)!.args).toContain("rev-parse");
    expect(rec.seen.at(-1)!.timeoutMs).toBe(1_234);
    await runWorkspaceGit(rec.git, "workspace_failed", ws, hostGit("rev-parse", "HEAD"));
    expect(rec.seen.at(-1)!.timeoutMs).toBeGreaterThan(1_234);
  });

  it("the user's global git config is not read: a global url rewrite that breaks the mirror path has no effect", async () => {
    const { ws, fx } = hostile();
    const global = path.join(scratchDir("fxh-global-"), "gitconfig");
    writeFileSync(global, `[url "/nonexistent-prefix"]\n\tinsteadOf = ${fx.mirror}\n`);
    // Control: plain git with that global config cannot fetch the mirror.
    expect(() => execFileSync("git", ["-C", ws, "fetch", "-q", "--no-tags", fx.mirror, "+HEAD:refs/fx/ctl"], { env: { ...GIT_ENV(), GIT_CONFIG_GLOBAL: global }, stdio: "ignore" })).toThrow();
    const deps = hostDeps({ GIT_CONFIG_GLOBAL: global });
    await runWorkspaceGit(deps.git, "workspace_failed", ws, hostGitWrite("fetch", "--no-tags", fx.mirror, "+HEAD:refs/fx/probe"));
    expect(git(ws, "rev-parse", "refs/fx/probe")).toBe(fx.commit);
  });

  it("a reset walks the worktree for nested gitfiles: one that points outside refuses it", async () => {
    const { ws, deps } = hostile();
    mkdirSync(path.join(ws, "sub"));
    writeFileSync(path.join(ws, "sub", ".git"), "gitdir: /somewhere/else\n");
    const head = git(ws, "rev-parse", "HEAD");
    const code = await refusal(runWorkspaceGit(deps.git, "workspace_failed", ws, hostGitWrite("reset", "-q", "--hard", "HEAD")));
    expect(code).toBe("workspace_git_refused");
    expect(git(ws, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("the fetch verb cannot run a program or reach a URL", () => {
  const sourceOf = (fx: { mirror: string }): string => fx.mirror;
  const forms = (up: string, mirror: string): Array<[string, string[]]> => [
    ["--upload-pack=<cmd>", [`--upload-pack=sh -c 'touch ${up}; exec git-upload-pack "$@"' --`, mirror, "HEAD"]],
    ["--upload-pack <cmd>", ["--upload-pack", `sh -c 'touch ${up}; exec git-upload-pack "$@"' --`, mirror, "HEAD"]],
    ["-u <cmd>", ["-u", `sh -c 'touch ${up}; exec git-upload-pack "$@"' --`, mirror, "HEAD"]],
    ["-u<cmd>", [`-ush -c 'touch ${up}; exec git-upload-pack "$@"' --`, mirror, "HEAD"]],
    ["--exec=<cmd>", [`--exec=sh -c 'touch ${up}; exec git-upload-pack "$@"' --`, mirror, "HEAD"]],
    ["--exec <cmd>", ["--exec", `sh -c 'touch ${up}; exec git-upload-pack "$@"' --`, mirror, "HEAD"]],
    ["an abbreviated --upload-p=<cmd>", [`--upload-p=sh -c 'touch ${up}; exec git-upload-pack "$@"' --`, mirror, "HEAD"]],
    ["an abbreviated --exe=<cmd>", [`--exe=sh -c 'touch ${up}; exec git-upload-pack "$@"' --`, mirror, "HEAD"]],
  ];

  it("each program-running form is refused when the arguments are built, and the command never runs", async () => {
    const { fx, hooks } = hostile();
    const up = path.join(hooks, "UP");
    for (const [name, args] of forms(up, sourceOf(fx))) {
      expect(await refusal(() => hostGitWrite("fetch", ...args)), name).toBe("workspace_git_refused");
      expect(existsSync(up), name).toBe(false);
    }
  });

  it.each([["an https URL", "https://example.test/repo.git"], ["an ssh URL", "ssh://example.test/repo.git"], ["a file URL", "file:///tmp/x"], ["an ext:: transport", "ext::sh -c 'touch /tmp/never'"], ["an fd:: transport", "fd::3"], ["a remote name", "origin"], ["a relative path", "../mirror.git"], ["an scp-style source", "user@host:repo.git"], ["a source that is missing", ""]])("%s as the source is refused", async (_name, source) => {
    const args = source === "" ? ["--no-tags"] : ["--no-tags", source, "HEAD"];
    expect(await refusal(() => hostGitWrite("fetch", ...args))).toBe("workspace_git_refused");
  });

  it("a refspec or a flag the helper does not know is refused too", async () => {
    const { fx } = hostile();
    expect(await refusal(() => hostGitWrite("fetch", "--depth=1", fx.mirror, "HEAD"))).toBe("workspace_git_refused");
    expect(await refusal(() => hostGitWrite("fetch", "--recurse-submodules", fx.mirror, "HEAD"))).toBe("workspace_git_refused");
  });

  it("control: the apply's own fetch (an absolute local path and a refspec) runs", async () => {
    const { ws, fx, deps } = hostile();
    await runWorkspaceGit(deps.git, "workspace_failed", ws, hostGitWrite("fetch", "--no-tags", "--no-recurse-submodules", fx.mirror, "+HEAD:refs/fx/in"), { config: [["pack.threads", "1"]], timeoutMs: 30_000 });
    expect(git(ws, "rev-parse", "refs/fx/in")).toBe(fx.commit);
  });
});

describe("the write verbs stay out of the read path", () => {
  it("readWorkspaceGit refuses write arguments even when the type is bypassed, and starts nothing", async () => {
    const { ws, fx } = hostile();
    const started: string[][] = [];
    const capture: GitCapture = async (_c, args) => {
      started.push([...args]);
      return { code: 0, stdout: "", timedOut: false };
    };
    const write = hostGitWrite("update-ref", "refs/fx/probe", fx.commit);
    // @ts-expect-error a write argument is not a read argument
    const code = await refusal(readWorkspaceGit(capture, {} as never, ws, write, 1_000));
    expect(code).toBe("workspace_git_refused");
    expect(started).toEqual([]);
  });
});

describe("a bundle is refused on an unpinned workspace before anything is written", () => {
  it("HEAD, the refs and .git/info/attributes are as they were", async () => {
    const fx = fixtureRepo();
    const ws = hostWorkspace(fx.mirror, fx.commit);
    const c = path.join(scratchDir("fxh-c-"), "c");
    git(path.dirname(c), "clone", "-q", fx.repo, c);
    git(c, "checkout", "-q", "--detach", fx.commit);
    writeFileSync(path.join(c, "new.txt"), "hello\n");
    git(c, "add", "-A");
    git(c, "commit", "-qm", "agent");
    const out = path.join(path.dirname(c), "b.bundle");
    git(c, "bundle", "create", out, "HEAD", `^${fx.commit}`, "--quiet");
    const bundle = readFileSync(out);
    unpinWorkspace(ws);
    const attrs = path.join(ws, ".git", "info", "attributes");
    const before = existsSync(attrs) ? readFileSync(attrs, "utf8") : null;
    const code = await refusal(applyBundle(hostDeps(), { bundle, base: fx.commit, mirrorDir: fx.mirror, workspace: ws }));
    expect(code).toBe("workspace_git_refused");
    expect(git(ws, "rev-parse", "HEAD")).toBe(fx.commit);
    expect(git(ws, "for-each-ref", "refs/fx")).toBe("");
    expect(existsSync(attrs) ? readFileSync(attrs, "utf8") : null).toBe(before);
  });
});
