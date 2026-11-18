import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { INTEROP_ENTRY_NAMES, interopEntryPresent, type WslMachine } from "../src/sandbox/platform.js";
import { createSandboxHost } from "../src/sandbox/probeHost.js";
import { clearWsl } from "../src/sandbox/wslGate.js";

/** Real WSL2 only: FX_REAL_WSL=1 on a WSL2 machine set up as the README says. Everywhere else this file is skipped, and nothing in the other tests needs WSL. */
describe.skipIf(process.env.FX_REAL_WSL !== "1")("the WSL2 gate on a real WSL2 machine", () => {
  const run = async (command: string, args: readonly string[], env: Record<string, string>) => {
    const out = spawnSync(command, [...args], { env, encoding: "utf8", timeout: 10_000 });
    return { code: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "", timedOut: out.error !== undefined };
  };
  const machine = (): WslMachine => ({
    // Both entry names, as the runner's own entry point reads them.
    interopEntry: () => interopEntryPresent((name) => lstatSync(`/proc/sys/fs/binfmt_misc/${name}`)),
    mountinfo: () => readFileSync("/proc/self/mountinfo", "utf8"),
  });
  const facts = (wsl: WslMachine) => {
    const home = process.env.HOME ?? "";
    return { platform: "linux" as const, osrelease: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(), home, stateDir: `${home}/.fx-runner`, binaryPath: undefined, xdgCacheHome: undefined, searchPath: cleanEnv({ mode: "subscription" }).PATH ?? "", host: createSandboxHost(run, wsl) };
  };

  it("names both interop entries", () => {
    expect(INTEROP_ENTRY_NAMES).toEqual(["WSLInterop", "WSLInterop-late"]);
  });

  it("clears a machine set up as the README says", async () => {
    const result = await clearWsl(facts(machine()));
    expect(result.items.filter((item) => !item.ok)).toEqual([]);
    expect(result.cleared).toBe(true);
  });

  it("refuses the same machine when an interop entry is reported present, and leaves no clearance", async () => {
    const wsl = { ...machine(), interopEntry: () => true };
    const result = await clearWsl(facts(wsl));
    expect(result.cleared).toBe(false);
    expect(result.items.find((item) => item.code === "wsl_interop_enabled")?.ok).toBe(false);
    expect(wsl.clearance).toBeUndefined();
  });
});
