import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { SdkSandbox } from "../../../src/vm/sandboxd/sdkSlice.js";
import type { GuestPaths } from "../../../src/vm/workspace/guestWorkspace.js";

/** Scratch directories removed after each test. */
const roots: string[] = [];
export const scratchDir = (prefix = "fxw-"): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git environment that reads no user or system setting and has a fixed identity. */
export const GIT_ENV = (): Record<string, string> => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" });
export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A fixture repository with a few kinds of entry, committed; returns the repo directory, a bare mirror of it and the commit. */
export function fixtureRepo(extra: (dir: string) => void | "committed" = () => undefined): { repo: string; mirror: string; commit: string; tree: string } {
  const root = scratchDir("fxw-repo-");
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(root, "init", "-q", "repo");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(path.join(repo, "run.sh"), 0o755);
  execFileSync("ln", ["-s", "src/a.ts", path.join(repo, "link-to-a")]);
  if (extra(repo) !== "committed") {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--allow-empty", "-m", "fixture");
  }
  const mirror = path.join(root, "mirror.git");
  git(root, "clone", "-q", "--bare", repo, mirror);
  return { repo, mirror, commit: git(repo, "rev-parse", "HEAD"), tree: git(repo, "rev-parse", "HEAD^{tree}") };
}

export interface LocalGuest {
  guest: SdkSandbox;
  paths: GuestPaths;
  /** Everything the host sent: each file written and each command's argv and environment. */
  sent: { files: Array<{ path: string; content: string; mode?: number; parentExisted: boolean }>; commands: Array<{ cmd: string; args: string[]; cwd?: string; env?: Record<string, string> }>; policies: unknown[] };
  root: string;
}

/**
 * A guest that is a directory on this machine: its commands are real processes (sh, tar, git, base64) run with a minimal environment, and its files are real
 * files. The guest's paths are directories below `root`, so what is checked is what the real guest scripts do, byte for byte.
 */
export function localGuest(existingRoot?: string): LocalGuest {
  const root = existingRoot ?? scratchDir("fxw-guest-");
  const paths: GuestPaths = { workspace: path.join(root, "sandbox", "work"), stage: path.join(root, "sandbox", ".stage") };
  const sent: LocalGuest["sent"] = { files: [], commands: [], policies: [] };
  const guest = {
    name: "local",
    status: "running",
    async updateNetworkPolicy(policy: unknown) {
      sent.policies.push(policy);
      return undefined;
    },
    async writeFiles(files: Array<{ path: string; content: string; mode?: number }>) {
      for (const f of files) {
        sent.files.push({ path: f.path, content: f.content, ...(f.mode === undefined ? {} : { mode: f.mode }), parentExisted: existsSync(path.dirname(f.path)) });
        mkdirSync(path.dirname(f.path), { recursive: true });
        writeFileSync(f.path, Buffer.from(f.content, "utf8"), { mode: (f.mode ?? 0o644) & 0o777 });
        chmodSync(f.path, (f.mode ?? 0o644) & 0o777);
      }
    },
    async runCommand(params: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string> }) {
      sent.commands.push({ cmd: params.cmd, args: params.args ?? [], ...(params.cwd === undefined ? {} : { cwd: params.cwd }), ...(params.env === undefined ? {} : { env: params.env }) });
      const base = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C.UTF-8" };
      const child = spawn(params.cmd, params.args ?? [], { cwd: params.cwd ?? root, env: { ...base, ...(params.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const chunks: Array<{ stream: string; data: string }> = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const push = (stream: string) => (c: Buffer): void => void (chunks.push({ stream, data: c.toString("utf8") }), wake?.());
      child.stdout.on("data", push("stdout"));
      child.stderr.on("data", push("stderr"));
      const exit = new Promise<{ exitCode: number }>((resolve) =>
        child.on("close", (code) => {
          ended = true;
          wake?.();
          resolve({ exitCode: code ?? 137 });
        }),
      );
      child.on("error", () => void (ended = true, wake?.()));
      return {
        async *logs() {
          for (;;) {
            while (chunks.length > 0) yield chunks.shift() as { stream: string; data: string };
            if (ended) return;
            await new Promise<void>((resolve) => void (wake = resolve));
          }
        },
        wait: () => exit,
        async kill() {
          try {
            process.kill(-(child.pid as number), "SIGKILL");
          } catch {
            // already gone
          }
        },
      };
    },
  } as unknown as SdkSandbox;
  return { guest, paths, sent, root };
}
