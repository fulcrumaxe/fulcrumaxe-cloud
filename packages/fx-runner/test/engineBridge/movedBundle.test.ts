import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Spec criterion 7: the bridge works from its built output moved to another directory. The bridge is built the way the runner's own release is (one esbuild bundle of
 * `src/**` with the workspace packages inlined), the bundle is moved to a new directory, and a fresh Node process runs it there: it starts the bridge for an enabled repo
 * against a stand-in cloud (a `fetch` that answers the pull and the upload), reads the engine's manifest version, tails the events file and uploads it. Nothing it needs
 * may be found by a path from the place it was built: no `import.meta.url`, no `__dirname`, no file read from beside the bundle.
 */
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "engineBridgeBundleEntry.ts");
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

// The driver runs in its own directory, away from the bundle, and takes the bundle's path as its one argument.
const DRIVER = `
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const bundle = await import(pathToFileURL(process.argv[2]).href);
const root = mkdtempSync(path.join(tmpdir(), "fx-eb3c-moved-"));
const runner = path.join(root, "runner");
const stateDir = path.join(root, "engine-state");
const repoRoot = path.join(root, "repo");
for (const d of [runner, stateDir]) mkdirSync(d, { mode: 0o700 });
mkdirSync(path.join(repoRoot, "engine"), { recursive: true });
writeFileSync(path.join(repoRoot, "engine", "manifest.json"), JSON.stringify({ engine_version: "4.5.6" }));
writeFileSync(path.join(stateDir, "engine-events.jsonl"), JSON.stringify({ v: 1, engine_instance_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10", seq: 0, ts: "2026-11-16T15:00:00.000Z", kind: "loop_tick", origin: "cron", duration_s: 5 }) + "\\n", { mode: 0o600 });
bundle.saveBridgeSettings(runner, [{ repo_gh_id: 77, full_name: "acme/widgets", state_dir: stateDir, repo_root: repoRoot }]);
const sent = [];
const key = bundle.generateRunnerKey();
const fetchFn = async (url, init) => {
  const body = JSON.parse(String(init.body));
  if (String(url).endsWith("/commands/pull")) return new Response(JSON.stringify({ commands: [], controls: [], allowed_repos: [{ repo_gh_id: 77, full_name: "acme/widgets" }] }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("{}", { status: 404 });
};
const cloud = { origin: "http://127.0.0.1:9", key, now: () => new Date(), fetchFn };
const ports = {
  halt: { handleControl: async () => undefined, readHostHandle: () => undefined, readHaltState: () => undefined },
  ceiling: { create: () => ({ run: async () => undefined, controlsChanged: () => undefined, status: () => null }) },
};
const bridge = bundle.startEngineBridge({
  runnerStateDir: runner, uid: process.getuid?.(), clock: bundle.realClock, runnerVersion: "0.1.1", cloud, keyring: {}, runnerId: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a11",
  send: async (message) => { sent.push(message.session.engine_version + ":" + message.events.map((e) => e.seq + e.kind).join(",")); return { kind: "accepted", last: message.events.at(-1).seq }; },
  wakeEpoch: () => null, accepted: () => true, xdgRuntimeDir: undefined, secrets: () => [], ports, log: () => undefined, superviseMs: 50,
});
const deadline = Date.now() + 8000;
while (Date.now() < deadline && !(sent.some((s) => s.startsWith("4.5.6:0loop_tick")) && bridge.status().repos[0]?.run === "running")) await new Promise((r) => setTimeout(r, 25));
const status = bridge.status();
await bridge.stop();
console.log(JSON.stringify({ sent, run: status.repos[0]?.run, upload: status.repos[0]?.upload?.state }));
process.exit(0);
`;

let root: string;
let built: string;
let moved: string;

function run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // An explicit environment: the child gets PATH and nothing else.
    execFile(process.execPath, [file, ...args], { env: { PATH: process.env.PATH ?? "" }, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr }));
  });
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fx-eb3c-bundle-"));
  built = path.join(root, "built");
  moved = path.join(root, "elsewhere", "deeper");
  mkdirSync(built);
  const result = await build({ entryPoints: [ENTRY], bundle: true, platform: "node", format: "esm", target: "node22", outfile: path.join(built, "bridge.mjs"), logLevel: "silent", write: true, absWorkingDir: root });
  expect(result.errors).toEqual([]);
  mkdirSync(moved, { recursive: true });
  cpSync(path.join(built, "bridge.mjs"), path.join(moved, "bridge.mjs"));
  // The place it was built is gone before it runs.
  rmSync(built, { recursive: true, force: true });
  mkdirSync(path.join(root, "driver"));
  writeFileSync(path.join(root, "driver", "driver.mjs"), DRIVER);
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the bridge from its built output, moved", () => {
  it("starts for an enabled repo, reads the manifest's version, tails the events file and uploads it, from a directory it was not built in", async () => {
    const out = await run(path.join(root, "driver", "driver.mjs"), [path.join(moved, "bridge.mjs")]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    const result = JSON.parse(out.stdout.trim().split("\n").at(-1)!) as { sent: string[]; run: string };
    expect(result.run).toBe("running");
    expect(result.sent).toContain("4.5.6:0loop_tick");
  }, 60_000);

  it("holds no path of the build machine and reads nothing from beside itself", () => {
    // Comments only name the source files the bundle was cut from (relative to where it was built); code holds no path of the build machine.
    const text = readFileSync(path.join(moved, "bridge.mjs"), "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    expect(text).not.toContain(root);
    expect(text).not.toContain(SRC);
    expect(readdirSync(moved)).toEqual(["bridge.mjs"]);
    // No absolute checkout or repository-root path either: the directory this source tree sits in, the workspace root above it, and the directory the test runs from.
    const checkout = path.resolve(SRC, "..", "..", "..");
    for (const place of [checkout, path.resolve(SRC, "..", ".."), path.resolve(SRC, ".."), process.cwd()]) {
      if (place === "/" || place === path.sep) continue;
      expect(text, place).not.toContain(place);
    }
  });

  it("is free of build-relative path reads in the bridge's own source", () => {
    for (const file of ["daemon.ts", "settings.ts", "engineVersion.ts"]) {
      const source = readFileSync(path.join(SRC, "engineBridge", file), "utf8");
      expect(source, file).not.toMatch(/import\.meta|__dirname|__filename|process\.cwd/);
    }
  });
});
