import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SANDBOX_UNAVAILABLE_REASONS } from "@fulcrumaxe/runner-protocol";
import { vmClaimBlock, vmLimitsBlock } from "../../src/commands/run.js";
import { CliError } from "../../src/cliError.js";
import { MICROVM_UNAVAILABLE_REASONS, RESTART_LINE, UNWIRED_LINE, reasonChangeLine, selectSandbox } from "../../src/vm/engineGate.js";
import { engineMismatchClaimBlock, unwiredClaimBlock } from "../../src/vm/limits.js";
import { ENGINE_LOOP_MINUTES_KEY, SETTINGS_FILE, SETTINGS_UNREADABLE_MESSAGE, VERIFY_TEST_ACCOUNT_KEY, loadSettings, setSetting, unsetSetting } from "../../src/runnerSettings.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";

const runSource = readFileSync(path.join(PACKAGE_DIR, "src", "commands", "run.ts"), "utf8");

describe("run.ts chooses its engine from the machine, and the constant cannot come back (criterion 1)", () => {
  it("no constant choice, no bare host-facts read, no empty inventory source", () => {
    expect(runSource).not.toMatch(/chooseEngine\(\s*undefined\s*,\s*false\s*\)/);
    expect(runSource).not.toMatch(/chooseEngine\(\s*undefined/);
    expect(runSource).not.toMatch(/readHostFacts\(\s*\)/);
    expect(runSource).not.toContain("emptyInventorySource");
  });

  it("the choice is made from the engine line and from whether the live stack was composed", () => {
    expect(runSource).toMatch(/chooseEngine\(engineLineOf\(/);
    expect(runSource).toMatch(/createLiveMicrovm\(host\.microvm, stateDir\)/); // this runner's own state directory makes the id marker startup reaping reads back (FU-177)
  });

  it("the sandbox port is picked in one place, and a microvm engine with a throwing port never touches the OS port", () => {
    const calls: string[] = [];
    const osPort = { createSandbox: () => void calls.push("os") };
    const vmPort = {
      createSandbox: () => {
        throw new Error("boot refused");
      },
    };
    const picked = selectSandbox("microvm", { os_sandbox: osPort, microvm: vmPort });
    expect(picked).toBe(vmPort);
    expect(() => picked.createSandbox()).toThrow("boot refused");
    expect(calls).toEqual([]);
    expect(() => selectSandbox("microvm", { os_sandbox: osPort })).toThrow();
    expect(calls).toEqual([]);
    expect(runSource.match(/selectSandbox\(/g)).toHaveLength(1);
  });
});

describe("the engine mismatch claim block: the setting is read at every claim, the run's engine was chosen once", () => {
  it("a live microvm setting with a run engine that is not microvm blocks (unwired build: microvm_build_unwired; wired: microvm_restart_needed); nothing else does", () => {
    expect(engineMismatchClaimBlock("microvm", "os_sandbox", false)).toBe("microvm_build_unwired");
    expect(engineMismatchClaimBlock("microvm", "os_sandbox", true)).toBe("microvm_restart_needed");
    for (const wired of [true, false]) expect(engineMismatchClaimBlock("microvm", "microvm", wired), String(wired)).toBeUndefined();
    for (const live of ["os_sandbox", "invalid"] as const) for (const run of ["os_sandbox", "microvm"] as const) for (const wired of [true, false]) expect(engineMismatchClaimBlock(live, run, wired), `${live}/${run}/${String(wired)}`).toBeUndefined();
  });

  it("is local only, like the unwired block: not a member of the protocol's closed set, and it has its own words", () => {
    expect(SANDBOX_UNAVAILABLE_REASONS as readonly string[]).not.toContain("microvm_restart_needed");
    expect(RESTART_LINE).toContain("microvm_restart_needed");
    expect(RESTART_LINE).toContain("OS sandbox is not used");
  });
});

describe("the microvm_build_unwired claim block (local only)", () => {
  it("applies to microvm on a build that is not wired, and to nothing else", () => {
    expect(unwiredClaimBlock("microvm", false)).toBe("microvm_build_unwired");
    expect(unwiredClaimBlock("microvm", true)).toBeUndefined();
    for (const engine of ["os_sandbox", "invalid"] as const) for (const wired of [true, false]) expect(unwiredClaimBlock(engine, wired), `${engine}/${String(wired)}`).toBeUndefined();
  });

  it("is never a reason the cloud can be sent: the protocol's closed set does not contain it", () => {
    expect(SANDBOX_UNAVAILABLE_REASONS as readonly string[]).not.toContain("microvm_build_unwired");
    expect(UNWIRED_LINE).toContain("microvm_build_unwired");
    expect(UNWIRED_LINE).toContain("OS sandbox is not used");
  });
});

describe("settings that cannot be read fail closed (criterion 3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fxr-unreadable-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = (): string => path.join(dir, SETTINGS_FILE);

  it("a missing file is not an error: os_sandbox, nothing blocked", () => {
    expect(loadSettings(dir).unreadable).toBeUndefined();
    expect(vmLimitsBlock(dir)).toBeUndefined();
    expect(vmClaimBlock(dir, "os_sandbox", false)).toBeUndefined();
  });

  it("an unparseable file, a file that is not an object, an oversized file and a non-regular file each block with engine_setting_invalid, whatever the old value said", () => {
    const cases: Array<[string, () => void]> = [
      ["garbage", () => writeFileSync(file(), "{not json")],
      ["truncated", () => writeFileSync(file(), '{"sandboxEngine":"microvm","ceilingTotal":')],
      ["null", () => writeFileSync(file(), "null")],
      ["array", () => writeFileSync(file(), "[]")],
      ["number", () => writeFileSync(file(), "7")],
      ["oversized", () => writeFileSync(file(), `{"sandboxEngine":"os_sandbox","pad":"${"x".repeat(2 * 1024 * 1024)}"}`)],
      ["directory", () => mkdirSync(file())],
      ["symlink", () => (writeFileSync(path.join(dir, "real.json"), "{}"), symlinkSync(path.join(dir, "real.json"), file()))],
    ];
    for (const [name, make] of cases) {
      rmSync(file(), { recursive: true, force: true });
      make();
      expect(loadSettings(dir).unreadable, name).toBe(true);
      expect(vmLimitsBlock(dir), name).toBe("engine_setting_invalid");
      expect(vmClaimBlock(dir, "os_sandbox", true), name).toBe("engine_setting_invalid");
      expect(vmClaimBlock(dir, "microvm", true), name).toBe("engine_setting_invalid");
    }
  });

  it("a readable file is not flagged, and the flag is never written back", () => {
    setSetting(dir, "sandbox_engine", "os_sandbox");
    expect(loadSettings(dir).unreadable).toBeUndefined();
    setSetting(dir, "reserve-gb", "4");
    expect(readFileSync(file(), "utf8")).not.toContain("unreadable");
    expect(loadSettings(dir).unreadable).toBeUndefined();
  });

  // An unreadable file is never replaced by defaults: that would turn a microvm runner into an os_sandbox one the person never chose.
  const writers: Array<[string, (d: string) => unknown]> = [
    ["a plain limit", (d) => setSetting(d, "reserve-gb", "4")],
    ["a plain limit, cleared", (d) => unsetSetting(d, "reserve-gb")],
    ["`auto`", (d) => setSetting(d, "reserve-gb", "auto")],
    ["a microvm limit", (d) => setSetting(d, "microvm.max_vms", "2")],
    ["a microvm limit, cleared", (d) => unsetSetting(d, "microvm.max_vms")],
    ["the engine, cleared", (d) => unsetSetting(d, "sandbox_engine")],
    ["a verify value", (d) => setSetting(d, VERIFY_TEST_ACCOUNT_KEY, "someone@example.test")],
    ["a verify value, cleared", (d) => unsetSetting(d, VERIFY_TEST_ACCOUNT_KEY)],
    ["an engine host value", (d) => setSetting(d, ENGINE_LOOP_MINUTES_KEY, "30")],
    ["an engine host value, cleared", (d) => unsetSetting(d, ENGINE_LOOP_MINUTES_KEY)],
  ];
  it.each(writers)("%s: refused while the file cannot be read, with one fixed message, and the file is left exactly as it was", (_name, write) => {
    const damaged = '{"sandboxEngine":"microvm","microvm":{"maxVms":2},';
    writeFileSync(file(), damaged);
    let message = "";
    try {
      write(dir);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      message = (error as CliError).message;
    }
    expect(message).toBe(SETTINGS_UNREADABLE_MESSAGE);
    expect(message).not.toContain(dir);
    expect(readFileSync(file(), "utf8")).toBe(damaged);
  });

  it("an explicit `config set sandbox_engine` is the way out: it replaces the damaged file, and claiming follows the engine chosen", () => {
    writeFileSync(file(), "{not json");
    expect(vmLimitsBlock(dir)).toBe("engine_setting_invalid");
    setSetting(dir, "sandbox_engine", "os_sandbox");
    expect(loadSettings(dir).unreadable).toBeUndefined();
    expect(loadSettings(dir).sandboxEngine).toBe("os_sandbox");
    expect(vmLimitsBlock(dir)).toBeUndefined();
    writeFileSync(file(), "[]");
    setSetting(dir, "sandbox_engine", "microvm");
    expect(loadSettings(dir).sandboxEngine).toBe("microvm");
    expect(vmLimitsBlock(dir)).toBe("microvm_limits_missing");
  });

  it("the file is read without following a link, judged by the open handle: a link to a good file, a directory and a FIFO are unreadable, and a FIFO does not hang the read", () => {
    writeFileSync(path.join(dir, "real.json"), '{"reserveGb":4}');
    symlinkSync(path.join(dir, "real.json"), file());
    expect(loadSettings(dir).unreadable).toBe(true);
    rmSync(file());
    mkdirSync(file());
    expect(loadSettings(dir).unreadable).toBe(true);
    rmSync(file(), { recursive: true });
    execFileSync("mkfifo", [file()]);
    expect(loadSettings(dir).unreadable).toBe(true);
    rmSync(file());
    writeFileSync(file(), '{"reserveGb":4}');
    expect(loadSettings(dir)).toMatchObject({ reserveGb: 4 });
    expect(loadSettings(dir).unreadable).toBeUndefined();
  });

  it("the unwired block comes after the limits blocks: microvm with every limit set on an unwired build is microvm_build_unwired, on a wired one nothing", () => {
    setSetting(dir, "sandbox_engine", "microvm");
    expect(vmClaimBlock(dir, "os_sandbox", false)).toBe("microvm_limits_missing");
    for (const [key, value] of [["microvm.max_vms", "2"], ["microvm.max_vcpus", "4"], ["microvm.max_memory_mb", "4096"], ["microvm.snapshot_dir", "/srv/fx/snaps"], ["microvm.snapshot_quota_bytes", "8589934592"]] as const) setSetting(dir, key, value);
    expect(vmLimitsBlock(dir)).toBeUndefined();
    expect(vmClaimBlock(dir, "os_sandbox", false)).toBe("microvm_build_unwired");
    expect(vmClaimBlock(dir, "os_sandbox", true)).toBe("microvm_restart_needed");
    expect(vmClaimBlock(dir, "microvm", true)).toBeUndefined();
    setSetting(dir, "sandbox_engine", "os_sandbox");
    expect(vmClaimBlock(dir, "os_sandbox", false)).toBeUndefined();
  });
});

describe("the mid-run wording is closed, one sentence per reason (criterion 9)", () => {
  it("every reason in the protocol's set has a line that names it, and no microvm_* line describes a bubblewrap or user-namespace problem", () => {
    for (const reason of SANDBOX_UNAVAILABLE_REASONS) {
      const line = reasonChangeLine(reason);
      expect(line, reason).toContain(reason);
      expect(line, reason).toContain("fx-runner doctor");
      if (reason.startsWith("microvm_")) {
        expect(line, reason).not.toMatch(/bubblewrap|bwrap|socat|namespace|userns|AppArmor|sandbox does not work/i);
        expect(line, reason).toContain("microVM");
        expect(line, reason).toContain("OS sandbox is not used");
      } else {
        expect(line, reason).toBe(`fx-runner: the sandbox does not work on this machine (${reason}); no job will be claimed. Run: fx-runner doctor`);
      }
    }
  });

  it("the four microvm_* lines are each different, the four codes are exactly the protocol's microvm_ ones, and a back-to-working change is one fixed line", () => {
    const lines = MICROVM_UNAVAILABLE_REASONS.map((reason) => reasonChangeLine(reason));
    expect(new Set(lines).size).toBe(4);
    expect([...MICROVM_UNAVAILABLE_REASONS].sort()).toEqual(SANDBOX_UNAVAILABLE_REASONS.filter((r) => r.startsWith("microvm_")).sort());
    expect(reasonChangeLine(undefined)).toBe("fx-runner: the sandbox works again; claiming jobs");
  });

  it("run.ts says every reason change through that one function", () => {
    expect(runSource).toContain("ctx.out(reasonChangeLine(reason))");
  });
});

describe("the docs say what is true (criterion 8)", () => {
  const docs = readFileSync(path.join(PACKAGE_DIR, "..", "..", "docs", "packages", "runner.md"), "utf8");
  it("the old sentence is gone and the unwired state is named", () => {
    expect(docs).not.toMatch(/not wired into `fx-runner run` yet/);
    expect(docs).toContain("microvm_build_unwired");
    expect(docs).toContain("never runs a job in the OS sandbox instead");
  });
  it("the package README never carried the old sentence either", () => {
    expect(readFileSync(path.join(PACKAGE_DIR, "README.md"), "utf8")).not.toMatch(/not wired into `fx-runner run` yet/);
  });
});
