import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { unixSocketsRefused } from "../helpers/needsHostSockets.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { AgentClient, ExecStream, viaUnixSocket } from "./helpers/agentClient.js";

/**
 * D#587 B-6.4, the guest side: the in-guest agent's token ops, run on any machine with python3 over a Unix socket. The secret directory is a
 * scratch directory on this machine's own tmpfs (`/dev/shm`) with mode 0700, named to the agent through FX_SECRET_DIR; nothing here touches a
 * real host path. The real guest, the real mount and the snapshot are in vmToken.real.test.ts.
 */
const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image", "guest");
const hasPython = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;
const unixSocketsRefusedHere = hasPython && unixSocketsRefused();
const mountType = (p: string): string | undefined => {
  let best = -1;
  let kind: string | undefined;
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const [left, right] = line.split(" - ");
    const point = left?.split(" ")[4];
    if (point === undefined || right === undefined) continue;
    if ((point === "/" || p === point || p.startsWith(`${point}/`)) && point.length > best) [best, kind] = [point.length, right.split(" ")[0]];
  }
  return kind;
};
const shmIsTmpfs = existsSync("/dev/shm") && mountType("/dev/shm") === "tmpfs";
/**
 * A cgroup2 directory this process may make children in (a delegated subtree: the user's own scope under systemd), or undefined. The launch
 * tests need it; where it is missing (most hosted runners) they skip, and the "no cgroup2: refuse and consume nothing" test runs instead.
 */
const cgroupBase = ((): string | undefined => {
  try {
    const own = /^0::(.*)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
    if (own === undefined) return undefined;
    const base = path.join("/sys/fs/cgroup", own);
    const probe = path.join(base, `fx-cgprobe-${process.pid}`);
    mkdirSync(probe);
    try {
      return existsSync(path.join(probe, "cgroup.kill")) ? base : undefined;
    } finally {
      rmdirSync(probe);
    }
  } catch {
    return undefined;
  }
})();
const cgroupOk = cgroupBase !== undefined;
const bin = (name: string): string => {
  const found = (process.env["PATH"] ?? "").split(path.delimiter).map((d) => path.join(d, name)).find((f) => existsSync(f));
  if (found === undefined) throw new Error(`${name} is not on PATH`);
  return found;
};
const TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
const sentinel = (): Buffer => Buffer.from(`sk-ant-oat01-${randomBytes(24).toString("hex")}`);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

interface Running { client: AgentClient; connect: () => Promise<net.Socket>; secretDir: string; pid: number; proc: ChildProcess }
/** One agent on its own socket, with its own secret directory; `setup` may change the directory before the agent starts. `shellPrefix` runs in the shell that execs the agent. */
async function startAgent(opts: { secretDir?: string; mode?: number; shellPrefix?: string; noCgroup?: boolean } = {}): Promise<Running> {
  const dir = mkdtempSync(path.join(socketTmpRoot(), "fx-agt-"));
  // the agent's own cgroup parent: a fresh child of ours, or (noCgroup, or no cgroup2 here) a plain directory that is not one
  const cgDir = cgroupBase !== undefined && opts.noCgroup !== true ? path.join(cgroupBase, `fx-tok-${randomBytes(4).toString("hex")}`) : path.join(dir, "not-a-cgroup");
  const secretDir = opts.secretDir ?? mkdtempSync("/dev/shm/fx-secret-");
  if (opts.secretDir === undefined) chmodSync(secretDir, opts.mode ?? 0o700);
  const sock = path.join(dir, "a.sock");
  const script = `${opts.shellPrefix ?? ""}exec python3 -I "$0" --unix "$1"`;
  const proc = spawn("sh", ["-c", script, path.join(GUEST_DIR, "agent.py"), sock], { stdio: "ignore", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", FX_SECRET_DIR: secretDir, FX_CGROUP_DIR: cgDir } });
  for (let i = 0; i < 200 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 25));
  cleanups.push(() => {
    proc.kill("SIGKILL");
    // a cgroup is removed with rmdir once empty: kill what is left in each, then remove them and the parent
    if (cgroupBase !== undefined && existsSync(cgDir) && cgDir.startsWith(cgroupBase)) {
      for (const n of readdirSync(cgDir)) {
        const child = path.join(cgDir, n);
        try {
          if (statSync(child).isDirectory()) {
            writeFileSync(path.join(child, "cgroup.kill"), "1");
            for (let i = 0; i < 100 && readFileSync(path.join(child, "cgroup.procs"), "utf8").trim() !== ""; i++) spawnSync("sleep", ["0.02"]);
            rmdirSync(child);
          }
        } catch {
          // a cgroup that is already gone
        }
      }
      try {
        rmdirSync(cgDir);
      } catch {
        // left for the next boot of the host's cgroup tree; empty
      }
    }
    rmSync(dir, { recursive: true, force: true });
    if (opts.secretDir === undefined) rmSync(secretDir, { recursive: true, force: true });
  });
  return { client: new AgentClient(viaUnixSocket(sock)), connect: viaUnixSocket(sock), secretDir, pid: proc.pid as number, proc };
}
const tokenFile = (r: Running): string => path.join(r.secretDir, "oauth-token");
const alive = (pid: number): boolean => {
  try {
    return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z");
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
};

/** A token well over the allocator's small-object size: a freed, unzeroed buffer of this size stays readable in the agent's heap. */
const bigToken = (): Buffer => Buffer.from(randomBytes(1024).toString("hex"));

/**
 * Whether a stretch of `secret` is anywhere in the agent's writable memory (a freed block loses its first bytes to the allocator's own
 * bookkeeping, so the search is for 32 bytes from the middle). undefined when this host does not let the test read that memory.
 */
function agentMemoryHas(pid: number, secret: Buffer): boolean | undefined {
  const needle = secret.subarray(16, 48);
  let fd: number | undefined;
  try {
    const maps = readFileSync(`/proc/${pid}/maps`, "utf8").split("\n");
    fd = openSync(`/proc/${pid}/mem`, "r");
    for (const line of maps) {
      const m = /^([0-9a-f]+)-([0-9a-f]+) rw/.exec(line);
      if (m === null || line.includes("[vvar]") || line.includes("[vsyscall]")) continue;
      const start = Number.parseInt(m[1]!, 16);
      const end = Number.parseInt(m[2]!, 16);
      for (let at = start; at < end; at += 1 << 20) {
        const buf = Buffer.alloc(Math.min(1 << 20, end - at) + needle.length);
        let n = 0;
        try {
          n = readSync(fd, buf, 0, buf.length, at);
        } catch {
          break; // an unreadable page ends this mapping
        }
        if (buf.subarray(0, n).includes(needle)) return true;
      }
    }
    return false;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

describe.skipIf(!hasPython)("reading another process's environment", () => {
  it("finds an entry, and leaves the agent's one read buffer all zero afterwards, whatever the entry held", () => {
    const code = [
      "import importlib.util, subprocess, sys, time",
      "spec = importlib.util.spec_from_file_location('agent', sys.argv[1])",
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      `p = subprocess.Popen(['${bin("sleep")}', '5'], env={'SECRETISH': sys.argv[2]})`,
      "time.sleep(0.2)",
      "hit = m.environ_has(p.pid, b'SECRETISH=')",
      "miss = m.environ_has(p.pid, b'NOSUCH=')",
      "p.kill()",
      "print(hit, miss, any(m.ENV_BUF))",
    ].join("\n");
    const out = spawnSync("python3", ["-I", "-c", code, path.join(GUEST_DIR, "agent.py"), bigToken().toString()], { encoding: "utf8" });
    expect(out.stdout.trim()).toBe("True False False");
  });
});

describe("the guest init mounts the token's home", () => {
  it("makes /run/fx-secret a 0700 tmpfs that has no exec, no devices and no setuid, right after /run", () => {
    const init = readFileSync(path.join(GUEST_DIR, "init"), "utf8");
    expect(init).toMatch(/mkdir -m 0700 \/run\/fx-secret\nmount -t tmpfs -o mode=0700,size=64k,nosuid,nodev,noexec tmpfs \/run\/fx-secret\n/);
    expect(init.indexOf("tmpfs /run\n")).toBeGreaterThan(-1);
    expect(init.indexOf("tmpfs /run\n")).toBeLessThan(init.indexOf("/run/fx-secret"));
    expect(spawnSync("bash", ["-n", path.join(GUEST_DIR, "init")]).status).toBe(0);
    // cgroup2 is mounted (the wipe kills by descent), before the agent starts
    expect(init).toContain("mount -t cgroup2 none /sys/fs/cgroup\n");
    expect(init.indexOf("mount -t cgroup2")).toBeLessThan(init.indexOf("agent.py"));
  });
});

describe.skipIf(!hasPython || unixSocketsRefusedHere || !shmIsTmpfs)("token_put and the launch", () => {
  it("advertises the token cap, and a put leaves one 0600 file with the exact bytes in a 0700 directory, and a bare {ok:true} reply", async () => {
    const a = await startAgent();
    expect((await a.client.ping())["caps"]).toContain("token");
    const token = sentinel();
    expect(await a.client.putToken(token)).toEqual({ ok: true });
    expect(readdirSync(a.secretDir)).toEqual(["oauth-token"]);
    expect(statSync(tokenFile(a)).mode & 0o7777).toBe(0o600);
    expect(statSync(a.secretDir).mode & 0o7777).toBe(0o700);
    expect(readFileSync(tokenFile(a))).toEqual(token);
    // a second put replaces it
    const second = sentinel();
    expect(await a.client.putToken(second)).toEqual({ ok: true });
    expect(readFileSync(tokenFile(a))).toEqual(second);
    expect(readdirSync(a.secretDir)).toEqual(["oauth-token"]);
  });

  it("refuses a directory that is not 0700, is missing, is a link, or is not on tmpfs: nothing is written, and the reply is a fixed code", async () => {
    const wide = await startAgent({ mode: 0o755 });
    expect(await wide.client.putToken(sentinel())).toMatchObject({ ok: false, code: "secret_dir_unsafe" });
    expect(readdirSync(wide.secretDir)).toEqual([]);

    const missing = await startAgent({ secretDir: "/dev/shm/fx-secret-missing-fictional" });
    expect(await missing.client.putToken(sentinel())).toMatchObject({ ok: false, code: "secret_dir_missing" });

    const real = mkdtempSync("/dev/shm/fx-secret-");
    const link = `${real}-link`;
    symlinkSync(real, link);
    cleanups.push(() => void rmSync(real, { recursive: true, force: true }), () => void unlinkSync(link)); // a link to a directory: rmSync refuses it on some Node versions
    chmodSync(real, 0o700);
    const linked = await startAgent({ secretDir: link });
    expect(await linked.client.putToken(sentinel())).toMatchObject({ ok: false, code: "secret_dir_unsafe" });
    expect(readdirSync(real)).toEqual([]);

    // a 0700 directory on a disk file system: the worktree's own, which is not tmpfs
    const disk = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fx-notmpfs-"));
    cleanups.push(() => void rmSync(disk, { recursive: true, force: true }));
    chmodSync(disk, 0o700);
    if (mountType(disk) !== "tmpfs") {
      const onDisk = await startAgent({ secretDir: disk });
      expect(await onDisk.client.putToken(sentinel())).toMatchObject({ ok: false, code: "secret_dir_not_tmpfs" });
      expect(readdirSync(disk)).toEqual([]);
    }
  });

  it("refuses an empty, over-long, spaced, newline or non-ASCII token, and one cut short, and leaves no file", async () => {
    const a = await startAgent();
    for (const bad of [Buffer.alloc(0), Buffer.alloc(4097, "a"), Buffer.from("with space"), Buffer.from("with\nnewline"), Buffer.from([0x61, 0x80, 0x62]), Buffer.from("nul\0byte")]) {
      expect(await a.client.putToken(bad), `${bad.length} bytes`).toMatchObject({ ok: false, code: "bad_token" });
      expect(readdirSync(a.secretDir)).toEqual([]);
    }
    expect(await a.client.putToken(Buffer.alloc(4096, "a"))).toEqual({ ok: true }); // the bound itself is allowed
    rmSync(tokenFile(a));
    // the host goes away half way through the bytes: nothing is left behind
    const socket = await a.connect();
    const json = Buffer.from(JSON.stringify({ op: "token_put", size: 40 }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    socket.write(Buffer.concat([length, json, Buffer.from("only-ten-b")]));
    await new Promise((r) => setTimeout(r, 100));
    socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(readdirSync(a.secretDir)).toEqual([]);
  });

  it("removes the file when the write fails after it was created, and the error names nothing of the token", async () => {
    // a file size limit of zero makes every write fail with EFBIG once the file exists
    const a = await startAgent({ shellPrefix: "ulimit -f 0; " });
    const token = sentinel();
    const reply = await a.client.putToken(token);
    expect(reply["ok"]).toBe(false);
    expect(JSON.stringify(reply)).not.toContain(token.toString().slice(0, 12));
    expect(readdirSync(a.secretDir)).toEqual([]);
  });

  it.skipIf(!cgroupOk)("a command that asks for the token gets it in its environment, the file is gone, and no argv or open file names it", async () => {
    const a = await startAgent();
    const token = sentinel();
    await a.client.putToken(token);
    const r = await a.client.exec([bin("sh"), "-c", `printf %s "$${TOKEN_VAR}"; echo; ${bin("tr")} '\\0' ' ' </proc/$$/cmdline; echo; for f in /proc/$$/fd/*; do ${bin("readlink")} "$f"; done; true`], { token: true });
    expect(r.exit).toBe(0);
    const [seen, cmdline, ...fds] = r.stdout.split("\n");
    expect(seen).toBe(token.toString());
    expect(cmdline).not.toContain(token.toString().slice(0, 12));
    expect(fds.join("\n")).not.toContain("oauth-token");
    expect(readdirSync(a.secretDir)).toEqual([]); // one launch per delivery
    await expect(a.client.exec([bin("true")], { token: true })).rejects.toThrow(/no_token/);
    // a command that did not ask has no such variable, and neither does one whose env names it
    expect((await a.client.exec([bin("env")])).stdout).not.toContain(TOKEN_VAR);
    await expect(a.client.exec([bin("env")], { env: { [TOKEN_VAR]: "x" } })).rejects.toThrow(/token variable/);
    await expect(a.client.exec([bin("true")], { token: true, env: { [TOKEN_VAR]: "x" } })).rejects.toThrow(/token variable/);
  });

  it("a token launch as root is refused with a fixed code before the token is touched, for exec and for the stream (a root descendant could leave the cgroup)", async () => {
    const a = await startAgent();
    await a.client.putToken(sentinel());
    await expect(a.client.exec([bin("true")], { token: true, user: "root" })).rejects.toThrow(/token_requires_unprivileged_user/);
    const refused = await (await ExecStream.open(a.connect, { id: "r1", argv: [bin("true")], token: true, user: "root" })).all();
    expect(refused[0]).toMatchObject({ ev: "error", header: { ok: false, error: expect.stringContaining("token_requires_unprivileged_user") } });
    expect(readdirSync(a.secretDir)).toEqual(["oauth-token"]); // not consumed
    // and root without the token is still allowed, as before
    expect((await a.client.exec([bin("true")], { user: "root" })).exit).toBe(0);
  });

  it("without a usable cgroup2 a token launch is refused and the token is not consumed", async () => {
    const a = await startAgent({ noCgroup: true });
    await a.client.putToken(sentinel());
    await expect(a.client.exec([bin("true")], { token: true })).rejects.toThrow(/cgroup_unavailable/);
    expect(readdirSync(a.secretDir)).toEqual(["oauth-token"]);
    await expect(a.client.exec([bin("true")], { token: true })).rejects.toThrow(/cgroup_unavailable/); // and again: nothing was spent
  });

  it.skipIf(!cgroupOk)("a launch refuses when the directory has become untrustworthy, and starts nothing", async () => {
    const a = await startAgent();
    await a.client.putToken(sentinel());
    chmodSync(a.secretDir, 0o755);
    await expect(a.client.exec([bin("true")], { token: true })).rejects.toThrow(/secret_dir_unsafe/);
    chmodSync(a.secretDir, 0o700);
    expect(readdirSync(a.secretDir)).toEqual(["oauth-token"]); // not consumed by a refused launch
  });

  it.skipIf(!cgroupOk)("a launch that cannot run its program still consumes the token and reports 127, and nothing else sees it", async () => {
    const a = await startAgent();
    await a.client.putToken(sentinel());
    const r = await a.client.exec(["/no/such/program-fictional"], { token: true });
    expect(r.exit).toBe(127);
    expect(readdirSync(a.secretDir)).toEqual([]);
  });

  it.skipIf(!cgroupOk)("the streaming exec takes the token the same way", async () => {
    const a = await startAgent();
    const token = sentinel();
    await a.client.putToken(token);
    const items = await (await ExecStream.open(a.connect, { id: "t1", argv: [bin("sh"), "-c", `printf %s "$${TOKEN_VAR}"`], token: true })).all();
    const out = Buffer.concat(items.filter((i): i is Extract<typeof i, { ev: "data" }> => i.ev === "data").map((i) => i.data));
    expect(out.toString()).toBe(token.toString());
    expect(readdirSync(a.secretDir)).toEqual([]);
    const refused = await (await ExecStream.open(a.connect, { id: "t2", argv: [bin("true")], token: true })).all();
    expect(refused[0]).toMatchObject({ ev: "error", header: { ok: false } });
  });

  for (const [label, make] of [["a sentinel of about 60 bytes", sentinel], ["a 2 KB token", bigToken]] as const) {
    it(`the agent keeps no copy of ${label} in its own memory after a put (a plain put of the same size is found, so the scan is not blind)`, async (ctx) => {
      const a = await startAgent();
      const control = make();
      await a.client.put(path.join(a.secretDir, "control.bin"), control); // the ordinary put holds the bytes in the agent's memory
      const found = agentMemoryHas(a.pid, control);
      if (found === undefined) return ctx.skip(); // this host does not let the test read the agent's memory: the real-VM snapshot test covers the property
      expect(found, "the scan finds bytes the agent did hold").toBe(true);
      const token = make();
      expect(await a.client.putToken(token)).toEqual({ ok: true });
      expect(agentMemoryHas(a.pid, token), "right after the put").toBe(false);
    });
  }

  it.skipIf(!cgroupOk)("after a launch, a wipe of a live holder, and a kill of a streamed command while a holder runs, the agent's memory still holds no token", async (ctx) => {
    const a = await startAgent();
    const control = bigToken();
    await a.client.put(path.join(a.secretDir, "control.bin"), control);
    if (agentMemoryHas(a.pid, control) === undefined) return ctx.skip();
    const token = bigToken();
    await a.client.putToken(token);
    // the plain command starts first and the holder last, so the holder has the highest pid and is the last environment a /proc scan reads
    const other = await ExecStream.open(a.connect, { id: "o1", argv: [bin("sleep"), "60"] });
    await new Promise((r) => setTimeout(r, 200));
    const held = await ExecStream.open(a.connect, { id: "h1", argv: [bin("sleep"), "60"], token: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(agentMemoryHas(a.pid, token), "after the launch").toBe(false);
    // the plain command is killed while the holder is alive: the agent looks for its descendants through every process's environment
    expect(await a.client.kill("o1", "SIGKILL")).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(agentMemoryHas(a.pid, token), "after a kill with a live holder").toBe(false);
    // and the wipe, which reads every environment, with the holder alive
    expect(await a.client.wipeToken()).toMatchObject({ ok: true });
    expect(agentMemoryHas(a.pid, token), "after the wipe of a live holder").toBe(false);
    held.socket.destroy();
    other.socket.destroy();
  });
});

describe.skipIf(!hasPython || unixSocketsRefusedHere || !shmIsTmpfs)("token_wipe", () => {
  it("zeroes and removes the file, and says so; with nothing to wipe it says that too", async () => {
    const a = await startAgent();
    expect(await a.client.wipeToken()).toEqual({ ok: true, removed: false, killed: 0 });
    await a.client.putToken(sentinel());
    expect(await a.client.wipeToken()).toEqual({ ok: true, removed: true, killed: 0 });
    expect(readdirSync(a.secretDir)).toEqual([]);
    expect(await a.client.wipeToken()).toEqual({ ok: true, removed: false, killed: 0 });
  });

  it.skipIf(!cgroupOk)("kills every process whose environment carries the token, including one that left the process group, and spares one that does not", async () => {
    const a = await startAgent();
    const pidDir = mkdtempSync(path.join(socketTmpRoot(), "fx-pids-"));
    cleanups.push(() => void rmSync(pidDir, { recursive: true, force: true }));
    const holders = [path.join(pidDir, "plain"), path.join(pidDir, "setsid")];
    const bystander = path.join(pidDir, "bystander");
    await a.client.putToken(sentinel());
    // the program itself and a child that starts its own session (it still carries the environment)
    const held = await ExecStream.open(a.connect, { id: "h1", argv: [bin("sh"), "-c", `echo $$ >${holders[0]}; ${bin("setsid")} ${bin("sh")} -c 'echo $$ >${holders[1]}; exec ${bin("sleep")} 60' & wait`], token: true });
    const free = await ExecStream.open(a.connect, { id: "b1", argv: [bin("sh"), "-c", `echo $$ >${bystander}; exec ${bin("sleep")} 60`] });
    await until(() => [...holders, bystander].every((f) => existsSync(f) && readFileSync(f, "utf8").trim() !== ""));
    const pids = [...holders, bystander].map((f) => Number(readFileSync(f, "utf8").trim()));
    expect(pids.every(alive)).toBe(true);
    const wiped = await a.client.wipeToken();
    expect(wiped).toMatchObject({ ok: true });
    expect(wiped["killed"] as number).toBeGreaterThanOrEqual(2);
    await until(() => !alive(pids[0]!) && !alive(pids[1]!));
    expect(alive(pids[0]!)).toBe(false);
    expect(alive(pids[1]!)).toBe(false);
    expect(alive(pids[2]!), "the bystander without the token is untouched").toBe(true);
    process.kill(pids[2]!, "SIGKILL");
    held.socket.destroy();
    free.socket.destroy();
  });

  it.skipIf(!cgroupOk)("kills a descendant that kept the token's value under another name, in its own session (the by-name scan alone cannot find it)", async () => {
    const a = await startAgent();
    const pidDir = mkdtempSync(path.join(socketTmpRoot(), "fx-pids-"));
    cleanups.push(() => void rmSync(pidDir, { recursive: true, force: true }));
    const kept = path.join(pidDir, "kept");
    const token = sentinel();
    await a.client.putToken(token);
    const held = await ExecStream.open(a.connect, { id: "k1", argv: [bin("sh"), "-c", `${bin("setsid")} ${bin("env")} -u ${TOKEN_VAR} KEPT="$${TOKEN_VAR}" ${bin("sh")} -c 'echo $$ >${kept}; exec ${bin("sleep")} 60' & wait`], token: true });
    await until(() => existsSync(kept) && readFileSync(kept, "utf8").trim() !== "");
    const pid = Number(readFileSync(kept, "utf8").trim());
    expect(alive(pid)).toBe(true);
    expect(readFileSync(`/proc/${pid}/environ`, "utf8"), "the probe really keeps the value, and not under the variable's name").toContain(`KEPT=${token.toString()}`);
    expect(readFileSync(`/proc/${pid}/environ`, "utf8")).not.toContain(`${TOKEN_VAR}=`);
    expect(await a.client.wipeToken()).toMatchObject({ ok: true });
    expect(alive(pid), "the wipe has answered ok, so it is already gone").toBe(false);
    held.socket.destroy();
  });

  it.skipIf(!cgroupOk)("a holder that keeps forking while the wipe runs leaves nothing alive: every child it made is dead when the wipe answers", async () => {
    const a = await startAgent();
    const pidDir = mkdtempSync(path.join(socketTmpRoot(), "fx-pids-"));
    cleanups.push(() => void rmSync(pidDir, { recursive: true, force: true }));
    const list = path.join(pidDir, "children");
    await a.client.putToken(sentinel());
    const loop = `i=0; while [ $i -lt 400 ]; do ${bin("sleep")} 60 & echo $! >>${list}; i=$((i+1)); ${bin("sleep")} 0.005; done; wait`;
    const held = await ExecStream.open(a.connect, { id: "f1", argv: [bin("sh"), "-c", `echo $$ >${list}; ${loop}`], token: true });
    await until(() => existsSync(list) && readFileSync(list, "utf8").split("\n").length > 30);
    expect(await a.client.wipeToken()).toMatchObject({ ok: true });
    const pids = readFileSync(list, "utf8").split("\n").filter((l) => l !== "").map(Number);
    expect(pids.length).toBeGreaterThan(20);
    expect(pids.filter(alive), "no child or the loop itself is left").toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(list, "utf8").split("\n").filter((l) => l !== "").map(Number).filter(alive)).toEqual([]); // and the loop made no more
    held.socket.destroy();
  });

  it.skipIf(!cgroupOk)("the stream of a holder that the wipe killed still ends with its exit frame (a signal), read after the wipe has answered", async () => {
    const a = await startAgent();
    await a.client.putToken(sentinel());
    const held = await ExecStream.open(a.connect, { id: "e1", argv: [bin("sleep"), "60"], token: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(await a.client.wipeToken()).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 1500)); // the stream is not read while the agent finishes it
    const items = await held.all();
    expect(items.map((i) => i.ev)).toEqual(["exit"]);
    expect(items[0]).toMatchObject({ ev: "exit", exit: null, signal: 9 });
  });

  it("fails closed when the directory cannot be trusted: nothing is reported wiped", async () => {
    const a = await startAgent();
    await a.client.putToken(sentinel());
    chmodSync(a.secretDir, 0o755);
    expect(await a.client.wipeToken()).toMatchObject({ ok: false, code: "secret_dir_unsafe" });
    chmodSync(a.secretDir, 0o700);
  });
});

// the one scratch directory this file makes beside itself is removed by `cleanups`; this catches one a killed run left behind
afterAll(() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of readdirSync(here)) if (f.startsWith("fx-notmpfs-")) rmSync(path.join(here, f), { recursive: true, force: true });
});
