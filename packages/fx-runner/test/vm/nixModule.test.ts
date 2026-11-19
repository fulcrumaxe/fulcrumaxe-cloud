import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPinned, renderUnit, type Pinned, type UnitParams } from "../../src/vm/unitRender.js";
import { CONFIG_KEYS, HELPER_GROUP, LAYOUT, MODES } from "../../src/vm/installPlan.js";
import { cases, goldenUnit, pinnedFile as pinned } from "./helpers/unitCases.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../..");
const MODULE = readFileSync(join(ROOT, "nix/fx-vmhelper.nix"), "utf8");
const UNIT_NIX = join(ROOT, "nix/fx-vmhelper-unit.nix");
const UNIT_NIX_TEXT = readFileSync(UNIT_NIX, "utf8");

/** Evaluate the pure unit function with `nix-instantiate`, the pinned file passed in the environment. */
function nixUnit(p: unknown, u: UnitParams): string | undefined {
  const expr = `import ${UNIT_NIX} { pinned = builtins.fromJSON (builtins.getEnv "FX_PINNED"); helperPath = "${u.helperPath}"; configPath = "${u.configPath}"; jailRoot = "${u.jailRoot}"; snapshotDir = "${u.snapshotDir}"; group = "${u.group ?? ""}"; }`;
  const r = spawnSync("nix-instantiate", ["--eval", "--strict", "--raw", "--expr", expr], { encoding: "utf8", env: { ...process.env, FX_PINNED: JSON.stringify(p) } });
  if (r.error !== undefined) return undefined; // nix is not installed: the evaluation checks below skip, the text checks still run
  if (r.status !== 0) throw new Error(`nix-instantiate failed: ${r.stderr.slice(-600)}`);
  return r.stdout;
}
const hasNix = spawnSync("nix-instantiate", ["--version"], { encoding: "utf8", env: { ...process.env } }).status === 0;

describe("the NixOS module services.fx-vmhelper", () => {
  it("reads the pinned file and writes none of its values", () => {
    expect(MODULE).toContain("builtins.fromJSON (builtins.readFile ../packages/fx-runner/vmhelper/internal/hardening/hardening.json)");
    expect(MODULE).toContain("import ./fx-vmhelper-unit.nix");
    const values: string[] = [...Object.keys(pinned.directives), ...pinned.capabilities.map((c) => c.name), ...pinned.read_write_paths, pinned.runtime_directory_mode, pinned.state_directory_mode, pinned.socket_name];
    for (const v of Object.values(pinned.directives)) values.push(...(typeof v === "string" ? [v] : v));
    for (const text of [MODULE, UNIT_NIX_TEXT]) {
      for (const v of values.filter((x) => x.length >= 5)) expect(text, `restates "${v}"`).not.toContain(v);
    }
  });

  it("has options for the runner user, jail root, id ranges and capabilities, and the capabilities are read-only", () => {
    for (const o of ["runnerUser", "jailRoot", "uidFirst", "uidCount", "gidFirst", "gidCount", "maxSandboxes", "capabilities"]) expect(MODULE).toMatch(new RegExp(`\\b${o} = `));
    const start = MODULE.indexOf("capabilities = mkOption {");
    expect(start).toBeGreaterThan(-1);
    expect(MODULE.slice(start, MODULE.indexOf("\n    };", start))).toContain("readOnly = true;");
    expect(MODULE).toContain("mkIf cfg.enable");
  });

  it("makes the config a real file, not a symlink, because the helper opens it with O_NOFOLLOW", () => {
    expect(MODULE).toMatch(/environment\.etc\."fx-vmhelper\/config\.json" = \{\s*mode = "0444";\s*user = "root";\s*group = "root";/);
  });

  it.skipIf(!hasNix)("evaluates inside a real NixOS system: the unit equals the golden, the config has the 15 keys, the runner joins the group", () => {
    const r = spawnSync("nix", ["eval", "--impure", "--json", "--file", join(ROOT, "nix/tests/module-eval.nix")], { encoding: "utf8", env: { ...process.env }, timeout: 240_000 });
    if (r.status !== 0) throw new Error(`nix eval failed: ${r.stderr.slice(-600)}`);
    const out = JSON.parse(r.stdout) as { unit: string; config: Record<string, unknown>; extraGroups: string[]; capabilities: string[]; tmpfiles: string[]; assertionMessages: string[] };
    expect(out.unit).toBe(goldenUnit("with-group"));
    expect(Object.keys(out.config).sort()).toEqual([...CONFIG_KEYS].sort());
    expect(out.extraGroups).toEqual([HELPER_GROUP]);
    expect(out.tmpfiles).toContain(`d ${LAYOUT.jailRoot} ${MODES.jailRoot} root root -`);
    expect(out.tmpfiles).toContain(`d ${LAYOUT.snapshotDir} ${MODES.snapshotDir} root root -`);
    expect(out.assertionMessages).toEqual([]);
    expect(out.capabilities).toEqual(pinned.capabilities.map((c) => c.name));
  }, 260_000);

  it.skipIf(!hasNix)("a snapshot directory inside the jail root, or holding it, or equal to it, fails the system evaluation", () => {
    for (const bad of ["/var/lib/fx-vm/snaps", "/var/lib", "/var/lib/fx-vm"]) {
      const r = spawnSync("nix", ["eval", "--impure", "--json", "--file", join(ROOT, "nix/tests/module-eval.nix"), "toplevelDrv"], { encoding: "utf8", env: { ...process.env, FX_SNAPSHOT_DIR: bad, FX_TOPLEVEL: "1" }, timeout: 240_000 });
      expect(r.status, bad).not.toBe(0);
      expect(r.stderr, bad).toContain("snapshotDir must be outside jailRoot and must not hold it");
    }
    const ok = spawnSync("nix", ["eval", "--impure", "--json", "--file", join(ROOT, "nix/tests/module-eval.nix"), "toplevelDrv"], { encoding: "utf8", env: { ...process.env, FX_TOPLEVEL: "1" }, timeout: 240_000 });
    if (ok.status !== 0) throw new Error(`nix eval failed: ${ok.stderr.slice(-600)}`);
  }, 560_000);

  it.skipIf(!hasNix)("an empty runner group fails an assertion with a clear message, not an evaluation error", () => {
    const r = spawnSync("nix", ["eval", "--impure", "--json", "--file", join(ROOT, "nix/tests/module-eval.nix")], { encoding: "utf8", env: { ...process.env, FX_EMPTY_GROUP: "1" }, timeout: 240_000 });
    if (r.status !== 0) throw new Error(`nix eval failed: ${r.stderr.slice(-600)}`);
    const out = JSON.parse(r.stdout) as { assertionMessages: string[] };
    expect(out.assertionMessages.some((m) => m.includes("services.fx-vmhelper.runnerUser has no primary group"))).toBe(true);
  }, 260_000);

  it.skipIf(!hasNix)("generates, through nix-instantiate, the Go golden unit for every case", () => {
    for (const c of cases) expect(nixUnit(pinned, c.params)).toBe(goldenUnit(c.name));
  });

  it.skipIf(!hasNix)("follows the pinned file, not constants: a changed file gives the same text as the TypeScript renderer", () => {
    const changed: Pinned = {
      ...pinned,
      directives: { ...pinned.directives, ProtectSystem: "full", ExtraDirective: ["one", "two"] },
      capabilities: [...pinned.capabilities, { name: "CAP_FAKE", number: 63, reason: "test" }],
      read_write_paths: ["/sys/fs/cgroup", "/extra"],
    };
    const u = cases[0]!.params;
    const text = nixUnit(changed, u);
    expect(text).toBe(renderUnit(u, loadPinned(changed)));
    expect(text).toContain("ExtraDirective=two\n");
    expect(text).not.toBe(nixUnit(pinned, u));
  });

  it.skipIf(!hasNix)("refuses a parameter that could add a directive", () => {
    for (const bad of [{ ...cases[0]!.params, jailRoot: "/var/lib/a;b" }, { ...cases[0]!.params, jailRoot: "/var/../x" }, { ...cases[0]!.params, helperPath: "relative" }, { ...cases[0]!.params, group: "g%h" }, { ...cases[0]!.params, snapshotDir: "snaps" }, { ...cases[0]!.params, snapshotDir: "/var/../x" }, { ...cases[0]!.params, snapshotDir: "/var/a b" }, { ...cases[0]!.params, snapshotDir: "/var/a\nExecStartPre=/bin/sh" }, { ...cases[0]!.params, snapshotDir: "/var/a;b" }]) {
      expect(() => nixUnit(pinned, bad)).toThrow("unit parameters must be clean absolute paths");
    }
  });
});
