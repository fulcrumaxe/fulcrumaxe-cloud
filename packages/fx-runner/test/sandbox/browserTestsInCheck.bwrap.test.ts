import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentHandle } from "@fulcrumaxe/runner-protocol";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { cleanEnv } from "../../src/job/cleanEnv.js";
import { createHostSandbox, type InterruptibleRuntime } from "../../src/sandbox/hostSandbox.js";
import type { SandboxHandle } from "../../src/sandbox/port.js";
import { findChromium } from "../../src/verifyBrowser/driver.js";
import { checkCanLaunch } from "../helpers/bwrapProbe.js";
import { CHROMIUM_SANDBOX_SKIP_REASON } from "../helpers/chromiumSandbox.js";
import { UNIX_SOCKETS_SKIP_REASON } from "../helpers/needsHostSockets.js";
import { testLaunch } from "../helpers/launch.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * The runner's own tests that need a real Unix socket or a real Chromium, run the way the repo check runs them: inside the check's real bubblewrap view and seccomp filter, from
 * `HostSandbox.checkLaunch`, started through the production kit. There the filter refuses `socket(AF_UNIX)` (every `listen` on a socket path answers EPERM) and user namespaces
 * (Chromium with its own sandbox on stops with "No usable sandbox", SIGTRAP). Those files used to fail the whole check on a cloud-built change that never touched them. They now
 * skip, with the reason printed, only where a sandbox marker is set and the capability is really missing (`needsHostSockets.ts`, `chromiumSandbox.ts`); the verify browser itself keeps
 * its sandbox on. This suite runs them in the check and requires exit 0, the named reasons, and that the cases which do not need either capability still ran and passed.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = process.platform === "linux" && BWRAP !== undefined && checkCanLaunch(BWRAP);
const PKG = path.resolve(import.meta.dirname, "../..");
const REPO = path.resolve(PKG, "../..");
const VITEST = path.join(PKG, "node_modules", "vitest", "vitest.mjs");
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH;
const hasChromium = BROWSERS !== undefined && findChromium(process.env) !== undefined;
const FILES = [
  "test/deployVerifierLocal.test.ts",
  "test/daemon/browserProbe.test.ts",
  "test/daemon/browserProbeLongTmp.test.ts",
  "test/verifyBrowser/browser.real.test.ts",
  "test/verifyBrowser/entry.real.test.ts",
  "test/verifyBrowser/https.real.test.ts",
];

const kit = createClaudeKit(spawn, { launch: testLaunch() });
let root: string;
let handle: SandboxHandle;
let host: ReturnType<typeof createHostSandbox>;

beforeAll(async () => {
  if (!usable) return;
  root = mkdtempSync(path.join(tmpRoot(), "browser-in-check-"));
  const home = path.join(root, "home");
  const tempRoot = path.join(home, ".cache", "fx-runner", "tmp");
  const stateDir = path.join(home, ".fx-runner");
  for (const dir of [tempRoot, stateDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
  const runtime = { start: async () => ({ handle: { runId: "r1", done: Promise.resolve({ status: "done" }) } as unknown as AgentHandle }), stop: async () => undefined } as unknown as InterruptibleRuntime;
  host = createHostSandbox({ credentials: { mode: "subscription" }, makeRuntime: () => runtime, home, stateDir, binaryDir: path.join(root, "bin"), tempRoot, workspaceRoot: path.dirname(REPO), packageStoreRoot: path.join(home, ".cache", "fx-runner", "pnpm-store") });
  handle = await host.createSandbox({ sandboxName: "rn-r1", retention: { persistent: false }, timeoutMs: 600_000 });
  const nixEnv = { PATH: path.dirname(process.execPath), ...(hasChromium ? { PLAYWRIGHT_BROWSERS_PATH: BROWSERS } : {}) };
  const allowances = { entries: [{ kind: "domain" as const, value: "registry.npmjs.org", access: "connect" as const, reason: "install" }], commandTimeoutS: 600, storeKey: "acme__widgets", nixEnv };
  const started = host.startDetached(handle, { runId: "r1", role: "executor", roleCard: "x", prompt: "p", model: "sonnet", capUsd: 0, workdir: REPO, networkPolicy: [], env: cleanEnv({ mode: "subscription" }), allowances, onEvent: () => undefined } as never);
  await started.hookFired.catch(() => undefined);
});
afterAll(async () => {
  if (!usable) return;
  await host.deleteSandbox(handle);
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!usable)("the socket and real-browser suites inside the check's real sandbox", () => {
  it("pass or skip with a named reason, and never fail the check", async () => {
    // The vitest output goes to a file in the check's own TMPDIR and its tail is printed, so the exit code is the run's and not a pipe's.
    const script = `cd ${PKG} && ${JSON.stringify(process.execPath)} ${VITEST} run --reporter=verbose ${FILES.join(" ")} > "$TMPDIR/out.txt" 2>&1; code=$?; tail -c 30000 "$TMPDIR/out.txt"; exit $code`;
    const launch = host.checkLaunch(handle, ["sh", "-c", script], true);
    if (launch === undefined || "refused" in launch) throw new Error("no launch");
    expect(launch.env.FX_RUNNER_CHECK).toBe("1");
    const out = await kit.installCapture!(launch.tool, launch.args, launch.env, REPO, 400_000, 60_000, undefined, launch.feed);
    expect(out.tail, out.tail).not.toMatch(/EPERM|No usable sandbox|SIGTRAP/);
    expect(out.code, out.tail).toBe(0);
    expect(out.tail).toContain(UNIX_SOCKETS_SKIP_REASON);
    if (hasChromium) expect(out.tail).toContain(CHROMIUM_SANDBOX_SKIP_REASON);
    // The cases that need neither capability still ran: a skip is per case, never the whole file.
    expect(out.tail).toMatch(/✓ test\/daemon\/browserProbe\.test\.ts > browser probe > says the one sentence for every failure/);
    expect(out.tail).toMatch(/✓ test\/verifyBrowser\/entry\.real\.test\.ts .*advertises exactly the twelve tools/);
  }, 420_000);
});
