import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandboxedPurge, purgeChildEnv } from "../../src/daemon/resumePurgeSandbox.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { testLaunch } from "../helpers/launch.js";

let root: string;
let ws: string;
let outside: string;
let state: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "fxr-purgemac-")));
  ws = path.join(root, "ws");
  outside = path.join(root, "outside");
  state = path.join(root, "state");
  for (const dir of [ws, outside, state]) mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (base: string, rel: string, text = "x"): void => {
  mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  writeFileSync(path.join(base, rel), text);
};
const exists = (target: string): boolean => {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

/** The program as a user runs it: bin/fx-runner.mjs bundled to one file. import.meta.url is defined as the bundle's own URL, which bin/fx-runner.mjs reads for scriptPath(). */
function bundleRunner(): string {
  const bundle = path.join(state, "fx-runner.cjs");
  buildSync({ entryPoints: [path.join(__dirname, "..", "..", "bin", "fx-runner.mjs")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle, logLevel: "silent", define: { "import.meta.url": JSON.stringify(pathToFileURL(bundle).href), __FX_BUILD_EPOCH__: '"0"' } });
  return bundle;
}

// Any platform: the same bundle run as the child with the parent's exact environment, without sandbox-exec, so the bundling and the child's start-up cannot break unseen on Linux CI.
describe("the bundled __purge child (no sandbox)", () => {
  it("exits 0 with the parent's exact child environment and removes the listed build output", () => {
    const bundle = bundleRunner();
    put(ws, "dist/a.js");
    put(ws, "node_modules/p/i.js");
    const list = path.join(state, "list");
    writeFileSync(list, "dist/", { mode: 0o600 });
    const out = execFileSync(process.execPath, [...process.execArgv, bundle, "__purge", list, ws], { env: purgeChildEnv(state), encoding: "utf8" });
    expect(out).toBe("1 1\n");
    expect(exists(path.join(ws, "dist"))).toBe(false);
    expect(exists(path.join(ws, "node_modules/p/i.js"))).toBe(true);
  });
});

// Real Seatbelt and the real program: macOS only. CI is Linux, so this is skipped there; the Team Lead runs it on a Mac session.
describe.skipIf(process.platform !== "darwin")("createSandboxedPurge end to end (macOS)", () => {
  it("starts the real __purge child under sandbox-exec with the parent's exact environment: removes build output, keeps the rest, never follows a link out", async () => {
    const bundle = bundleRunner();
    put(ws, "dist/a.js");
    put(ws, "node_modules/p/i.js");
    put(ws, ".git/HEAD");
    put(outside, "victim", "keep me");
    symlinkSync(outside, path.join(ws, "swapped"));
    const purge = createSandboxedPurge({
      capture: (command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs),
      selfCommand: [process.execPath, ...process.execArgv, bundle],
      stateDir: state,
      isFile: (target) => existsSync(target),
    });
    expect(await purge(ws, ["dist/", "swapped/victim", "swapped"])).toEqual({ files: 2, dirs: 1 });
    expect(exists(path.join(ws, "dist"))).toBe(false);
    expect(exists(path.join(ws, "swapped"))).toBe(false); // the link itself goes
    expect(readFileSync(path.join(outside, "victim"), "utf8")).toBe("keep me");
    expect(exists(path.join(ws, "node_modules/p/i.js"))).toBe(true);
    expect(exists(path.join(ws, ".git/HEAD"))).toBe(true);
  });
});
