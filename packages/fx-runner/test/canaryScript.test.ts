import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/canary.sh` swaps a decoy in for the user's real `~/.bashrc` and must put the real one back however the run
 * ends. Each case runs the real script against a throwaway HOME, with a stub `claude` and a stub `pnpm` (which stands in
 * for the live test), and checks what is at `~/.bashrc` afterwards.
 */
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/canary.sh");
const REAL = "# my real bashrc\nexport KEEP=1\n";
const PNPM_STUB = `#!/usr/bin/env bash
# the stub for "pnpm ... vitest": behaves as STUB_MODE says
b="$FX_CANARY_HOME/fx-canary-$FX_CANARY_ID"
case "$STUB_MODE" in
  ok)
    grep -q "decoy for the canary" "$FX_CANARY_RC_FILE" || exit 9
    # the planted strings say plainly that they are canaries
    case "$FX_CANARY_MARKERS" in CANARY-STATE-*:CANARY-SSH-*:CANARY-BIN-*:CANARY-RC-*) ;; *) exit 9 ;; esac
    grep -q "CANARY-SSH-" "$FX_CANARY_SSH_FILE" || exit 9
    ;;
  sleep) echo $$ > "$STUB_PIDFILE"; sleep 30 & wait ;;
  rmfail) mkdir -p "$b/stuck/inner"; : > "$b/stuck/inner/f"; chmod 555 "$b/stuck/inner" ;;
esac
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      for (const dir of readdirSync(root).flatMap((name) => (name.startsWith("fx-canary-") ? [path.join(root, name, "stuck", "inner")] : []))) if (existsSync(dir)) chmodSync(dir, 0o755);
    } catch {
      // fx-swallow-ok: test cleanup only; a root that is already gone needs nothing
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function makeHome(): { home: string; claude: string; bashrc: string; pidfile: string; stubs: string } {
  const home = mkdtempSync(path.join(tmpdir(), "taj_canary-"));
  roots.push(home);
  const stubs = path.join(home, "stubs");
  mkdirSync(stubs);
  const claude = path.join(stubs, "claude");
  writeFileSync(claude, "#!/usr/bin/env bash\necho '2.1.294 (Claude Code)'\n", { mode: 0o755 });
  writeFileSync(path.join(stubs, "pnpm"), PNPM_STUB, { mode: 0o755 });
  // The script wants the CLI's two sandbox tools on PATH (Linux); these stand in for them.
  for (const tool of ["bwrap", "socat"]) writeFileSync(path.join(stubs, tool), "#!/bin/sh\n", { mode: 0o755 });
  return { home, claude, bashrc: path.join(home, ".bashrc"), pidfile: path.join(home, "stub.pid"), stubs };
}

/** Runs the script in its own process group (as a terminal would), optionally signalling the group once the stub is running. */
function run(h: ReturnType<typeof makeHome>, mode: string, signal?: NodeJS.Signals, pathValue = `${h.stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`): Promise<{ code: number | null; signal: string | null }> {
  const child = spawn("bash", [SCRIPT, h.claude], {
    cwd: h.home,
    detached: true,
    stdio: "ignore",
    env: { HOME: h.home, PATH: pathValue, STUB_MODE: mode, STUB_PIDFILE: h.pidfile },
  });
  if (signal !== undefined) {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(h.pidfile) || Date.now() - started > 10_000) {
        clearInterval(timer);
        process.kill(-child.pid!, signal);
      }
    }, 50);
  }
  return new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, signal: sig })));
}

const leftovers = (home: string): string[] => readdirSync(home).filter((name) => name !== "stubs" && name !== ".bashrc" && name !== "stub.pid" && !name.startsWith("fx-canary-"));

/** A PATH holding the stubs and links to just the system tools the script uses, so it has no `bwrap` or `socat` unless a test adds one. */
function pathWithout(h: ReturnType<typeof makeHome>, ...omit: string[]): string {
  const dir = path.join(h.home, "tools");
  mkdirSync(dir);
  for (const tool of ["bash", "env", "od", "tr", "dirname", "mkdir", "mv", "rm", "rmdir", "uname", "grep", "sleep", "cat"]) {
    const found = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, tool)).find((file) => existsSync(file));
    if (found !== undefined) symlinkSync(found, path.join(dir, tool));
  }
  const stubs = path.join(h.home, "stubs-some");
  mkdirSync(stubs);
  for (const name of readdirSync(h.stubs)) if (!omit.includes(name)) symlinkSync(path.join(h.stubs, name), path.join(stubs, name));
  return `${stubs}:${dir}`;
}

describe.skipIf(process.getuid?.() === 0)("canary.sh needs the CLI's sandbox tools before it plants anything", () => {
  it.each(["bwrap", "socat"])("without %s on PATH it exits 2 with a message, and ~/.bashrc and the home directory are untouched", async (missing) => {
    if (process.platform === "darwin") return; // macOS needs neither tool
    const h = makeHome();
    writeFileSync(h.bashrc, REAL);
    const result = await run(h, "ok", undefined, pathWithout(h, missing));
    expect(result.code).toBe(2);
    expect(readFileSync(h.bashrc, "utf8")).toBe(REAL);
    expect(readdirSync(h.home).filter((name) => name.startsWith("fx-canary-"))).toEqual([]);
    expect(existsSync(path.join(h.home, ".ssh")) || existsSync(path.join(h.home, ".fx-runner"))).toBe(false);
    expect(leftovers(h.home).filter((name) => !name.startsWith("tools") && !name.startsWith("stubs"))).toEqual([]);
  });

  it("with both on PATH the sanity run still passes (the stub checks the planted strings are labelled as canaries)", async () => {
    const h = makeHome();
    writeFileSync(h.bashrc, REAL);
    expect((await run(h, "ok", undefined, pathWithout(h))).code).toBe(0);
    expect(readFileSync(h.bashrc, "utf8")).toBe(REAL);
  });
});

describe.skipIf(process.getuid?.() === 0)("canary.sh puts the real ~/.bashrc back", () => {
  it("normal exit: the real file is back, the decoy and everything planted are gone", async () => {
    const h = makeHome();
    writeFileSync(h.bashrc, REAL);
    expect((await run(h, "ok")).code).toBe(0);
    expect(readFileSync(h.bashrc, "utf8")).toBe(REAL);
    expect(leftovers(h.home)).toEqual([]);
    expect(readdirSync(h.home).filter((name) => name.startsWith("fx-canary-"))).toEqual([]);
  });

  it("SIGTERM during the run: the real file is back", async () => {
    const h = makeHome();
    writeFileSync(h.bashrc, REAL);
    await run(h, "sleep", "SIGTERM");
    expect(existsSync(h.pidfile)).toBe(true);
    expect(readFileSync(h.bashrc, "utf8")).toBe(REAL);
    expect(leftovers(h.home)).toEqual([]);
  });

  it("an rm that fails (undeletable scratch directory): the real file is back anyway", async () => {
    const h = makeHome();
    writeFileSync(h.bashrc, REAL);
    await run(h, "rmfail");
    expect(readFileSync(h.bashrc, "utf8")).toBe(REAL);
    expect(readdirSync(h.home).filter((name) => name.startsWith("fx-canary-"))).toHaveLength(1);
  });

  it("no ~/.bashrc to begin with: none exists afterwards, no decoy left", async () => {
    const h = makeHome();
    expect((await run(h, "ok")).code).toBe(0);
    expect(existsSync(h.bashrc)).toBe(false);
    expect(leftovers(h.home)).toEqual([]);
  });

  it("a dangling-symlink ~/.bashrc: the link itself is back, and nothing was written through it", async () => {
    const h = makeHome();
    const target = path.join(h.home, "not-there.txt");
    symlinkSync(target, h.bashrc);
    expect((await run(h, "ok")).code).toBe(0);
    expect(lstatSync(h.bashrc).isSymbolicLink()).toBe(true);
    expect(readlinkSync(h.bashrc)).toBe(target);
    expect(existsSync(target)).toBe(false);
    expect(leftovers(h.home)).toEqual([]);
  });
});
