import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveRegistration } from "../../src/config.js";
import { CEILING_FILE } from "../../src/engineBridge/ceiling.js";
import { BRIDGE_STATUS_FILE } from "../../src/engineBridge/daemon.js";
import { ENGINE_HALT_FILE } from "../../src/engineBridge/halt.js";
import { saveBridgeSettings } from "../../src/engineBridge/settings.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { originHash } from "../../src/keyring.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
import { startStrictEngineDials, type StrictEngineDials } from "../helpers/strictEngineDials.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";
import { startStrictEngineIngest, type StrictEngineIngest } from "../helpers/strictEngineIngest.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";

/**
 * EB-3c wiring: the PROGRAM'S OWN ENTRY (`bin/fx-runner.mjs`, bundled the way a plain release is and then moved to a directory it was not built in) is started as
 * `fx-runner run` in a temporary home against a stand-in cloud, and the bridge must really run in it: the hello kept the capability, the decide socket exists at mode 0600,
 * the halt path is live (a halt control written to the engine's state directory as the halt file) and the dial ceiling keeper is live (the ceiling file is written from a
 * signed dials request). The stand-in is four contract-checking fakes behind one address, so every request is signed for that one address, as the runner's own are.
 *
 * Never reaches a real service: the child gets a stub `claude` (it exits 1 at once), `GH_TOKEN`/`GITHUB_TOKEN` set to `invalid`, a host `GH_HOST` that cannot resolve, and
 * nothing else of this process's environment. What it cannot fake: the real job-signing keys. The one thing the test changes in the bundle is the table of pinned job keys
 * (`src/keyring.ts`), which a real build fills with the staging cloud's hash: the test adds its own address, whose key is the fake cloud's.
 */
const uid = process.getuid!();
const REPO = 77;
let root: string;
let home: string;
let stateDir: string;
let engineState: string;
let xdg: string;
let moved: string;
let router: Server;
let runnerCloud: StrictRunnerCloud;
let cmds: FakeCommands;
let dials: StrictEngineDials;
let ingest: StrictEngineIngest;
let child: ChildProcess | undefined;
let childOut = "";
let childExit: Promise<number | null> = Promise.resolve(null);
let origin = "";
/** Where each fake really listens (the `origin` of each is later set to the router's, because that is the address the runner signs for). */
let ports: { runner: number; engine: number; dials: number; events: number };

/** Sends each request to the fake that owns its path, unchanged: the signature covers the address the runner used, which is the router's. */
function forward(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  const port = url.startsWith("/api/runner/engine/dials") ? ports.dials : url.startsWith("/api/runner/engine/events") ? ports.events : url.startsWith("/api/runner/engine/") ? ports.engine : ports.runner;
  const upstream = request({ host: "127.0.0.1", port, method: req.method, path: url, headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on("error", () => {
    res.statusCode = 502;
    res.end("{}");
  });
  req.pipe(upstream);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(socketTmpRoot(), "fxr-eb3c-"));
  home = path.join(root, "home");
  stateDir = path.join(home, ".fx-runner");
  engineState = path.join(root, "engine-state");
  xdg = path.join(root, "xdg");
  for (const dir of [home, engineState, xdg]) mkdirSync(dir, { mode: 0o700 });
  runnerCloud = await startStrictRunnerCloud();
  cmds = await startFakeCommands();
  dials = await startStrictEngineDials();
  ingest = await startStrictEngineIngest();
  const portOf = (fake: { origin: string }): number => Number(new URL(fake.origin).port);
  ports = { runner: portOf(runnerCloud), engine: portOf(cmds), dials: portOf(dials), events: portOf(ingest) };
  router = createServer(forward);
  await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
  for (const fake of [runnerCloud, cmds, dials, ingest]) fake.origin = origin;

  // The runner: one key, trusted by every fake, registered for the router's address; the repo is enabled for the bridge.
  const key = generateRunnerKey();
  saveRunnerKey(stateDir, key);
  saveRegistration(stateDir, { version: 1, cloud_origin: origin, runner_id: cmds.runnerId, account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
  for (const fake of [runnerCloud, cmds, dials, ingest]) fake.trust(key.publicJwk);
  const repoRoot = path.join(root, "engine-repo");
  mkdirSync(path.join(repoRoot, "engine"), { recursive: true });
  writeFileSync(path.join(repoRoot, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3" }));
  saveBridgeSettings(stateDir, [{ repo_gh_id: REPO, full_name: "acme/widgets", state_dir: engineState, repo_root: repoRoot }]);
  cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: "acme/widgets" }];
  cmds.controls.set(REPO, { halt_epoch: 2, halted: true, operate_enabled: true });
  dials.covered.add(REPO);

  // The program's own entry, bundled as a plain release is, with the one table of pinned keys that names this address; then moved, and the build directory removed.
  const pin = originHash(origin)!;
  const built = path.join(root, "built");
  mkdirSync(built);
  await build({
    entryPoints: [path.join(PACKAGE_DIR, "bin", "fx-runner.mjs")],
    absWorkingDir: PACKAGE_DIR,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: path.join(built, "fx-runner.cjs"),
    logLevel: "silent",
    external: ["@anthropic-ai/*", "playwright-core"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(path.join(root, "elsewhere", "deeper", "fx-runner.cjs")).href), __FX_BUILD_EPOCH__: '"0"' },
    plugins: [
      {
        name: "test-pinned-keys",
        setup(b) {
          b.onLoad({ filter: /[\\/]src[\\/]keyring\.ts$/ }, (args) => {
            const text = readFileSync(args.path, "utf8");
            const marker = "export const PINNED_JOB_KEYS: PinnedKeyrings = Object.freeze({";
            if (!text.includes(marker)) throw new Error("the pinned-keys table moved; update this test");
            return { contents: text.replace(marker, `${marker}\n  ${JSON.stringify(pin)}: ${JSON.stringify(cmds.keyring)},`), loader: "ts" };
          });
        },
      },
    ],
  });
  moved = path.join(root, "elsewhere", "deeper");
  mkdirSync(moved, { recursive: true });
  renameSync(path.join(built, "fx-runner.cjs"), path.join(moved, "fx-runner.cjs"));
  rmSync(built, { recursive: true, force: true });

  // The tools the machine check looks for. `claude` exits at once and does nothing: this test never runs the real agent program.
  const toolbin = path.join(root, "toolbin");
  mkdirSync(toolbin);
  for (const name of ["bwrap", "socat"]) writeFileSync(path.join(toolbin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(toolbin, "claude"), "#!/bin/sh\necho stub >&2\nexit 1\n", { mode: 0o755 });
  for (const name of readdirSync(toolbin)) chmodSync(path.join(toolbin, name), 0o755);

  const env = {
    PATH: `${toolbin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    XDG_RUNTIME_DIR: xdg,
    XDG_CACHE_HOME: path.join(root, "cache"),
    AUTONOMOUS_TEAM_STATE_DIR: engineState,
    GH_TOKEN: "invalid",
    GITHUB_TOKEN: "invalid",
    GH_HOST: "invalid.localhost",
  };
  mkdirSync(env.XDG_CACHE_HOME, { mode: 0o700 });
  child = spawn(process.execPath, [path.join(moved, "fx-runner.cjs"), "run"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (c: Buffer) => void (childOut += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => void (childOut += c.toString("utf8")));
  childExit = new Promise((resolve) => child!.on("exit", (code) => resolve(code)));
}, 120_000);

afterAll(async () => {
  if (child !== undefined && child.exitCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    await childExit;
    clearTimeout(timer);
  }
  await new Promise<void>((resolve) => router?.close(() => resolve()));
  await Promise.all([runnerCloud?.close(), cmds?.close(), dials?.close(), ingest?.close()]);
  rmSync(root, { recursive: true, force: true });
});

async function waitFor(what: string, condition: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n--- the program said:\n${childOut}`);
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the program exited (${child.exitCode}) before ${what}\n--- the program said:\n${childOut}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const status = (): { hello: boolean; socket: string; repos: Array<{ run: string; reason: string | null; ceiling: string | null }> } | undefined => {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, BRIDGE_STATUS_FILE), "utf8"));
  } catch {
    return undefined;
  }
};

describe("fx-runner run, started from the built and moved entry", () => {
  it("starts the bridge for the enabled repo: it is running, and its decide socket is a socket of this user at mode 0600", async () => {
    await waitFor("the repo to run and the socket to serve", () => status()?.repos[0]?.run === "running" && status()?.socket === "serving");
    expect(status()).toMatchObject({ hello: true, socket: "serving", repos: [{ run: "running", reason: null }] });
    const socket = path.join(xdg, "fx-runner", "engine-bridge.sock");
    const st = lstatSync(socket);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.uid).toBe(uid);
    expect(lstatSync(path.dirname(socket)).mode & 0o777).toBe(0o700);
  }, 90_000);

  it("has the halt path live: the cloud's halt control becomes the halt file in the engine's state directory, owner-only, and the cloud is told", async () => {
    const file = path.join(engineState, ENGINE_HALT_FILE);
    await waitFor("the halt file", () => existsSync(file));
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ halted: true, halt_epoch: 2 });
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    await waitFor("halt_applied at the cloud", () => [...ingest.sessions.values()].some((s) => s.stored.some((e) => e.kind === "halt_applied")));
    const applied = [...ingest.sessions.values()].flatMap((s) => s.stored).filter((e) => e.kind === "halt_applied");
    expect(applied[0]).toMatchObject({ halt_epoch: 2 });
  }, 90_000);

  it("has the dial ceiling keeper live: the ceiling file is written from a signed dials request", async () => {
    const file = path.join(engineState, CEILING_FILE);
    await waitFor("the ceiling file", () => existsSync(file));
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(dials.seen.some((s) => s.status === 200)).toBe(true);
    // `engine-bridge status` reads the daemon's status file, which it rewrites when something changes.
    await waitFor("the status file to say the ceiling was written", () => status()?.repos[0]?.ceiling === "written", 70_000);
  }, 150_000);

  it("keeps the plain bridge when the cloud's hello reply lists no watch_mode (this stand-in lists none): bridge_heartbeat, never slim_status, no spool", async () => {
    await waitFor("a bridge heartbeat at the cloud", () => [...ingest.sessions.values()].some((s) => s.stored.some((e) => e.kind === "bridge_heartbeat")));
    const kinds = [...ingest.sessions.values()].flatMap((s) => s.stored.map((e) => e.kind));
    expect(kinds).not.toContain("slim_status");
    expect(existsSync(path.join(stateDir, "engine-bridge", `${REPO}.detail.jsonl`))).toBe(false);
  }, 90_000);

  it("stops the bridge with the program: SIGTERM ends it cleanly and the socket is gone", async () => {
    child!.kill("SIGTERM");
    expect(await childExit).toBe(0);
    expect(existsSync(path.join(xdg, "fx-runner", "engine-bridge.sock"))).toBe(false);
  }, 60_000);
});
