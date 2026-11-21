import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildWorkspaceArchive } from "../../src/daemon/vmArchive.js";
import { pinWorkspaceGit } from "../../src/daemon/hostRead.js";
import { applyBundle } from "../../src/daemon/vmBundle.js";
import { createGit } from "../../src/daemon/git.js";
import type { SdkSandbox } from "../../src/vm/sandboxd/sdkSlice.js";
import { pullBundle, reopenWorkspace } from "../../src/vm/workspace/bundleOut.js";
import { createFreshVmCheck, runGuestCheck } from "../../src/vm/workspace/guestCheck.js";
import { DEFAULT_GUEST_PATHS, runInGuest, sendWorkspace } from "../../src/vm/workspace/guestWorkspace.js";
import { bootVm, type BootEnv } from "./helpers/bootVm.js";
import type { AgentClient } from "./helpers/agentClient.js";

/**
 * D#587 B-5b in the REAL guest image: the unpack, the check and the bundle scripts run by the image's own agent, with the image's own git, tar, base64 and
 * shell, as the image's agent user. The VM is the one `vmBoot.real.test.ts` boots (no network device, no jailer, no root); only the host's file transfer and
 * command calls are replaced by the agent's own `put` and `exec`. Skipped unless the same three variables are set.
 */
const env = { firecracker: process.env["FX_VM_FIRECRACKER"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"] };
const ready = env.firecracker !== undefined && env.kernel !== undefined && env.rootfs !== undefined;
if (!ready) console.warn("workspaceImage.real: FX_VM_FIRECRACKER, FX_VM_KERNEL and FX_VM_ROOTFS are not all set; the real-image workspace checks are skipped");

const root = ready ? mkdtempSync(path.join(tmpdir(), "fxw-img-")) : "";
afterAll(() => (root === "" ? undefined : rmSync(root, { recursive: true, force: true })));

const GIT_ENV: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/** The two calls the workspace code makes of a guest, over the real agent. */
function guestOver(agent: AgentClient): SdkSandbox {
  return {
    name: "image",
    status: "running",
    async updateNetworkPolicy() {
      return undefined;
    },
    async writeFiles(files: Array<{ path: string; content: string; mode?: number }>) {
      for (const f of files) await agent.put(f.path, Buffer.from(f.content, "utf8"), f.mode ?? 0o644);
    },
    async runCommand(p: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string> }) {
      const ran = await agent.exec([p.cmd, ...(p.args ?? [])], { ...(p.cwd === undefined ? {} : { cwd: p.cwd }), ...(p.env === undefined ? {} : { env: p.env }), timeoutS: 300 });
      return {
        async *logs() {
          if (ran.stdout !== "") yield { stream: "stdout", data: ran.stdout };
          if (ran.stderr !== "") yield { stream: "stderr", data: ran.stderr };
        },
        wait: async () => ({ exitCode: ran.exit ?? 137 }),
        kill: async () => undefined,
      };
    },
  } as unknown as SdkSandbox;
}

describe.skipIf(!ready)("a job's working copy in the real guest image", () => {
  it("the archive unpacks with the image's tools, the check runs, the commit comes out as a bundle the host applies, and no host path is in the guest", async () => {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    git(root, "init", "-q", "repo");
    writeFileSync(path.join(repo, "scripts", "check.sh"), "echo checked-in-guest\necho 'Tests  3 passed | 1 skipped (4)'\n");
    chmodSync(path.join(repo, "scripts", "check.sh"), 0o755);
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    execFileSync("ln", ["-s", "README.md", path.join(repo, "readme-link")]);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fixture");
    const mirror = path.join(root, "mirror.git");
    git(root, "clone", "-q", "--bare", repo, mirror);
    const commit = git(repo, "rev-parse", "HEAD");
    const capture = async (command: string, args: readonly string[], e: Record<string, string>) => ({ code: 0, stdout: execFileSync(command, [...args], { env: { ...GIT_ENV, ...e }, encoding: "utf8", maxBuffer: 1 << 26 }), timedOut: false });
    const g = createGit({ capture });
    const deps = { git: g, gitLarge: g, scratchDir: mkdtempSync(path.join(root, "scratch-")) };

    const vm = await bootVm(env as BootEnv, path.join(root, "vm"));
    let stopped = false;
    try {
      const guest = guestOver(vm.agent);
      await sendWorkspace(guest, await buildWorkspaceArchive(deps, mirror, commit));
      const ws = DEFAULT_GUEST_PATHS.workspace;
      const inGuest = async (cmd: string, args: string[]) => (await runInGuest(guest, { cmd, args, cwd: ws }, 60_000)).stdout.trim();
      expect(await inGuest("git", ["rev-parse", "HEAD"])).toBe(commit);
      expect(await inGuest("git", ["status", "--porcelain"])).toBe("");
      expect(await reopenWorkspace(guest, commit)).toBe(true);
      for (const text of [await inGuest("mount", []), await inGuest("env", []), await inGuest("cat", ["/proc/self/mountinfo"])]) for (const hostPath of [root, repo, mirror]) expect(text.includes(hostPath), hostPath).toBe(false);

      const passing = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 120 }, guest, baseFile: async () => null, now: () => new Date() });
      expect(passing.passed).toBe(true);
      expect(passing.body).toMatchObject({ exit_code: 0, skipped_tests: 1 });
      expect((await runGuestCheck({ check: { argv: ["sh", "-c", "exit 7"], dev_shell: false, timeout_s: 120 }, guest, baseFile: async () => null, now: () => new Date() })).body.exit_code).toBe(7);
      // a pinned file whose bytes are not UTF-8 reaches the check as the default branch has it (the image's own base64, sh and cp), and the agent's version is given back
      const latin1 = Buffer.from("# caf\xe9 \xff\necho pinned-ran\n", "latin1");
      await inGuest("sh", ["-c", "printf 'echo agent-version\\n' > scripts/pinned.sh"]);
      const pinned = await runGuestCheck({ check: { argv: ["sh", "scripts/pinned.sh"], dev_shell: false, timeout_s: 120 }, guest, baseFile: async (rel) => (rel === "scripts/pinned.sh" ? latin1 : null), now: () => new Date() });
      expect(pinned.body.summary).toContain("pinned-ran");
      expect(pinned.passed).toBe(true);
      expect(await inGuest("cat", ["scripts/pinned.sh"])).toBe("echo agent-version");
      await inGuest("rm", ["-f", "scripts/pinned.sh"]);

      expect(await pullBundle(guest, commit)).toBeNull();
      await inGuest("sh", ["-c", "echo more >> README.md && git add -A && git commit -qm agent"]);
      const bundle = await pullBundle(guest, commit);
      expect(bundle).not.toBeNull();
      const hostWs = path.join(root, "host-ws");
      git(root, "clone", "-q", "--shared", mirror, hostWs);
      git(hostWs, "checkout", "-q", "-B", "fx/run", commit);
      // the daemon pins a workspace right after its clone (mirror.ts) and `applyBundle` refuses one that is not pinned, so pin it the same way
      await pinWorkspaceGit(g, hostWs, path.join(mirror, "objects"));
      const applied = await applyBundle(deps, { bundle: bundle as Buffer, base: commit, mirrorDir: mirror, workspace: hostWs });
      expect(applied.commits).toBe(1);
      expect(git(hostWs, "rev-parse", "HEAD^{tree}")).toBe(await inGuest("git", ["rev-parse", "HEAD^{tree}"]));
      expect(readFileSync(path.join(hostWs, "README.md"), "utf8")).toBe("hello\nmore\n");

      // TL ruling 12: the check that decides runs in a FRESH VM given the archive of the host's new tip. The agent's VM is ended first; a shim the agent leaves in its own VM is not in the new one.
      await inGuest("sh", ["-c", "printf '#!/bin/sh\\nexit 0\\n' > /tmp/agent-shim && chmod +x /tmp/agent-shim"]);
      await vm.stop();
      stopped = true;
      const fresh = await bootVm(env as BootEnv, path.join(root, "vm-fresh"));
      const removed: string[] = [];
      try {
        const freshGuest = guestOver(fresh.agent);
        const check = createFreshVmCheck({
          port: { createSandbox: async (o) => ({ runId: "", sandboxName: o.sandboxName }), deleteSandbox: async (h) => void removed.push(h.sandboxName), guestOf: async () => freshGuest },
          archive: (repoDir, c) => buildWorkspaceArchive(deps, repoDir, c),
          now: () => new Date(),
          maxTimeoutMs: 3_600_000,
        });
        const tip = git(hostWs, "rev-parse", "HEAD");
        const outcome = await check({ runId: "real-1", check: { argv: ["sh", "-c", `test ! -e /tmp/agent-shim && test "$(git rev-parse HEAD)" = ${tip} && echo fresh-vm-ok`], dev_shell: false, timeout_s: 120 }, repoDir: hostWs, tip, baseFile: async () => null, networkPolicy: [] });
        expect(outcome.passed).toBe(true);
        expect(outcome.body.summary).toContain("fresh-vm-ok");
        expect(removed).toEqual(["rc-real-1"]);
        const failing = await check({ runId: "real-2", check: { argv: ["sh", "-c", "echo REAL-FAIL; exit 4"], dev_shell: false, timeout_s: 120 }, repoDir: hostWs, tip, baseFile: async () => null, networkPolicy: [] });
        expect(failing.passed).toBe(false);
        expect(failing.body.exit_code).toBe(4);
      } finally {
        await fresh.stop();
      }
    } finally {
      if (!stopped) await vm.stop();
    }
  }, 300_000);
});
