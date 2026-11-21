import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import { buildWorkspaceArchive } from "../../src/daemon/vmArchive.js";
import { pinWorkspaceGit } from "../../src/daemon/hostRead.js";
import { applyBundle } from "../../src/daemon/vmBundle.js";
import { createGit } from "../../src/daemon/git.js";
import type { BootDigests, TargetListing } from "../../src/vm/bootGate.js";
import type { Arch } from "../../src/vm/lock.js";
import { startEgressProxy } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { createHelperClient } from "../../src/vm/sandboxd/helperClient.js";
import { createMicrovmSandbox } from "../../src/vm/sandboxd/microvmSandbox.js";
import { createEgressPolicyPort } from "../../src/vm/sandboxd/policyPort.js";
import { createProductionSandboxd } from "../../src/vm/sandboxd/production.js";
import { createDaemonSdk } from "../../src/vm/sandboxd/sdkAdapter.js";
import type { SdkSandbox } from "../../src/vm/sandboxd/sdkSlice.js";
import { createWorkspaceCrossing } from "../../src/vm/workspace/crossing.js";
import { runGuestCheck } from "../../src/vm/workspace/guestCheck.js";
import { GUEST_WORKSPACE, runInGuest } from "../../src/vm/workspace/guestWorkspace.js";
import { connectUnix } from "./sandboxd/helpers.js";

/**
 * D#587 B-5b against a REAL VM: the repository goes in over vsock, the guest builds its git state from it, the approved check runs there, and the guest holds no
 * host path (its mount table, its environment and `/proc/self/mountinfo` are read). The environment is the same as `microvmSandbox.real.test.ts` (a dispatched
 * host that has Firecracker, the helper and a built guest image); anywhere else the suite says so and skips. It runs as the ordinary user, never as root.
 */
const env = { helper: process.env["FX_VM_HELPER_SOCKET"], template: process.env["FX_VM_TEMPLATE"], facts: process.env["FX_VM_BOOT_FACTS"] };
const ready = env.helper !== undefined && env.template !== undefined && env.facts !== undefined && process.geteuid !== undefined && process.geteuid() !== 0;
if (!ready) console.warn("workspaceCrossing.real: FX_VM_HELPER_SOCKET, FX_VM_TEMPLATE and FX_VM_BOOT_FACTS are not all set (or this is root); the real-VM workspace suite is skipped");

const root = ready ? mkdtempSync(path.join(tmpdir(), "fxw-real-")) : "";
afterAll(() => (root === "" ? undefined : rmSync(root, { recursive: true, force: true })));

const GIT_ENV: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

describe.skipIf(!ready)("a job's working copy in a real VM", () => {
  it("the archive goes in, the guest holds the start commit and no host path, and the approved check runs there", async () => {
    const facts = JSON.parse(readFileSync(env.facts as string, "utf8")) as { arch: Arch; digests: BootDigests; listing: TargetListing };
    const uid = process.geteuid?.() ?? -1;
    const daemon = createProductionSandboxd({ helperSocket: env.helper as string, host: { euid: uid, platform: process.platform }, boot: { listTargets: async () => facts.listing, facts: () => ({ arch: facts.arch, digests: facts.digests }) } });
    const helper = createHelperClient(connectUnix(env.helper as string));
    const policy = createEgressPolicyPort({ helper, uid, egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint } });
    const sdk = createDaemonSdk({ daemon, policy, template: env.template as string, memMb: 512 });

    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    git(root, "init", "-q", "repo");
    writeFileSync(path.join(repo, "scripts", "check.sh"), "echo checked-in-guest\necho 'Tests  3 passed | 1 skipped (4)'\n");
    chmodSync(path.join(repo, "scripts", "check.sh"), 0o755);
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fixture");
    const mirror = path.join(root, "mirror.git");
    git(root, "clone", "-q", "--bare", repo, mirror);
    const commit = git(repo, "rev-parse", "HEAD");
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    const capture = async (command: string, args: readonly string[], e: Record<string, string>) => ({ code: 0, stdout: execFileSync(command, [...args], { env: { ...GIT_ENV, ...e }, encoding: "utf8", maxBuffer: 1 << 26 }), timedOut: false });
    const g = createGit({ capture });

    const seen: { head?: string; tree?: string; mounts?: string; environ?: string; mountinfo?: string; guestTree?: string } = {};
    let guestRef: SdkSandbox | undefined;
    const crossing = createWorkspaceCrossing((guest) => {
      guestRef = guest;
      const runtime = {
        async start(o: { runId: string; workdir: string }) {
          const run = async (cmd: string, args: string[]) => (await runInGuest(guest, { cmd, args, cwd: o.workdir }, 60_000)).stdout;
          seen.head = (await run("git", ["rev-parse", "HEAD"])).trim();
          seen.tree = (await run("git", ["rev-parse", "HEAD^{tree}"])).trim();
          seen.mounts = await run("mount", []);
          seen.environ = await run("env", []);
          seen.mountinfo = await run("cat", ["/proc/self/mountinfo"]);
          // the agent's own work: one edit and one commit, in the guest
          await run("sh", ["-c", "echo more >> README.md && git add -A && git commit -qm agent"]);
          seen.guestTree = (await run("git", ["rev-parse", "HEAD^{tree}"])).trim();
          return { handle: { runId: o.runId, done: Promise.resolve({ status: "ok" }) } as never };
        },
        async stop() {},
      } as unknown as AgentRuntime;
      return runtime;
    });
    const port = createMicrovmSandbox({ sdk, makeRuntime: crossing.makeRuntime });
    crossing.bind("real-1", { startCommit: async () => commit, archive: (c) => buildWorkspaceArchive({ git: g, gitLarge: g, scratchDir: mkdtempSync(path.join(root, "scratch-")) }, mirror, c) });
    const handle = await port.createSandbox({ sandboxName: "ws-real-1", retention: { persistent: false }, timeoutMs: 5 * 60_000 });
    try {
      await port.startDetached(handle, { runId: "real-1", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir: path.join(root, "host-workspace"), capUsd: 0, networkPolicy: [], env: {}, onEvent: () => undefined }).hookFired.catch((e: unknown) => {
        if ((e as { name?: string }).name !== "AgentRunFailed") throw e;
      });
      expect(seen.head).toBe(commit);
      expect(seen.tree).toBe(tree);
      for (const text of [seen.mounts, seen.environ, seen.mountinfo]) for (const hostPath of [root, repo, mirror]) expect(text?.includes(hostPath), hostPath).toBe(false);
      const guest = await port.guestOf(handle);
      const passing = await runGuestCheck({ check: { argv: ["sh", "scripts/check.sh"], dev_shell: false, timeout_s: 120 }, guest, baseFile: async () => null, now: () => new Date() });
      expect(passing.passed).toBe(true);
      expect(passing.body).toMatchObject({ exit_code: 0, skipped_tests: 1 });
      const failing = await runGuestCheck({ check: { argv: ["sh", "-c", "exit 7"], dev_shell: false, timeout_s: 120 }, guest, baseFile: async () => null, now: () => new Date() });
      expect(failing.body.exit_code).toBe(7);
      // the commit comes out as a bundle, the host checks it, and its workspace then holds the guest's tree
      const hostWs = path.join(root, "host-ws");
      git(root, "clone", "-q", "--shared", mirror, hostWs);
      git(hostWs, "checkout", "-q", "-B", "fx/run", commit);
      // the daemon pins a workspace right after its clone (mirror.ts) and `applyBundle` refuses one that is not pinned, so pin it the same way
      await pinWorkspaceGit(g, hostWs, path.join(mirror, "objects"));
      await port.quiesce(handle);
      const collected = await crossing.collect("real-1", guest);
      expect(collected?.base).toBe(commit);
      const applied = await applyBundle({ git: g, gitLarge: g, scratchDir: mkdtempSync(path.join(root, "scratch-")) }, { bundle: (collected as NonNullable<typeof collected>).bundle, base: commit, mirrorDir: mirror, workspace: hostWs });
      expect(applied.commits).toBe(1);
      expect(git(hostWs, "rev-parse", "HEAD^{tree}")).toBe(seen.guestTree);
      expect(readFileSync(path.join(hostWs, "README.md"), "utf8")).toBe("hello\nmore\n");
      expect(GUEST_WORKSPACE).toBe("/vercel/sandbox/work");
      expect(guestRef).toBeDefined();
    } finally {
      await port.deleteSandbox(handle).catch(() => undefined);
    }
  }, 300_000);
});
