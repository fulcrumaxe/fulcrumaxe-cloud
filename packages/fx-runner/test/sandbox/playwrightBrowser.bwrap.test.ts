import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentHandle } from "@fulcrumaxe/runner-protocol";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { cleanEnv } from "../../src/job/cleanEnv.js";
import { createHostSandbox, type InterruptibleRuntime } from "../../src/sandbox/hostSandbox.js";
import type { SandboxHandle } from "../../src/sandbox/port.js";
import { bwrapCanCreateNamespaces } from "../helpers/bwrapProbe.js";
import { testLaunch } from "../helpers/launch.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#6 RUNNER-REVIEW-BROWSER: a repo whose dev shell exports `PLAYWRIGHT_BROWSERS_PATH` (a Nix store directory) gives its jobs that variable and a read-only view of the store it
 * names. Unit part: what the host sandbox hands the agent runtime (the `sandbox` block and the job env), with and without a dev shell. Real part: Chromium, pinned by the
 * path the dev shell exported, starts headless inside the check's real bubblewrap view and filter and renders a page, with the variable arriving from the grant and not from
 * the test; the store is read-only there and the network is absent.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = process.platform === "linux" && BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);
const SITEKIT = path.resolve(import.meta.dirname, "../../../sitekit-checks");
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH;
const STORE_BROWSERS = BROWSERS !== undefined && /^\/nix\/store\/[A-Za-z0-9._+-]+$/.test(BROWSERS) && existsSync(BROWSERS) ? BROWSERS : undefined;
const FAKE_BROWSERS = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-playwright-browsers";

const kit = createClaudeKit(spawn, { launch: testLaunch() });

interface Seen {
  sandbox: { filesystem: { allowRead: string[]; denyRead: string[]; allowWrite: string[] } };
  jobEnv: Record<string, string> | undefined;
}

let root: string;
let workspace: string;
let home: string;
let stateDir: string;
let tempRoot: string;

function makeHost(): { host: ReturnType<typeof createHostSandbox>; seen: Seen[] } {
  const seen: Seen[] = [];
  const runtime = { start: async () => ({ handle: { runId: "r1", done: Promise.resolve({ status: "done" }) } as unknown as AgentHandle }), stop: async () => undefined } as unknown as InterruptibleRuntime;
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    makeRuntime: (sandbox, _protected, jobEnv) => {
      seen.push({ sandbox: sandbox as unknown as Seen["sandbox"], jobEnv: jobEnv === undefined ? undefined : { ...jobEnv } });
      return runtime;
    },
    home,
    stateDir,
    binaryDir: path.join(root, "bin"),
    tempRoot,
    workspaceRoot: path.dirname(workspace),
    packageStoreRoot: path.join(home, ".cache", "fx-runner", "pnpm-store"),
  });
  return { host, seen };
}

async function start(host: ReturnType<typeof createHostSandbox>, name: string, nixEnv: Record<string, string> | undefined, role = "acceptance-tester"): Promise<SandboxHandle> {
  const handle = await host.createSandbox({ sandboxName: name, retention: { persistent: false }, timeoutMs: 600_000 });
  const allowances = { entries: [{ kind: "domain" as const, value: "registry.npmjs.org", access: "connect" as const, reason: "install" }], commandTimeoutS: 600, storeKey: "acme__widgets", ...(nixEnv === undefined ? {} : { nixEnv }) };
  const started = host.startDetached(handle, { runId: name, role, roleCard: "x", prompt: "p", model: "sonnet", capUsd: 0, workdir: workspace, networkPolicy: [], env: cleanEnv({ mode: "subscription" }), allowances, onEvent: () => undefined } as never);
  await started.hookFired.catch(() => undefined);
  return handle;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpRoot(), "pw-browser-"));
  home = path.join(root, "home");
  workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
  tempRoot = path.join(home, ".cache", "fx-runner", "tmp");
  stateDir = path.join(home, ".fx-runner");
  for (const dir of [workspace, tempRoot, stateDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!usable)("agent turns of a job with a dev shell that exports the Playwright browsers path", () => {
  it("get the variable and a read of the store; a job with no dev shell gets neither", async () => {
    const { host, seen } = makeHost();
    await start(host, "with-shell", { PATH: `${FAKE_BROWSERS}/bin`, PLAYWRIGHT_BROWSERS_PATH: FAKE_BROWSERS });
    await start(host, "no-shell", undefined);
    const [withShell, noShell] = seen;
    expect(withShell!.jobEnv?.PLAYWRIGHT_BROWSERS_PATH).toBe(FAKE_BROWSERS);
    expect(withShell!.sandbox.filesystem.allowRead).toContain("/nix/store");
    expect(withShell!.sandbox.filesystem.denyRead).not.toContain("/nix/store");
    // Read only: the store is in no write list, and the job's own writes stay where they were.
    expect(withShell!.sandbox.filesystem.allowWrite.some((entry) => entry === "/nix/store" || entry.startsWith(`${FAKE_BROWSERS}`))).toBe(false);
    expect(noShell!.jobEnv).not.toHaveProperty("PLAYWRIGHT_BROWSERS_PATH");
    expect(noShell!.sandbox.filesystem.allowRead).not.toContain("/nix/store");
  });

  it("does not take the variable from the runner's own environment", async () => {
    const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = FAKE_BROWSERS;
    try {
      const { host, seen } = makeHost();
      const handle = await start(host, "host-env", undefined);
      expect(seen[0]!.jobEnv).not.toHaveProperty("PLAYWRIGHT_BROWSERS_PATH");
      const launch = host.checkLaunch(handle, ["true"], false);
      expect(launch !== undefined && !("refused" in launch) && launch.env.PLAYWRIGHT_BROWSERS_PATH).toBeFalsy();
    } finally {
      if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
    }
  });
});

/** Where the pinned Playwright lives, resolved here the way the site-kit package resolves it and handed in as absolute real paths. */
function resolvePlaywright(): { core: string; executable: string } | undefined {
  try {
    const sitekitRequire = createRequire(path.join(SITEKIT, "package.json"));
    const core = realpathSync(path.dirname(sitekitRequire.resolve("playwright-core/package.json")));
    const executable = (sitekitRequire(core) as { chromium: { executablePath(): string } }).chromium.executablePath();
    return { core, executable };
  } catch {
    return undefined;
  }
}
const playwright = STORE_BROWSERS === undefined ? undefined : resolvePlaywright();
const browserReady = playwright !== undefined && existsSync(playwright.executable);

describe.skipIf(!usable || !browserReady)("real bubblewrap: the browser the dev shell names runs inside the job's sandbox", () => {
  const program = [
    "const { chromium } = require(process.argv[1]);",
    "(async () => {",
    "  const fs = require('fs');",
    "  let wrote = 'no';",
    "  try { fs.writeFileSync(process.env.PLAYWRIGHT_BROWSERS_PATH + '/x', '1'); wrote = 'yes'; } catch { /* read-only is the point */ }",
    "  const b = await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--disable-dev-shm-usage'] });",
    "  const p = await b.newPage();",
    "  await p.setContent('<h1 id=t>rendered</h1>');",
    "  console.log('title=' + (await p.textContent('#t')) + ' browsers=' + process.env.PLAYWRIGHT_BROWSERS_PATH + ' wrote=' + wrote);",
    "  await b.close();",
    "})().catch((e) => { console.log('chromium=failed ' + String(e.message).split('\\n')[0]); process.exit(1); });",
  ].join("\n");

  it("renders a page with the variable from the dev shell's grant, the store read-only, no network", async (ctx) => {
    const { host } = makeHost();
    const handle = await start(host, "real", { PATH: path.dirname(process.execPath), PLAYWRIGHT_BROWSERS_PATH: STORE_BROWSERS! });
    try {
      // Can the check read what it is about to be given? A checkout the check's view hides is a skip, never a failure of the sandbox.
      const probe = 'try { require(process.argv[1]); require("fs").accessSync(process.argv[2], 1); console.log("visible=yes"); } catch (e) { console.log("visible=no " + String(e.message).split("\\n")[0]); }';
      const seenLaunch = host.checkLaunch(handle, [process.execPath, "-e", probe, playwright!.core, playwright!.executable], true);
      if (seenLaunch === undefined || "refused" in seenLaunch) throw new Error("no launch");
      const seen = await kit.installCapture!(seenLaunch.tool, seenLaunch.args, seenLaunch.env, workspace, 20_000, 4096, undefined, seenLaunch.feed);
      if (!seen.tail.includes("visible=yes")) {
        console.warn(`SKIPPED: playwright-core or the Chromium binary is not readable inside the check's view of this checkout (${seen.tail.split("\n").find((line) => line.includes("visible=")) ?? seen.tail.slice(0, 200)})`);
        ctx.skip();
      }
      const launch = host.checkLaunch(handle, [process.execPath, "-e", program, playwright!.core], true);
      if (launch === undefined || "refused" in launch) throw new Error("no launch");
      expect(launch.env.PLAYWRIGHT_BROWSERS_PATH).toBe(STORE_BROWSERS);
      const out = await kit.installCapture!(launch.tool, launch.args, launch.env, workspace, 30_000, 4096, undefined, launch.feed);
      expect(out.tail, out.tail).toContain("title=rendered");
      expect(out.tail).toContain(`browsers=${STORE_BROWSERS}`);
      expect(out.tail).toContain("wrote=no");
      expect(out.code).toBe(0);
      // The network is absent: the same sandbox cannot reach a host.
      const net = host.checkLaunch(handle, [process.execPath, "-e", "require('net').connect(80,'1.1.1.1').on('connect',()=>{console.log('net=up');process.exit(0)}).on('error',(e)=>{console.log('net=none '+e.code);process.exit(1)})"], true);
      if (net === undefined || "refused" in net) throw new Error("no launch");
      const reached = await kit.installCapture!(net.tool, net.args, net.env, workspace, 15_000, 4096, undefined, net.feed);
      expect(reached.tail).not.toContain("net=up");
      expect(reached.tail).toContain("net=none");
    } finally {
      await host.deleteSandbox(handle);
    }
  });
});
