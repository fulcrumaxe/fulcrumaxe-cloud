import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pnpmArgs } from "../src/daemon/depsInstall.js";
import { CHECK_PNPM_ENV } from "../src/sandbox/hostSandbox.js";

/**
 * The live stall of 10-24, reproduced with the real pnpm. The runner installs a job's dependencies on the host (with network, from the registry, into the repository's own
 * package store) and later runs the repository's check with no network, whose first step is a plain `pnpm install --frozen-lockfile` over that same tree. pnpm 11 starts that
 * install by checking the lockfile against its supply-chain policies (the minimum release age is on by default), which needs the registry's metadata for every package;
 * the check's cache holds none, so pnpm asks the registry, and with no network it waits and retries for minutes. These tests drive the very environment the check is given
 * (`HostSandbox.checkLaunch`) through a registry that counts what it is asked, so a regression shows as a request that was made, not as a slow test.
 *
 * The registry is a local HTTP server that serves what the real one does for what pnpm asks: the full packument with a publish time, a dist block with the tarball address,
 * integrity and shasum, and the tarball itself; it answers 404 to anything else.
 */
const probe = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 30_000 });
const major = probe.status === 0 ? Number(probe.stdout.trim().split(".")[0]) : 0;

const NAME = "fx-offline-demo";
const VERSION = "1.0.0";

let root: string;
let server: Server;
let origin: string;
let requests: string[] = [];
let tarball: Buffer;

function packumentFor(base: string): unknown {
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const shasum = createHash("sha1").update(tarball).digest("hex");
  return {
    name: NAME,
    "dist-tags": { latest: VERSION },
    time: { created: "2020-01-01T00:00:00.000Z", modified: "2020-01-01T00:00:00.000Z", [VERSION]: "2020-01-01T00:00:00.000Z" },
    versions: { [VERSION]: { name: NAME, version: VERSION, dist: { tarball: `${base}/${NAME}/-/${NAME}-${VERSION}.tgz`, integrity, shasum } } },
  };
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fx-offline-pnpm-"));
  const pkg = path.join(root, "pkg", "package");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: NAME, version: VERSION, main: "index.js" }));
  writeFileSync(path.join(pkg, "index.js"), "module.exports = 1;\n");
  const file = path.join(root, "demo.tgz");
  execFileSync("tar", ["-czf", file, "-C", path.join(root, "pkg"), "package"]);
  tarball = readFileSync(file);
  server = createServer((req, res) => {
    requests.push(`${req.method ?? ""} ${req.url ?? ""}`);
    if (req.method !== "GET") return void res.writeHead(405).end();
    if (req.url === `/${NAME}`) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packumentFor(origin)));
    if (req.url === `/${NAME}/-/${NAME}-${VERSION}.tgz`) return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(tarball);
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

/** The environment a pnpm run gets here: built from scratch, so nothing the test process itself runs under (a runner check's own offline setting, say) leaks in. */
function envFor(dirs: { home: string; cache: string }, extra: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: dirs.home, XDG_CACHE_HOME: dirs.cache, CI: "true", pnpm_config_registry: `${origin}/`, ...extra };
}

function pnpm(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** A project with one dependency, installed the way the runner installs on the host (its own `pnpmArgs`, network, the repository's store). */
async function installedProject(name: string): Promise<{ project: string; store: string; dirs: { home: string; cache: string } }> {
  const project = path.join(root, name, "project");
  const store = path.join(root, name, "store");
  const dirs = { home: path.join(root, name, "home"), cache: path.join(root, name, "xdg") };
  for (const dir of [project, store, dirs.home, dirs.cache, path.join(root, name, "host-cache")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "demo-app", version: "1.0.0", private: true, dependencies: { [NAME]: VERSION } }));
  writeFileSync(path.join(project, "pnpm-workspace.yaml"), "packages: []\n");
  const hostEnv = envFor(dirs, { pnpm_config_store_dir: store, pnpm_config_verify_store_integrity: "true" });
  const lock = await pnpm(["install", "--lockfile-only", `--registry=${origin}/`], hostEnv, project);
  expect(lock.code, lock.out).toBe(0);
  const host = await pnpm(pnpmArgs({ registry: `${origin}/`, storeDir: store, cacheDir: path.join(root, name, "host-cache") }), hostEnv, project);
  expect(host.code, host.out).toBe(0);
  expect(readFileSync(path.join(project, "node_modules", NAME, "index.js"), "utf8")).toContain("module.exports");
  return { project, store, dirs };
}

describe.skipIf(major < 11)("the check's plain `pnpm install --frozen-lockfile` over the tree the runner installed", () => {
  it("control: with the check's cache empty and no fix, pnpm goes back to the registry for metadata (the request that waits forever with no network)", async () => {
    const { project, store, dirs } = await installedProject("control");
    requests = [];
    // The check gets a fresh, empty cache (its own temp directory); the store is the repository's. Retries off, so the control ends at once.
    const checkEnv = envFor({ home: dirs.home, cache: path.join(root, "control", "check-cache") }, { pnpm_config_store_dir: store, pnpm_config_verify_store_integrity: "true", pnpm_config_fetch_retries: "0" });
    const o = await pnpm(["install", "--frozen-lockfile"], checkEnv, project);
    expect(o.out).toContain("supply-chain");
    expect(requests.filter((line) => line.startsWith("GET"))).not.toEqual([]);
  });

  it("with the environment the check is given, it makes no request at all and succeeds", async () => {
    const { project, store, dirs } = await installedProject("fixed");
    requests = [];
    const given = CHECK_PNPM_ENV;
    const checkEnv = envFor({ home: dirs.home, cache: path.join(root, "fixed", "check-cache") }, { ...given, pnpm_config_store_dir: store, pnpm_config_verify_store_integrity: "true" });
    const out = await pnpm(["install", "--frozen-lockfile"], checkEnv, project);
    expect(out.code, out.out).toBe(0);
    expect(requests).toEqual([]);
  });

  it("an install that does need a package the store lacks fails at once and names the cause, instead of waiting", async () => {
    const { project, dirs } = await installedProject("missing");
    requests = [];
    // A store the install did not use: the package is in node_modules' virtual store only through the store, so removing node_modules and pointing at an empty store needs a download.
    rmSync(path.join(project, "node_modules"), { recursive: true, force: true });
    const emptyStore = path.join(root, "missing", "empty-store");
    mkdirSync(emptyStore, { recursive: true });
    const checkEnv = envFor({ home: dirs.home, cache: path.join(root, "missing", "check-cache") }, { ...CHECK_PNPM_ENV, pnpm_config_store_dir: emptyStore, pnpm_config_verify_store_integrity: "true" });
    const started = Date.now();
    const out = await pnpm(["install", "--frozen-lockfile"], checkEnv, project);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(out.code).not.toBe(0);
    expect(out.out).toMatch(/ERR_PNPM_NO_OFFLINE/);
    expect(requests).toEqual([]);
  });
});
