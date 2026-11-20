import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * D#587 B-9c: `scripts/wsl2-proof.sh` is the proof that runs inside a real WSL2 distribution (started by `.github/workflows/wsl2-proof.yml`). Nothing here
 * needs WSL: each case runs the real script in a throwaway checkout and HOME with stub tools first on PATH, and checks the rows and the verdict it records.
 * What the stubs cannot show (a real kernel, real bubblewrap, the real gate) is what the hosted run is for; the script's own rule is that a gate or matrix
 * run that skipped its tests is a failure, so a stub that prints "skipped" must turn the verdict to NO.
 */
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/wsl2-proof.sh");
const WSL_KERNEL = "6.18.33.2-microsoft-standard-WSL2";
const PASS_LINE = " Test Files  1 passed (1)\n      Tests  3 passed (3)\n";

const STUBS: Record<string, string> = {
  uname: 'echo "$STUB_KERNEL"',
  id: 'echo "${STUB_UID:-1000}"',
  bwrap: 'echo "bubblewrap 0.9.0"',
  socat: 'echo "socat version 1.8.0.0 on Jan 1 2026"',
  git: "exit 0",
  node: 'echo "v${STUB_NODE:-24.11.0}"',
  corepack: "exit 0",
  npm: 'echo "$@" >> "$STUB_LOG_DIR/npm.txt"; exit "${STUB_NPM_RC:-0}"',
  curl: `out=""; while [ $# -gt 0 ]; do if [ "$1" = --output ]; then out="$2"; fi; shift; done
printf '%s' "$STUB_CURL_BODY" > "$out"; exit "\${STUB_CURL_RC:-0}"`,
  pnpm: `case "$1" in
  --version) echo 11.0.0 ;;
  install) exit "\${STUB_INSTALL_RC:-0}" ;;
  exec)
    case "$4" in
      test/wslGate.real.test.ts) echo "FX_REAL_WSL=$FX_REAL_WSL" > "$STUB_LOG_DIR/gate-env.txt"; printf '%b' "$STUB_GATE_OUT"; exit "\${STUB_GATE_RC:-0}" ;;
      test/canary) echo "FX_B10=$FX_B10 FX_B10_CHECK=$FX_B10_CHECK" > "$STUB_LOG_DIR/canary-env.txt"; printf '%b' "$STUB_CANARY_OUT"; exit "\${STUB_CANARY_RC:-0}" ;;
    esac ;;
esac`,
};

/** The system tools the script itself uses. The case's PATH holds the stubs and links to exactly these, so a tool the script needs and the host lacks, or a stub left out, shows. */
const SYSTEM_TOOLS = ["bash", "sh", "sed", "grep", "tr", "cut", "sort", "head", "tail", "timeout", "sha256sum", "stat", "mkdir", "rm", "ln", "tar", "cat", "dirname", "xz", "wc"];

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  rows: Array<{ id: string; verdict: string; detail: string }>;
  summary: string;
  out: string;
  logs: string;
}

function run(over: Record<string, string> = {}, omit: string[] = []): Run {
  const root = mkdtempSync(path.join(tmpdir(), "taj_wsl2proof-"));
  roots.push(root);
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const stubs = path.join(root, "stubs");
  const logs = path.join(root, "logs");
  const out = path.join(root, "out");
  for (const dir of [path.join(checkout, "packages/fx-runner/src/engines/claude"), home, stubs, logs]) mkdirSync(dir, { recursive: true });
  const system = path.join(root, "system");
  mkdirSync(system);
  for (const tool of SYSTEM_TOOLS) {
    const real = findOnPath(tool);
    if (real !== undefined) symlinkSync(real, path.join(system, tool));
  }
  writeFileSync(path.join(checkout, "packages/fx-runner/package.json"), "{}\n");
  writeFileSync(path.join(checkout, "packages/fx-runner/src/engines/claude/pin.ts"), 'export const MIN_CLAUDE_VERSION = "2.1.295";\n');
  for (const [name, body] of Object.entries(STUBS)) if (!omit.includes(name)) writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const result = spawnSync("bash", [SCRIPT, out], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 60_000,
    // An explicit environment: the stubs, then links to the few system tools the script uses; nothing of the caller's reaches the script.
    env: {
      PATH: `${stubs}:${system}`,
      HOME: home,
      STUB_LOG_DIR: logs,
      STUB_KERNEL: WSL_KERNEL,
      STUB_GATE_OUT: PASS_LINE,
      STUB_CANARY_OUT: PASS_LINE,
      STUB_CURL_BODY: "not a node tarball",
      ...over,
    },
  });
  const read = (file: string): string => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      // fx-swallow-ok: a file the script never got to write reads as empty; the assertions say which one was expected
      return "";
    }
  };
  const rows = read(path.join(out, "results.jsonl"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { id: string; verdict: string; detail: string });
  return { code: result.status, rows, summary: read(path.join(out, "summary.md")), out, logs: [read(path.join(logs, "gate-env.txt")), read(path.join(logs, "canary-env.txt")), read(path.join(logs, "npm.txt"))].join("") };
}

const verdictOf = (r: Run, id: string): string | undefined => r.rows.find((row) => row.id === id)?.verdict;

describe("wsl2-proof.sh", () => {
  it("answers YES, exit 0, when every step passes, and runs the gate and the matrix with their switches on", () => {
    const r = run();
    expect(r.rows.map((row) => `${row.id}:${row.verdict}`)).toEqual(["kernel:pass", "tools:pass", "kvm:pass", "node:pass", "install:pass", "gate:pass", "canary:pass"]);
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/^## WSL2 proof: YES$/m);
    expect(r.summary).toContain(WSL_KERNEL);
    expect(r.logs).toContain("FX_REAL_WSL=1");
    expect(r.logs).toContain("FX_B10=1 FX_B10_CHECK=1");
    expect(r.logs).toContain("@anthropic-ai/claude-code@2.1.295");
  });

  it("refuses a kernel that is not WSL2 at once, records nothing else, and answers NO", () => {
    const r = run({ STUB_KERNEL: "6.8.0-generic" });
    expect(r.rows.map((row) => `${row.id}:${row.verdict}`)).toEqual(["kernel:fail"]);
    expect(r.code).not.toBe(0);
    expect(r.summary).toMatch(/^## WSL2 proof: NO$/m);
  });

  it("a WSL1 kernel (Microsoft, not microsoft-standard-WSL2) is not WSL2 either", () => {
    const r = run({ STUB_KERNEL: "4.4.0-19041-Microsoft" });
    expect(verdictOf(r, "kernel")).toBe("fail");
    expect(r.code).not.toBe(0);
  });

  it("refuses to run as root, and records nothing", () => {
    const r = run({ STUB_UID: "0" });
    expect(r.code).toBe(2);
    expect(r.rows).toEqual([]);
  });

  it("a missing sandbox tool fails the tools row and the verdict, and names the tool", () => {
    const r = run({}, ["socat"]);
    const tools = r.rows.find((row) => row.id === "tools");
    expect(tools?.verdict).toBe("fail");
    expect(tools?.detail).toContain("socat");
    expect(r.code).not.toBe(0);
  });

  it("a gate run whose tests were skipped is a failure, never a pass, even with exit 0", () => {
    const r = run({ STUB_GATE_OUT: " Test Files  1 skipped (1)\n      Tests  3 skipped (3)\n" });
    expect(verdictOf(r, "gate")).toBe("fail");
    expect(r.rows.find((row) => row.id === "gate")?.detail).toContain("did not run every test");
    expect(r.code).not.toBe(0);
    expect(r.summary).toMatch(/^## WSL2 proof: NO$/m);
  });

  it("a gate run with some tests passed and some skipped is a failure", () => {
    const r = run({ STUB_GATE_OUT: " Test Files  1 passed (1)\n      Tests  2 passed | 1 skipped (3)\n" });
    expect(verdictOf(r, "gate")).toBe("fail");
  });

  it("a gate run that passed its tests but skipped a test file is a failure", () => {
    expect(verdictOf(run({ STUB_GATE_OUT: " Test Files  1 passed | 1 skipped (2)\n      Tests  3 passed (3)\n" }), "gate")).toBe("fail");
  });

  it("a gate run that exits non-zero is a failure even when its output looks like a pass", () => {
    const r = run({ STUB_GATE_RC: "1" });
    expect(verdictOf(r, "gate")).toBe("fail");
    expect(r.rows.find((row) => row.id === "gate")?.detail).toContain("exit 1");
  });

  it("a gate run that printed no summary line is a failure", () => {
    const r = run({ STUB_GATE_OUT: "nothing useful\n" });
    expect(verdictOf(r, "gate")).toBe("fail");
    expect(r.rows.find((row) => row.id === "gate")?.detail).toContain("no summary line");
  });

  it("a failing gate run is a failure with its exit status", () => {
    const r = run({ STUB_GATE_RC: "1", STUB_GATE_OUT: " FAIL  test/wslGate.real.test.ts\nError: expected true to be false\n Tests  1 failed | 2 passed (3)\n" });
    expect(verdictOf(r, "gate")).toBe("fail");
    expect(r.rows.find((row) => row.id === "gate")?.detail).toContain("exit 1");
    expect(r.code).not.toBe(0);
  });

  it("a canary matrix that skipped, or failed, is a failure, even when its output looks like a pass", () => {
    expect(verdictOf(run({ STUB_CANARY_OUT: " Tests  1 skipped (1)\n" }), "canary")).toBe("fail");
    expect(verdictOf(run({ STUB_CANARY_OUT: " Test Files  1 passed | 1 skipped (2)\n      Tests  1 passed (1)\n" }), "canary")).toBe("fail");
    expect(verdictOf(run({ STUB_CANARY_RC: "1" }), "canary")).toBe("fail");
  });

  describe("the two matrix files that cannot apply on a Linux host", () => {
    const LIVE = " ↓ test/canary.live.test.ts (1 test | 1 skipped)\n";
    const KEYCHAIN = " ↓ test/canary/securitydInit.test.ts (1 test | 1 skipped)\n";
    const TOTALS = " Test Files  5 passed | 2 skipped (7)\n      Tests  32 passed | 2 skipped (34)\n";

    it("passes when exactly those two files are skipped whole, and the row names them (the real run's output)", () => {
      const r = run({ STUB_CANARY_OUT: `${LIVE} ✓ test/canary/matrixUnit.test.ts (13 tests) 282ms\n${KEYCHAIN}${TOTALS}` });
      expect(verdictOf(r, "canary")).toBe("pass");
      expect(r.rows.find((row) => row.id === "canary")?.detail).toContain("test/canary.live.test.ts test/canary/securitydInit.test.ts");
    });

    it("passes with one of them skipped, and says nothing was skipped when none is", () => {
      expect(verdictOf(run({ STUB_CANARY_OUT: `${KEYCHAIN} Test Files  3 passed | 1 skipped (4)\n Tests  4 passed | 1 skipped (5)\n` }), "canary")).toBe("pass");
      expect(run().rows.find((row) => row.id === "canary")?.detail).toContain("no test skipped");
    });

    it("fails when any other file is skipped", () => {
      const other = " ↓ test/canary/readDenyMatrix.test.ts (1 test | 1 skipped)\n";
      expect(verdictOf(run({ STUB_CANARY_OUT: `${other}${KEYCHAIN} Test Files  3 passed | 2 skipped (5)\n Tests  4 passed | 2 skipped (6)\n` }), "canary")).toBe("fail");
    });

    it("fails when an allowed file is only partly skipped, or skips more than its one test", () => {
      expect(verdictOf(run({ STUB_CANARY_OUT: " ❯ test/canary/securitydInit.test.ts (2 tests | 1 skipped)\n Tests  4 passed | 1 skipped (5)\n" }), "canary")).toBe("fail");
      expect(verdictOf(run({ STUB_CANARY_OUT: " ↓ test/canary/securitydInit.test.ts (1 test | 1 skipped)\n Tests  4 passed | 3 skipped (7)\n" }), "canary")).toBe("fail");
    });

    it("fails when a test skips itself from inside an allowed run (a skip the file list does not explain)", () => {
      expect(verdictOf(run({ STUB_CANARY_OUT: `${KEYCHAIN}   ↓ some test skipped at runtime\n Tests  4 passed | 1 skipped (5)\n` }), "canary")).toBe("fail");
    });

    it("matches the allowed paths whole: a skipped file whose path is a prefix, suffix or substring of an allowed one fails", () => {
      for (const file of ["test/canary.live.test.ts.bak", "canary.live.test.ts", "test/canary", "other/test/canary.live.test.ts", "est/canary.live.test.ts"]) {
        const out = ` ↓ ${file} (1 test | 1 skipped)\n Test Files  3 passed | 1 skipped (4)\n Tests  4 passed | 1 skipped (5)\n`;
        expect(verdictOf(run({ STUB_CANARY_OUT: out }), "canary"), file).toBe("fail");
      }
    });

    it("fails when an allowed clean skip is joined by any other line that says skipped (stderr, a reporter note)", () => {
      const clean = `${KEYCHAIN} Test Files  3 passed | 1 skipped (4)\n Tests  4 passed | 1 skipped (5)\n`;
      expect(verdictOf(run({ STUB_CANARY_OUT: clean }), "canary")).toBe("pass");
      expect(verdictOf(run({ STUB_CANARY_OUT: `stderr: 1 skipped\n${clean}` }), "canary")).toBe("fail");
    });

    it("still fails on a non-zero exit, however clean the skip list", () => {
      expect(verdictOf(run({ STUB_CANARY_RC: "1", STUB_CANARY_OUT: `${KEYCHAIN} Test Files  3 passed | 1 skipped (4)\n Tests  4 passed | 1 skipped (5)\n` }), "canary")).toBe("fail");
    });

    it("never excuses a skipped gate: the gate has no allowed skips", () => {
      expect(verdictOf(run({ STUB_GATE_OUT: " ↓ test/wslGate.real.test.ts (3 tests | 3 skipped)\n Tests  3 skipped (3)\n" }), "gate")).toBe("fail");
    });
  });

  it("a failing gate's row carries the setting code the assertion printed", () => {
    const r = run({ STUB_GATE_RC: "1", STUB_GATE_OUT: 'AssertionError: expected [ \'x\' ] to deeply equal []\n+   "wsl_interop_enabled: the WSLInterop entry exists"\n Tests  1 failed | 2 passed (3)\n' });
    expect(r.rows.find((row) => row.id === "gate")?.detail).toContain("wsl_interop_enabled");
  });

  it("FX_WSL_PROOF_CANARY=0 leaves the matrix out as not tested: the verdict cannot be YES", () => {
    const r = run({ FX_WSL_PROOF_CANARY: "0" });
    expect(verdictOf(r, "canary")).toBe("not_tested");
    expect(r.summary).toMatch(/^## WSL2 proof: NOT TESTED$/m);
    expect(r.code).not.toBe(0);
  });

  it("a failed dependency install is not tested, the gate is not run, and the verdict is not YES", () => {
    const r = run({ STUB_INSTALL_RC: "1" });
    expect(verdictOf(r, "install")).toBe("not_tested");
    expect(verdictOf(r, "gate")).toBe("not_tested");
    expect(verdictOf(r, "canary")).toBe("not_tested");
    expect(r.logs).not.toContain("FX_REAL_WSL");
    expect(r.code).not.toBe(0);
  });

  it("a Node download that does not match its pinned sha256 is not used and is not tested; the install is not run on it", () => {
    const r = run({ STUB_NODE: "18.0.0" });
    expect(verdictOf(r, "node")).toBe("not_tested");
    expect(r.rows.find((row) => row.id === "node")?.detail).toContain("sha256");
    expect(verdictOf(r, "install")).toBe("not_tested");
    expect(r.code).not.toBe(0);
  });

  it("a Node download that fails is not tested", () => {
    const r = run({ STUB_NODE: "18.0.0", STUB_CURL_RC: "22" });
    expect(verdictOf(r, "node")).toBe("not_tested");
    expect(r.rows.find((row) => row.id === "node")?.detail).toContain("download failed");
  });

  it("a failure and a not-tested row together answer NO: a failure is never softened", () => {
    const r = run({ STUB_GATE_RC: "1", FX_WSL_PROOF_CANARY: "0" });
    expect(r.summary).toMatch(/^## WSL2 proof: NO$/m);
  });

  it("holds only the kernel, the pinned Node download and the checked-in pins: nothing is piped into a shell, and the proof reads no secret", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(src).toMatch(/NODE_SHA256="[0-9a-f]{64}"/);
    expect(src).not.toMatch(/secrets\.|TOKEN|API_KEY|\.env\b/);
    expect(src).toContain("/mnt/*");
  });
});
