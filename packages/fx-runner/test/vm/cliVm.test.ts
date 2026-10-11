import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { vmBuildHost } from "../../scripts/vm-host.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `fx-runner vm ...` through runCli with the same host bin/fx-runner.mjs hands it: the real crane/tar/mke2fs starter. */
async function run(argv: string[], vmHost: Parameters<typeof runCli>[0]["vmHost"] | null = vmBuildHost): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli({ argv, home: undefined, stateDirOverride: "/nonexistent/fx-state", vmHost: vmHost ?? undefined, stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

describe("fx-runner vm, through the command line", () => {
  it("`vm build-image --help` prints the usage and exits 0 without starting any program", async () => {
    const calls: string[] = [];
    const r = await run(["vm", "build-image", "--help"], { run: async (file) => (calls.push(file), { code: 1, output: "" }) });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toContain("usage: fx-runner vm build-image --template fx-agent --image <repository@sha256:...> --out <dir>");
    expect(calls).toEqual([]);
  });

  it("the top-level help lists the command", async () => {
    expect((await run(["--help"])).out).toMatch(/\n {2}vm build-image --template fx-agent/);
  });

  it("a bad use exits 2 with the usage, through the real host and before any program runs", async () => {
    for (const argv of [["vm"], ["vm", "other"], ["vm", "build-image"], ["vm", "build-image", "--template", "fx-agent", "--image", "registry.example/x:latest", "--out", "/nonexistent/out"]]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toMatch(/^fx-runner: /);
    }
  });

  it("runs only from the program: without a host it says so", async () => {
    const r = await run(["vm", "build-image", "--help"], null);
    expect(r.code).toBe(1);
    expect(r.err).toContain("vm is only available from the fx-runner program");
  });

  it("bin/fx-runner.mjs hands the CLI that host", () => {
    const bin = readFileSync(path.join(PACKAGE_DIR, "bin", "fx-runner.mjs"), "utf8");
    expect(bin).toContain('import { vmBuildHost } from "../scripts/vm-host.mjs";');
    expect(bin).toMatch(/vmHost: vmBuildHost,/);
  });
});
