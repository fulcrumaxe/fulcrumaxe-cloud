import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import { CONFIG_KEYS, HELPER_GROUP, LAYOUT, MODES, PARSER_BOUNDS, buildInstallPlan, defaultLimits, firstFreeBlock, renderCreateList, renderRemoveList, uninstallList, type HostFacts } from "../../src/vm/installPlan.js";
import { renderUnit } from "../../src/vm/unitRender.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VMHELPER = join(HERE, "../../vmhelper");
const CONFIG_GOLDEN = join(VMHELPER, "internal/config/testdata/install-plan.json");
const LIST_GOLDEN = join(HERE, "fixtures/create-list.txt");
const REMOVE_GOLDEN = join(HERE, "fixtures/remove-list.txt");

// An ordinary desktop: 8 CPUs, 16 GiB, a typical subuid block at 100000, and the runner at 1000.
const FACTS: HostFacts = {
  cpus: 8,
  memTotalKb: 16 * 1024 * 1024,
  smallestTemplateRamMb: 512,
  runner: { user: "alice", uid: 1000, gid: 1000 },
  takenUids: [{ first: 0, count: 1001 }, { first: 100000, count: 65536 }],
  takenGids: [{ first: 0, count: 1001 }, { first: 100000, count: 65536 }],
};

/** UPDATE_GOLDEN=1 rewrites the checked-in files from the plan; a plain run only compares. */
function golden(file: string, text: string): string {
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, text);
  return readFileSync(file, "utf8");
}

describe("the install plan", () => {
  const plan = buildInstallPlan(FACTS);

  it("writes all 15 keys the helper's config requires, no more, in a file the Go parser accepts", () => {
    const go = readFileSync(join(VMHELPER, "internal/config/config.go"), "utf8");
    const goKeys = /var keys = \[\]string\{([^}]*)\}/.exec(go)![1]!.split(",").map((k) => k.trim().replace(/"/g, ""));
    expect(goKeys).toHaveLength(15);
    expect([...CONFIG_KEYS]).toEqual(goKeys);
    expect(Object.keys(JSON.parse(plan.config.text) as object)).toEqual(goKeys);
    // The same file is parsed by config.Parse in internal/config/plan_config_test.go.
    expect(plan.config.text).toBe(golden(CONFIG_GOLDEN, plan.config.text));
  });

  it("sets the Correction 10 defaults: CPUs, 75% of MemTotal, min(8, memory / smallest template)", () => {
    const cfg = JSON.parse(plan.config.text) as Record<string, number>;
    expect(cfg.max_vcpus).toBe(8);
    expect(cfg.max_mem_mb).toBe(12288);
    expect(cfg.max_sandboxes).toBe(8);
    expect(defaultLimits({ cpus: 2, memTotalKb: 4 * 1024 * 1024, smallestTemplateRamMb: 1024 })).toEqual({ max_vcpus: 2, max_mem_mb: 3072, max_sandboxes: 3 });
    expect(() => defaultLimits({ cpus: 4, memTotalKb: 512 * 1024, smallestTemplateRamMb: 512 })).toThrow("too little memory");
    expect(() => defaultLimits({ cpus: 0, memTotalKb: 1, smallestTemplateRamMb: 1 })).toThrow(CliError);
  });

  it("takes the sandbox ranges from the first free block at or above 100000, past every taken id and the runner", () => {
    expect(plan.uidRange).toEqual({ first: 165536, count: 8 });
    expect(plan.gidRange).toEqual({ first: 165536, count: 8 });
    expect(firstFreeBlock([], 4)).toEqual({ first: 100000, count: 4 });
    expect(firstFreeBlock([{ first: 100000, count: 2 }, { first: 100005, count: 1 }], 4)).toEqual({ first: 100006, count: 4 });
    expect(firstFreeBlock([{ first: 100003, count: 1 }], 4)).toEqual({ first: 100004, count: 4 });
    expect(firstFreeBlock([{ first: 100000, count: 4 }], 4)).toEqual({ first: 100004, count: 4 });
    const high = buildInstallPlan({ ...FACTS, runner: { user: "alice", uid: 100000, gid: 100000 }, takenUids: [], takenGids: [] });
    expect(high.uidRange.first).toBe(100001);
    expect(() => firstFreeBlock([{ first: 100000, count: 2 ** 32 - 100000 - 2 }], 8)).toThrow("no free id block");
  });

  it("renders the unit from the pinned file with the helper's own group", () => {
    expect(plan.unit.text).toBe(renderUnit({ helperPath: LAYOUT.helperBinary, configPath: LAYOUT.configFile, jailRoot: LAYOUT.jailRoot, snapshotDir: LAYOUT.snapshotDir, group: HELPER_GROUP }));
    expect(plan.unit.text).toContain(`Group=${HELPER_GROUP}\n`);
    expect(plan.unit.text).toContain(`ExecStart=${LAYOUT.helperBinary} -config ${LAYOUT.configFile}\n`);
    expect(plan.unit.text).toContain(`ReadWritePaths=/sys/fs/cgroup ${LAYOUT.jailRoot} ${LAYOUT.snapshotDir}\n`);
  });

  it("is a pure function of its facts: planning twice gives the same plan", () => {
    expect(buildInstallPlan(FACTS)).toEqual(plan);
  });

  it("prints the create list first, from the one list that uninstall reverses (golden)", () => {
    expect(`${renderCreateList(plan.createList).join("\n")}\n`).toBe(golden(LIST_GOLDEN, `${renderCreateList(plan.createList).join("\n")}\n`));
    expect(`${renderRemoveList(plan).join("\n")}\n`).toBe(golden(REMOVE_GOLDEN, `${renderRemoveList(plan).join("\n")}\n`));
    expect(uninstallList(plan)).toEqual([...plan.createList].reverse());
    expect(uninstallList(plan)).toHaveLength(plan.createList.length);
    const targets = plan.createList.map((i) => i.target);
    for (const t of [HELPER_GROUP, LAYOUT.helperDir, LAYOUT.configFile, LAYOUT.unitFile, LAYOUT.jailRoot, "/run/fx-vmhelper", "/var/lib/fx-vmhelper"]) expect(targets).toContain(t);
    // The helper's own root-only snapshot store is on the list; the runner's user-owned snapshot directory (a runner setting) never is.
    expect(targets.filter((t) => t.includes("snapshot"))).toEqual([LAYOUT.snapshotDir]);
  });

  it("gives every path item an owner and mode: the jail root is root 0711 as the helper requires, nothing is group or world writable", () => {
    const go = readFileSync(join(VMHELPER, "internal/sandbox/sandbox.go"), "utf8");
    expect(/RootMode\s+os\.FileMode = 0o(\d+)/.exec(go)![1]).toBe(MODES.jailRoot.slice(1));
    const by = (t: string) => plan.createList.find((i) => i.target === t)!;
    expect([by(LAYOUT.jailRoot).owner, by(LAYOUT.jailRoot).mode]).toEqual(["root:root", "0711"]);
    expect([by(LAYOUT.snapshotDir).owner, by(LAYOUT.snapshotDir).mode]).toEqual(["root:root", "0700"]);
    // config.Parse: snapshot_dir lies outside jail_root and does not hold it.
    expect((LAYOUT.snapshotDir as string) === LAYOUT.jailRoot || LAYOUT.snapshotDir.startsWith(`${LAYOUT.jailRoot}/`) || LAYOUT.jailRoot.startsWith(`${LAYOUT.snapshotDir}/`)).toBe(false);
    expect([by(LAYOUT.configFile).owner, by(LAYOUT.configFile).mode]).toEqual(["root:root", "0600"]);
    expect([by(LAYOUT.unitFile).owner, by(LAYOUT.unitFile).mode]).toEqual(["root:root", "0644"]);
    for (const d of [LAYOUT.helperDir, LAYOUT.configDir]) expect([by(d).owner, by(d).mode]).toEqual(["root:root", "0755"]);
    expect(by("/run/fx-vmhelper").owner).toBe(`root:${HELPER_GROUP}`);
    expect(by(HELPER_GROUP).system).toBe(true);
    for (const i of plan.createList) {
      if (["directory", "file", "unit"].includes(i.kind)) expect(parseInt(i.mode, 8) & 0o022, `${i.target} is group or world writable`).toBe(0);
      else expect(i.mode).toBe("-");
    }
    expect(renderCreateList(plan.createList).join("\n")).toContain("/var/lib/fx-vm  root:root 0711");
  });

  it("keeps the limits inside what config.Parse accepts, on any host", () => {
    const go = readFileSync(join(VMHELPER, "internal/config/config.go"), "utf8");
    expect(go).toContain(`c.MaxSandboxes < 1 || c.MaxSandboxes > ${PARSER_BOUNDS.max_sandboxes}, c.MaxVCPUs < 1 || c.MaxVCPUs > ${PARSER_BOUNDS.max_vcpus}, c.MaxMemMB < 1 || c.MaxMemMB > 1<<20`);
    expect(PARSER_BOUNDS.max_mem_mb).toBe(1 << 20);
    const big = buildInstallPlan({ ...FACTS, cpus: 128, memTotalKb: 2 * 1024 ** 3 });
    expect(big.limits).toEqual({ max_vcpus: 64, max_mem_mb: 1048576, max_sandboxes: 8 });
    // The Go parser reads this same file in internal/config/plan_config_test.go.
    expect(big.config.text).toBe(golden(join(VMHELPER, "internal/config/testdata/install-plan-big-host.json"), big.config.text));
  });

  it("refuses unusable facts with exit 2 and no plan", () => {
    const bad = (f: Partial<HostFacts>): void => {
      try {
        buildInstallPlan({ ...FACTS, ...f });
        throw new Error("a plan was returned");
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        expect((e as CliError).exitCode).toBe(2);
      }
    };
    bad({ runner: { user: "root", uid: 0, gid: 0 } });
    bad({ runner: { user: "alice", uid: 1000, gid: 0 } });
    bad({ runner: { user: "alice", uid: 0, gid: 1000 } });
    bad({ runner: { user: "al ice;", uid: 1000, gid: 1000 } });
    bad({ cpus: 0 });
  });
});
