import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeArgv } from "../../src/engines/claude/argv.js";
import { confineFileTools } from "../../src/engines/claude/filePermissions.js";
import { mcpConfigFor, writeJobFiles } from "../../src/engines/claude/settingsFile.js";
import { roleToolsFor } from "../../src/job/roleTools.js";
import { cleanEnv, type CredentialMode } from "../../src/job/cleanEnv.js";
import { CREDENTIAL_FLOOR, canGrantRead, protectedPaths, sandboxSettings } from "../../src/sandbox/sandboxSettings.js";
import { FakeMessagesApi, type ScriptedCall } from "./fakeMessagesApi.js";

/** D#587 B-10: the read-deny canary matrix. Everything the CLI is started with comes from the production builders. */

export const KEYCHAIN_ITEMS = ["fx-canary", "Claude Code-credentials"] as const;
const FLOOR_FILES: ReadonlySet<string> = new Set([".netrc", ".npmrc", ".claude.json"]);
const rand = (): string => randomBytes(6).toString("hex");
const sq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export interface Layout {
  home: string; base: string; stateDir: string; binaryDir: string; workspaceRoot: string; tempRoot: string; mirrorsRoot: string;
  workspace: string; tempDir: string; jobDir: string; ownObjects: string; configDir: string; out: string;
}
/** A planted secret. `deny` is the one protected entry that covers it (undefined: nothing in the production profile names it). */
export interface Sentinel { id: string; file: string; text: string; deny?: string; floor?: string; info?: true }

export function buildLayout(home: string, tmp: string, out: string): Layout {
  const base = path.join(home, "fx-matrix");
  const tempRoot = path.join(tmp, "fx-matrix-tmp");
  const workspaceRoot = path.join(base, "work");
  const mirrorsRoot = path.join(base, "mirrors");
  return {
    home, base, tempRoot, workspaceRoot, mirrorsRoot, out, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(home, ".local/share/fx-runner-bin"),
    workspace: path.join(workspaceRoot, "job"), tempDir: path.join(tempRoot, "job"), jobDir: path.join(base, "jobdir"),
    ownObjects: path.join(mirrorsRoot, "own.git/objects"), configDir: path.join(base, "cli-config"),
  };
}

/** Writes one sentinel at every protected place the spec lists. Returns them; the caller owns cleanup. */
export function plant(layout: Layout, platform: NodeJS.Platform): Sentinel[] {
  const { home } = layout;
  const make = (id: string, file: string, deny?: string, floor?: string): Sentinel => {
    const s = { id, file, text: `FXSENT-${id}-${rand()}`, deny, floor };
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${s.text}\n`);
    return s;
  };
  const dirFile = (dir: string): string => path.join(dir, `fx-s-${rand()}`);
  const list = [
    ...CREDENTIAL_FLOOR.map((e) => make(e.replace(/[^a-z]+/gi, "_").replace(/^_/, ""), FLOOR_FILES.has(e) ? path.join(home, e) : dirFile(path.join(home, e)), path.join(home, e), e)),
    make("state", dirFile(layout.stateDir), layout.stateDir),
    make("binary", dirFile(layout.binaryDir), layout.binaryDir),
    make("sibling_workspace", dirFile(path.join(layout.workspaceRoot, "sibling")), layout.workspaceRoot),
    make("sibling_temp", dirFile(path.join(layout.tempRoot, "sibling")), layout.tempRoot),
    make("other_mirror", dirFile(path.join(layout.mirrorsRoot, "other.git/objects")), layout.mirrorsRoot),
  ];
  if (platform === "darwin") list.push(make("users_shared", dirFile("/Users/Shared")));
  // Not named by the production profile. Read and reported, never judged: it shows what the CLI's own profile leaves open or closed.
  const info = (id: string, file: string, text?: string): Sentinel => (text === undefined ? { ...make(id, file), info: true } : { id, file, text, info: true });
  list.push(info("ambient_tmp", path.join(platform === "darwin" ? "/private/tmp" : "/tmp", `fx-b10-${rand()}`)), info("ambient_home", path.join(home, "Documents", `fx-b10-${rand()}`)), info("ambient_etc_hosts", "/etc/hosts", "localhost"));
  return list;
}

/** One request to the scripted model, and what a pass looks like for it. */
export interface Probe { call: ScriptedCall; channel: string; sentinel: string; needle: string; expect: "denied" | "found"; info?: true }
export type Verdict = "denied" | "found" | "unanswered";

const bash = (id: string, command: string): ScriptedCall => ({ id, name: "Bash", input: { command, description: "canary probe" } });

/**
 * The other spellings of a sentinel's path that macOS makes available: the volume and temp aliases and, for a home directory
 * entry, its upper-case form (the default volume is case-insensitive, so `~/.SSH` is `~/.ssh`). Darwin only.
 */
export function variants(layout: Layout, s: Sentinel, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {};
  if (platform !== "darwin") return out;
  if (s.file.startsWith("/Users/")) out.alias_data_volume = `/System/Volumes/Data${s.file}`;
  if (s.file.startsWith("/var/")) out.alias_private_var = `/private${s.file}`;
  if (s.floor?.startsWith(".") && !FLOOR_FILES.has(s.floor) && s.file.startsWith(layout.home)) {
    out.case_variant = path.join(layout.home, s.floor.toUpperCase(), path.relative(path.join(layout.home, s.floor), s.file));
  }
  return out;
}

/**
 * The files the Bash probes run through. The CLI's own permission layer refuses a command that names a path outside the working
 * directory, before any shell starts, so a probe that put the path in its command would test that layer and never the OS sandbox.
 * These probes name only `probe.sh`; the path comes from `targets.tsv` inside the workspace, so the command reaches the shell
 * and the OS sandbox is what answers. One `direct_cat` probe per sentinel keeps the permission layer's answer on record too.
 */
export function writeHarnessFiles(layout: Layout, sentinels: readonly Sentinel[], platform: NodeJS.Platform): void {
  const rows = [["own_mirror", path.join(layout.ownObjects, "readable")], ...sentinels.flatMap((s) => [[s.id, s.file], ...Object.entries(variants(layout, s, platform)).map(([name, p]) => [`${s.id}:${name}`, p])])];
  writeFileSync(path.join(layout.workspace, "targets.tsv"), `${rows.map((r) => r.join("\t")).join("\n")}\n`);
  writeFileSync(path.join(layout.workspace, "probe.sh"), PROBE_SH);
  writeFileSync(path.join(layout.workspace, "bench.json"), JSON.stringify({ true: ["/usr/bin/true"], node: [process.execPath, "-e", "0"] }));
  writeFileSync(path.join(layout.workspace, "bench.py"), BENCH_PY);
}
const PROBE_SH = `#!/bin/bash
mode=$1; id=$2
p=$(awk -F'\\t' -v id="$id" '$1==id{print $2}' targets.tsv)
case "$mode" in
  cat) cat "$p" ;;
  python) python3 -c 'import sys; print(open(sys.argv[1]).read())' "$p" ;;
  symlink) ln -s "$p" "ln-$id" && cat "ln-$id" ;;
  hardlink) ln "$p" "hl-$id" && cat "hl-$id" ;;
esac
`;
/** Times N process starts of a command named in bench.json and prints the median and mean, the same line from inside or outside the sandbox. */
const BENCH_PY = `import json, statistics, subprocess, sys, time
name, n = sys.argv[1], int(sys.argv[2])
cmd = json.load(open("bench.json"))[name]
t = []
for _ in range(n):
    s = time.perf_counter()
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t.append((time.perf_counter() - s) * 1000)
print("BENCH", name, n, round(statistics.median(t), 1), round(statistics.mean(t), 1))
`;
export const benchProbes = (): Probe[] => [["true", 30], ["node", 15]].map(([name, n]) => ({ channel: `bench_${name}`, sentinel: "bench", needle: "BENCH", expect: "found" as const, call: bash(`toolu_bench_${name}`, `python3 bench.py ${name} ${n}`) }));

/** The probes of a run as two steps: step 2 reads, with a file tool, the links that step 1 planted with Bash. */
export function probeSteps(layout: Layout, sentinels: readonly Sentinel[], platform: NodeJS.Platform, keychainTexts: readonly string[] = []): Probe[][] {
  const steps: Probe[][] = [[], []];
  const add = (step: 0 | 1, s: { id: string; text: string; info?: true }, channel: string, call: ScriptedCall, needle = s.text, expect: Probe["expect"] = "denied"): void => {
    steps[step]!.push({ call: { ...call, id: `toolu_${s.id}_${channel}` }, channel, sentinel: s.id, needle, expect, ...("info" in s ? { info: true as const } : {}) });
  };
  for (const s of sentinels) {
    if (s.info) {
      add(0, s, "bash_cat", bash("", `bash ./probe.sh cat ${s.id}`));
      continue;
    }
    const dir = path.dirname(s.file);
    add(0, s, "direct_cat", bash("", `cat ${sq(s.file)}`));
    for (const mode of ["cat", "python", "symlink", "hardlink"]) add(0, s, mode === "cat" ? "bash_cat" : mode === "python" ? "python_open" : `${mode}_bash`, bash("", `bash ./probe.sh ${mode} ${s.id}`));
    for (const name of Object.keys(variants(layout, s, platform))) add(0, s, name, bash("", `bash ./probe.sh cat ${s.id}:${name}`));
    add(0, s, "read_tool", { id: "", name: "Read", input: { file_path: s.file } });
    add(0, s, "grep_tool", { id: "", name: "Grep", input: { pattern: "FXSENT", path: s.file, output_mode: "content" } });
    // A directory entry is also searched as a directory, the way the helper behind Grep walks a tree.
    if (dir === s.deny) add(0, s, "grep_dir_tool", { id: "", name: "Grep", input: { pattern: "FXSENT", path: dir, output_mode: "content" } });
    // Not for the three single-file entries: the tool lists a file by walking every directory under the one it is given (the home
    // directory), and ripgrep gives up after 20 s even unsandboxed, which would make the control hollow.
    if (s.floor === undefined || !FLOOR_FILES.has(s.floor)) add(0, s, "glob_tool", { id: "", name: "Glob", input: { pattern: "fx-s-*", path: dir } }, path.basename(s.file));
    add(1, s, "symlink_read_tool", { id: "", name: "Read", input: { file_path: path.join(layout.workspace, `ln-${s.id}`) } });
    add(1, s, "hardlink_read_tool", { id: "", name: "Read", input: { file_path: path.join(layout.workspace, `hl-${s.id}`) } });
  }
  keychainTexts.forEach((text, i) => add(0, { id: `keychain${i}`, text }, "keychain_find", bash("", `security find-generic-password -s ${sq(KEYCHAIN_ITEMS[i]!)} -w`)));
  const pos = { id: "positive", text: "FXPOS-workspace" };
  add(0, pos, "bash_workspace", bash("", "cat readable.txt"), pos.text, "found");
  add(0, { id: "positive_mirror", text: "FXPOS-mirror" }, "bash_own_mirror", bash("", "bash ./probe.sh cat own_mirror"), "FXPOS-mirror", "found");
  // Information only: whether `git` can start under the profile (it reads the global config in the home directory first).
  add(0, { id: "git_global_config", text: "FXDONE", info: true }, "git_config", bash("", "git config --global --list 2>&1 | head -n 3; echo FXDONE"), "FXDONE", "found");
  add(0, pos, "read_workspace", { id: "", name: "Read", input: { file_path: path.join(layout.workspace, "readable.txt") } }, pos.text, "found");
  return steps;
}

/** Puts one generic password in the login keychain for each name in `KEYCHAIN_ITEMS`. Returns the secrets, or throws when `security` cannot. */
export function plantKeychain(): string[] {
  return KEYCHAIN_ITEMS.map((item, i) => {
    const text = `FXSENT-keychain${i}-${rand()}`;
    const r = spawnSync("security", ["add-generic-password", "-a", "fx-canary", "-s", item, "-w", text, "-U"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`security add-generic-password failed: ${r.stderr}`);
    return text;
  });
}

export function judge(probe: Probe, api: FakeMessagesApi): Verdict {
  const result = api.results.get(probe.call.id);
  if (result === undefined) return "unanswered";
  return result.text.includes(probe.needle) ? "found" : "denied";
}
/** A probe passes when it ended as it should: denied for a secret, found for a positive control. */
export const passes = (probe: Probe, verdict: Verdict): boolean => probe.info === true || verdict === probe.expect;

/** Every place a secret may not appear, searched for every needle. Returns `where: label` for each hit (never the value). */
export function scanForNeedles(places: Record<string, string>, needles: readonly string[]): string[] {
  return Object.entries(places).flatMap(([where, text]) => needles.filter((n) => text.includes(n)).map((n) => `${where}: ${n.split("-")[1] ?? "?"}`));
}
export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const file = path.join(d, name);
      const st = statSync(file);
      if (st.isDirectory()) walk(file);
      else if (st.size < 20_000_000) out[file] = readFileSync(file, "utf8");
    }
  };
  walk(dir);
  return out;
}

export interface ProductionConfig { argv: string[]; sandbox: Record<string, unknown> }
/**
 * The settings file and argument list a job starts with, from the production builders. A mutation run passes `keep`: every
 * protected entry it rejects is left out of the one protected list (so out of the sandbox block and the file-tool rules alike),
 * and the rule that blocks reads outside the working directory is switched off, because the CLI's own profile would otherwise
 * still hide everything under the user directories and no single entry could be shown to matter.
 */
export function productionConfig(layout: Layout, keep?: (entry: string) => boolean): ProductionConfig {
  const { home, stateDir, binaryDir } = layout;
  const prefix = path.dirname(path.dirname(process.execPath));
  const built = sandboxSettings({
    workspace: layout.workspace, tempDir: layout.tempDir, home, stateDir, binaryDir, workspaceRoot: layout.workspaceRoot, tempRoot: layout.tempRoot,
    mirrorsRoot: layout.mirrorsRoot, extraReadPaths: [layout.ownObjects], toolchainReadPaths: canGrantRead(prefix, { home, stateDir, binaryDir }) ? [prefix] : [],
  });
  const fsBlock = built.filesystem as Record<string, string[]>;
  const creds = built.credentials as { files: Array<{ path: string }> };
  const sandbox = keep === undefined ? built : { ...built, filesystem: { ...fsBlock, denyRead: fsBlock.denyRead!.filter(keep) }, credentials: { ...creds, files: creds.files.filter((f) => keep(f.path)) } };
  const listed = protectedPaths({ home, stateDir, binaryDir });
  const protectedList = keep === undefined ? listed : { noAccess: listed.noAccess.filter(keep), noEdit: listed.noEdit.filter(keep) };
  const roleTools = roleToolsFor("executor");
  const { settingsPath, mcpPath } = writeJobFiles(layout.jobDir, layout.workspace, "executor", sandbox, protectedList);
  if (keep !== undefined) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { permissions: Record<string, unknown> };
    settings.permissions.blockReadsOutsideWorkingDirectories = false;
    writeFileSync(settingsPath, JSON.stringify(settings));
  }
  return { sandbox, argv: claudeArgv({ cliModel: "sonnet", roleTools, allowRules: confineFileTools(roleTools, layout.workspace), settingsPath, mcpPath }) };
}

/** The same argument list with the sandbox off and every file tool allowed: the unsandboxed control. */
export function controlConfig(layout: Layout): string[] {
  const roleTools = roleToolsFor("executor");
  const allow = ["Bash", "Read", "Grep", "Glob"];
  const settingsPath = path.join(layout.jobDir, "control-settings.json");
  mkdirSync(layout.jobDir, { recursive: true });
  const mcpPath = path.join(layout.jobDir, "control-mcp.json");
  writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true, permissions: { defaultMode: "dontAsk", allow }, sandbox: { enabled: false } }));
  writeFileSync(mcpPath, JSON.stringify(mcpConfigFor({ role: "executor" })));
  return claudeArgv({ cliModel: "sonnet", roleTools, allowRules: allow, settingsPath, mcpPath });
}

export interface CliRun { stdout: string; stderr: string; code: number | null; timedOut: boolean; init: Record<string, unknown> | undefined }

/** Starts the CLI like a job: clean environment from `cleanEnv`, plus the test-only base URL, config directory and quiet switches. */
export async function runCli(opts: { bin: string; argv: string[]; layout: Layout; baseUrl: string; mode: CredentialMode; timeoutMs: number; wrap?: string[]; extraEnv?: Record<string, string> }): Promise<CliRun> {
  const env = {
    ...cleanEnv(opts.mode, { jobEnv: { TMPDIR: opts.layout.tempDir } }),
    ANTHROPIC_BASE_URL: opts.baseUrl, CLAUDE_CONFIG_DIR: opts.layout.configDir, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...opts.extraEnv,
  };
  mkdirSync(opts.layout.configDir, { recursive: true });
  const [cmd, ...pre] = opts.wrap ?? [opts.bin];
  const child = spawn(cmd!, [...pre, ...(opts.wrap === undefined ? [] : [opts.bin]), ...opts.argv], { cwd: opts.layout.workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  child.stdin.on("error", () => undefined);
  child.stdin.end("Run the scripted probes.\n");
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), opts.timeoutMs);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return { stdout, stderr, code, timedOut, init: initLine(stdout) };
}

export function initLine(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split("\n")) {
    try {
      const m = JSON.parse(line) as Record<string, unknown>;
      if (m.type === "system" && m.subtype === "init") return m;
    } catch {
      // fx-swallow-ok: not every line of the stream is JSON; only the init line matters here
    }
  }
  return undefined;
}

/** Plays `steps` against a fresh fake API and runs the CLI once. */
export async function play(steps: readonly (readonly Probe[])[], run: Omit<Parameters<typeof runCli>[0], "baseUrl"> & { unsandboxed?: true }): Promise<{ api: FakeMessagesApi; cli: CliRun }> {
  for (const name of readdirSync(run.layout.workspace)) if (/^(ln|hl)-/.test(name)) rmSync(path.join(run.layout.workspace, name), { force: true });
  const api = new FakeMessagesApi(steps.filter((s) => s.length > 0).map((s) => s.map((p) => p.call)));
  const baseUrl = await api.start();
  try {
    // On Linux the runner's env switch CLAUDE_CODE_SUBPROCESS_ENV_SCRUB runs every Bash command in a bubblewrap of its own, whatever the
    // settings file says (seen on the hosted runner: a read-only bind of the home directory, so a hard link out of it fails with EXDEV).
    // The unsandboxed control turns it off, or it would not be unsandboxed.
    const extraEnv = run.unsandboxed === true && process.platform === "linux" ? { ...run.extraEnv, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0" } : run.extraEnv;
    return { api, cli: await runCli({ ...run, extraEnv, baseUrl }) };
  } finally {
    await api.stop();
  }
}
