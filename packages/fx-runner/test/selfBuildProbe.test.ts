import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("unplant ignores a manifest directory that was never created", () => {
    const { home, sh } = rig();
    const before = readdirSync(home).sort();
    expect(sh(["plant"]).code).toBe(0);
    const neverMade = path.join(home, ".never-made", "deep");
    writeFileSync(path.join(home, "state", "manifest"), `dir\t${neverMade}\n`, { flag: "a" });
    const unplanted = sh(["unplant"]);
    expect(unplanted.code).toBe(0);
    expect(unplanted.stderr).not.toContain(`left ${neverMade}`);
    expect(existsSync(neverMade)).toBe(false);
    expect(existsSync(path.join(home, "state"))).toBe(false);
    expect(readdirSync(home).sort()).toEqual(before);
  });

  it("unplant reports a directory it cannot remove", () => {
    const { home, sh } = rig();
    expect(sh(["plant"]).code).toBe(0);
    const kube = path.join(home, ".kube");
    writeFileSync(path.join(kube, "extra"), "stray\n");
    const unplanted = sh(["unplant"]);
    expect(unplanted.code).toBe(0);
    expect(unplanted.stderr).toContain(`probe: left ${kube} (not empty)`);
  });

  it("a directory made just before a signal is still removed", () => {
    const { home } = rig();
    const bin = path.join(home, "bin");
    mkdirSync(bin);
    let realMkdir = "";
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(dir, "mkdir");
      if (existsSync(candidate)) { realMkdir = candidate; break; }
    }
    expect(realMkdir).not.toBe("");
    writeFileSync(
      path.join(bin, "mkdir"),
      `#!/bin/sh\n"${realMkdir}" "$@"\nrc=$?\nfor a in "$@"; do\n  if [ "$a" = "-m" ]; then kill -TERM "$PPID"; break; fi\ndone\nexit "$rc"\n`,
      { mode: 0o755 },
    );
    const r = spawnSync("bash", [SCRIPT, "plant"], { env: { ...envFor(home), PATH: `${bin}:${process.env.PATH ?? ""}` }, cwd: home, encoding: "utf8", timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(home, ".ssh"))).toBe(false);
    expect(existsSync(path.join(home, "state"))).toBe(false);
  });

  /** A bin directory holding only the named tools (found on this PATH), plus any extra executable scripts: a stand-in for a hardened service unit's thin PATH. */
  function thinPath(home: string, tools: string[], extra: Record<string, string> = {}): string {
    const bin = path.join(home, "thin-bin");
    mkdirSync(bin);
    for (const tool of tools) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found === "") throw new Error(`test host lacks ${tool}`);
      symlinkSync(found, path.join(bin, tool));
    }
    for (const [name, body] of Object.entries(extra)) writeFileSync(path.join(bin, name), body, { mode: 0o755 });
    return bin;
  }
  // What plant, run and unplant call, and no awk, curl or shasum: the self-hosted CI unit's PATH.
  const TOOLS = ["bash", "sh", "mkdir", "rmdir", "rm", "od", "tr", "dirname", "id", "grep", "sed", "cut", "sort", "cat", "ls", "wc", "sleep", "uname", "kill", "mktemp", "head", "tail", "true", "false", "env", "date", "cp", "mv", "chmod", "tee"];
  const present = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

  it("plants and unplants with no awk on PATH, leaving the home as it was", () => {
    const { home } = rig();
    const before = readdirSync(home).sort();
    const bin = thinPath(home, TOOLS.filter(present));
    const env = { ...envFor(home), PATH: bin };
    expect(spawnSync("bash", [SCRIPT, "plant"], { env, cwd: home, encoding: "utf8" }).status).toBe(0);
    const unplanted = spawnSync("bash", [SCRIPT, "unplant"], { env, cwd: home, encoding: "utf8" });
    expect([unplanted.status, unplanted.stderr]).toEqual([0, ""]);
    expect(readdirSync(home).sort()).toEqual([...before, "thin-bin"].sort());
  });

  it("unplant says which tool is missing and exits non-zero rather than half cleaning", () => {
    const { home } = rig();
    const bin = thinPath(home, TOOLS.filter((tool) => present(tool) && tool !== "sort"));
    const env = { ...envFor(home), PATH: bin };
    const unplanted = spawnSync("bash", [SCRIPT, "unplant"], { env, cwd: home, encoding: "utf8" });
    expect(unplanted.status).toBe(3);
    expect(unplanted.stderr).toContain("probe: unplant cannot run, missing tool(s): sort");
  });

  it("the process-table scan only considers processes owned by this user", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const fn = /^proc_is_ours\(\) \{.*\}$/m.exec(source)?.[0];
    expect(fn).toBeDefined();
    const check = (dir: string): number | null => spawnSync("bash", ["-c", `${fn}\nproc_is_ours "$1"`, "bash", dir]).status;
    expect(check("/proc/self")).toBe(0); // our own process directory
    if ((process.getuid?.() ?? 0) !== 0) expect(check("/proc/1")).toBe(1); // init is root's: refused for anyone else
    // Order matters: the ownership test comes before the kill, inside the scan.
    const scan = /^kill_decoys\(\) \{[\s\S]*?^\}/m.exec(source)?.[0] ?? "";
    expect(scan.indexOf('proc_is_ours "$d" || continue')).toBeGreaterThan(-1);
    expect(scan.indexOf('proc_is_ours "$d" || continue')).toBeLessThan(scan.indexOf("kill -KILL"));
  });

  it("reading the command line of a process that has just exited is silent, so unplant's stderr stays empty on a busy host", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const fn = /^proc_cmdline\(\) \{.*\}$/m.exec(source)?.[0];
    expect(fn).toBeDefined();
    // A directory with no cmdline is what a process that exited between the readable test and the read looks like.
    const gone = spawnSync("bash", ["-c", `${fn}\nproc_cmdline "$1"`, "bash", path.join(tmpdir(), "fx-probe-no-such-process")], { encoding: "utf8" });
    expect([gone.status !== 0, gone.stderr]).toEqual([true, ""]);
    // The decoy scan goes through it, so the race cannot reach stderr.
    expect(/^kill_decoys\(\) \{[\s\S]*?^\}/m.exec(source)?.[0]).toContain('cmd="$(proc_cmdline "$d")"');
    // One that is there still reads, NULs turned into spaces.
    const { home } = rig();
    writeFileSync(path.join(home, "cmdline"), "a\0b\0");
    const live = spawnSync("bash", ["-c", `${fn}\nproc_cmdline "$1"`, "bash", home], { encoding: "utf8" });
    expect([live.status, live.stdout, live.stderr]).toEqual([0, "a b ", ""]);
  });

  it("unplant still ends the decoy and removes everything when pgrep and pkill see no process (ProtectProc=invisible)", () => {
    const { home, sh } = rig();
    const before = readdirSync(home).sort();
    const blind = "#!/bin/sh\nexit 1\n"; // what pgrep and pkill answer when /proc hides this user's processes
    const bin = thinPath(home, TOOLS.filter(present), { pgrep: blind, pkill: blind });
    const env = { ...envFor(home), PATH: bin };
    expect(sh(["plant"]).code).toBe(0);
    // The decoy, named exactly as the probe names it.
    const decoy = spawn("bash", ["-c", "exec -a 'postgres: fx-probe-sentinel' bash -c 'while :; do sleep 30; done'"], { stdio: "ignore", detached: true, env: { PATH: process.env.PATH } });
    try {
      spawnSync("sleep", ["0.5"]);
      expect(spawnSync("bash", [SCRIPT, "run", "--no-egress", "--no-nix"], { env, cwd: home, encoding: "utf8", timeout: 60_000 }).stdout).toContain('"sentinel_started","item":8,"expect":"started","result":"inconclusive"');
      const unplanted = spawnSync("bash", [SCRIPT, "unplant"], { env, cwd: home, encoding: "utf8" });
      expect(unplanted.status).toBe(0);
      spawnSync("sleep", ["0.5"]);
      // Gone (or a zombie awaiting this test's wait): ended by the /proc scan, not by pgrep or pkill, which were blind.
      let state = "";
      try { state = readFileSync(`/proc/${decoy.pid!}/stat`, "utf8").replace(/^.*\) /, "")[0] ?? ""; } catch { /* no such process */ }
      expect(["", "Z"]).toContain(state);
      expect(readdirSync(home).sort()).toEqual([...before, "thin-bin"].sort());
    } finally {
      try { process.kill(-decoy.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
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
