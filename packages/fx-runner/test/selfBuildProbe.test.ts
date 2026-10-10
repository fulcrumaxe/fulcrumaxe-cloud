import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { allowanceFloorViolation, parseAllowanceSet } from "@fulcrumaxe/runner-protocol";
import { CREDENTIAL_FLOOR } from "../src/sandbox/sandboxSettings.js";

/**
 * D#6 R7e: the self-build probe and this repo's allowance file. The probe's verdicts about a real sandbox come from the live run (docs/self-build-sandbox.md).
 * These tests run it with NO sandbox on a throwaway home, where every read leaks: they show it can fail, plants and removes exactly what it should, and never
 * prints a canary value. No network request is made.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "../scripts/self-build-probe.sh");
const ALLOWANCE_FILE = path.resolve(HERE, "../../../.fulcrumaxe/runner-sandbox.json");
const DOC = path.resolve(HERE, "../docs/self-build-sandbox.md");

const roots: string[] = [];
const envFor = (home: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, FX_PROBE_STATE: path.join(home, "state"), FX_PROBE_SYSTEM_DIR: path.join(home, "sys"), LC_ALL: "C" });
afterEach(() => {
  for (const root of roots.splice(0)) {
    spawnSync("bash", [SCRIPT, "unplant"], { env: envFor(root) });
    rmSync(root, { recursive: true, force: true });
  }
});

function rig(): { home: string; sh(args: string[]): { code: number | null; stdout: string; stderr: string } } {
  const home = mkdtempSync(path.join(tmpdir(), "fxprobe-"));
  roots.push(home);
  mkdirSync(path.join(home, "sys"));
  return {
    home,
    sh: (args) => {
      const r = spawnSync("bash", [SCRIPT, ...args], { env: envFor(home), cwd: home, encoding: "utf8", timeout: 60_000 });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

/** True when a process this test starts, under a name no other process has, is found by `pgrep -f` as the same user. The process is killed before this returns. */
function processesVisible(): boolean {
  const name = `fx-visibility-${randomBytes(8).toString("hex")}`;
  const child = spawn("bash", ["-c", "sleep 300; :", name], { stdio: "ignore", detached: true });
  try {
    spawnSync("sleep", ["0.3"]);
    return spawnSync("pgrep", ["-u", String(process.getuid?.() ?? 0), "-f", name]).status === 0;
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL"); // the whole group: the shell and its sleep
    } catch {
      child.kill("SIGKILL");
    }
  }
}

interface Report { step: string; summary: { fail: number }; checks: { id: string; result: string; detail: string }[] }
const result = (text: string, id: string): string | undefined => (JSON.parse(text) as Report).checks.find((check) => check.id === id)?.result;

describe("the probe, with no sandbox, on a throwaway home", () => {
  it("covers exactly the credential floor", () => {
    expect(rig().sh(["list-floor"]).stdout.trim().split("\n")).toEqual([...CREDENTIAL_FLOOR]);
  });

  it("plants, fails every read it should, prints no value, and unplant leaves the home as it was", () => {
    const { home, sh } = rig();
    const before = readdirSync(home).sort();
    const planted = sh(["plant"]);
    expect([planted.code, planted.stdout]).toEqual([0, ""]);
    const values = readFileSync(path.join(home, "state", "values"), "utf8").trim().split("\n");
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBeGreaterThanOrEqual(12); // nine directory locations and the three single-file locations, none of which exists here
    for (const value of values) expect(value).toMatch(/^FXPROBE-CANARY-[0-9a-f]{32}$/);
    expect(existsSync(path.join(home, ".config", "gh", "fx-probe-canary"))).toBe(true);
    expect(readFileSync(path.join(home, ".netrc"), "utf8").trim()).toMatch(/^FXPROBE-CANARY-/); // an absent file-type location is planted too
    const run = sh(["run", "--no-egress", "--no-nix"]);
    expect(result(run.stdout, "cred_read_ssh")).toBe("fail");
    expect(result(run.stdout, "write_home")).toBe("fail");
    expect(run.code).toBe(1);
    for (const value of values) expect(run.stdout + run.stderr).not.toContain(value);

    // verify sees what an unsandboxed run leaves behind: the probe file and the decoy process.
    const logFile = path.join(home, "run.log");
    writeFileSync(logFile, run.stdout);
    const verified = sh(["verify", logFile]);
    // Whether this process can see its own user's processes with pgrep is decided here, by the test and not by the probe, so a probe regression cannot widen the expectation.
    // Where they are visible (a developer machine, hosted CI) the decoy must be started and must be left. Only where they are not (a hardened service unit: a DynamicUser with
    // ProtectProc=invisible and PrivateUsers, as on the self-hosted CI runner) is "gone" the honest answer.
    const visible = processesVisible();
    if (!visible) console.log("[restricted] pgrep cannot see this user's own processes here: expecting the decoy not to be found");
    expect([result(run.stdout, "sentinel_started"), result(verified.stdout, "absent_home"), result(verified.stdout, "leftover_sentinel")]).toEqual(visible ? ["pass", "fail", "fail"] : ["inconclusive", "fail", "pass"]);
    expect([result(verified.stdout, "canary_intact_1"), result(verified.stdout, "log_run_log")]).toEqual(["pass", "pass"]);

    expect(sh(["unplant"]).code).toBe(0);
    expect(readdirSync(home).sort()).toEqual([...before, "run.log"].sort());
    expect(sh(["verify"]).code).toBe(2);
  });

  /** Every path under `root` with its content (files) or a marker (directories), so two snapshots can be compared exactly. */
  function snapshot(root: string, skip: string[] = []): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (skip.includes(full)) continue;
        if (name.isDirectory()) {
          out[full] = "<dir>";
          walk(full);
        } else out[full] = readFileSync(full, "utf8");
      }
    };
    walk(root);
    return out;
  }

  it("a plant that fails part way leaves nothing behind: no canary, no directory it made, no real file touched", () => {
    const { home, sh } = rig();
    // Real-looking content that must survive, and a stray canary in a location planted late in the loop (after .ssh, .aws, .config/gh, .kube, .docker, .gnupg).
    mkdirSync(path.join(home, ".ssh"));
    writeFileSync(path.join(home, ".ssh", "id_ed25519"), "REAL-KEY-MATERIAL\n");
    writeFileSync(path.join(home, ".netrc"), "machine example login real\n");
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude", "fx-probe-canary"), "stray\n");
    const before = snapshot(home);
    const planted = sh(["plant"]);
    expect(planted.code).toBe(2);
    expect(planted.stderr).toContain("already exists");
    expect(snapshot(home)).toEqual(before); // the home is exactly as it was: canaries, created directories and the state directory are gone
    expect(existsSync(path.join(home, "state"))).toBe(false);
  });

  it("plants an absent single-file location, leaves an existing one alone, and reports an empty one as not covered", () => {
    const { home, sh } = rig();
    writeFileSync(path.join(home, ".netrc"), "machine example login real\n"); // exists, non-empty: read as it is
    writeFileSync(path.join(home, ".npmrc"), ""); // exists but empty: a read of it proves nothing
    expect(sh(["plant"]).code).toBe(0);
    expect(readFileSync(path.join(home, ".netrc"), "utf8")).toBe("machine example login real\n");
    expect(readFileSync(path.join(home, ".claude.json"), "utf8")).toMatch(/^FXPROBE-CANARY-/);
    const verified = sh(["verify"]);
    expect(result(verified.stdout, "not_covered_npmrc")).toBe("inconclusive");
    expect(result(verified.stdout, "not_covered_netrc")).toBeUndefined();
    expect(sh(["unplant"]).code).toBe(0);
    expect(existsSync(path.join(home, ".claude.json"))).toBe(false);
    expect(readFileSync(path.join(home, ".netrc"), "utf8")).toBe("machine example login real\n");
    expect(readFileSync(path.join(home, ".npmrc"), "utf8")).toBe("");
  });

  it("never puts a domain from the allowance file into a check id", () => {
    const { home } = rig();
    const bin = path.join(home, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o755 }); // no network request is made
    const evil = 'bad"name\\';
    const r = spawnSync("bash", [SCRIPT, "run", "--no-nix"], { env: { ...envFor(home), PATH: `${bin}:${process.env.PATH ?? ""}`, FX_PROBE_ALLOWED_DOMAINS: evil }, cwd: home, encoding: "utf8", timeout: 60_000 });
    const report = JSON.parse(r.stdout) as Report;
    const bad = report.checks.filter((check) => check.detail === "domain_not_plain");
    expect(bad.map((check) => check.id)).toEqual(["egress_allowed_invalid_1"]);
    expect(r.stdout).not.toContain("bad");
  });

  it("verify fails a log that holds a canary value without printing it, and plant will not run twice", () => {
    const { home, sh } = rig();
    sh(["plant"]);
    const values = readFileSync(path.join(home, "state", "values"), "utf8").trim().split("\n");
    const leaky = path.join(home, "leaky.log");
    writeFileSync(leaky, `output\n${values[0]}\n`);
    const verified = sh(["verify", leaky]);
    expect(result(verified.stdout, "log_leaky_log")).toBe("fail");
    for (const value of values) expect(verified.stdout + verified.stderr).not.toContain(value);
    expect(sh(["plant"]).code).toBe(2);
  });
});

describe(".fulcrumaxe/runner-sandbox.json", () => {
  const file = JSON.parse(readFileSync(ALLOWANCE_FILE, "utf8")) as { entries: { kind: string; value: string; access: string }[]; command_timeout_s: number };

  it("is a set the protocol accepts, and no entry reaches the floor", () => {
    expect(parseAllowanceSet({ entries: file.entries, command_timeout_s: file.command_timeout_s }).ok).toBe(true);
    for (const entry of file.entries as Parameters<typeof allowanceFloorViolation>[0][]) expect(allowanceFloorViolation(entry)).toBeNull();
  });

  it("every entry is in the doc, and the doc lists none the file lacks", () => {
    const listed = [...readFileSync(DOC, "utf8").matchAll(/^### Allowance: `(path|domain|loopback)` `([^`]+)` `(read|write|connect|bind)`$/gm)].map((m) => `${m[1]} ${m[2]} ${m[3]}`).sort();
    expect(listed).toEqual(file.entries.map((entry) => `${entry.kind} ${entry.value} ${entry.access}`).sort());
  });
});
