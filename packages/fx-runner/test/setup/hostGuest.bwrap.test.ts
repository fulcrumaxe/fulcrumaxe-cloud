import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkspaceArchive } from "../../src/daemon/vmArchive.js";
import { applyBundle } from "../../src/daemon/vmBundle.js";
import { runInstall } from "../../src/engines/claude/capture.js";
import type { InstallCapture } from "../../src/daemon/engineKit.js";
import { createSandboxHost } from "../../src/sandbox/probeHost.js";
import { createHostGuest, createHostSetupVm, type HostGuestDeps } from "../../src/setup/hostGuest.js";
import { createProjectSetupHandler, type ProjectSetupDeps, type SetupRepos } from "../../src/setup/projectSetup.js";
import { projectSetupPolicy, workflowPolicy } from "../../src/setup/setupPolicy.js";
import { VmRegistry, type VmPort } from "../../src/vm/jobLifecycle.js";
import { MICROVM_ENV_NAMES, guestEnvOf } from "../../src/vm/sandboxd/guestEnv.js";
import { runInGuest } from "../../src/vm/workspace/guestWorkspace.js";
import { checkCanLaunch } from "../helpers/bwrapProbe.js";
import { fixtureEngineTgz } from "../helpers/fixtureEngine.js";
import { pushWorld } from "../helpers/pushWorld.js";
import { compact, fakeCloud, serveBytes } from "../helpers/setupWorld.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { fixtureRepo, git, hostDeps, hostWorkspace, localGuest } from "../vm/workspace/helpers.js";

/**
 * D#845 ON-8e with REAL bubblewrap and the REAL program as the forwarder (bin/fx-runner.mjs bundled to one file, as the purge child's test does): what the standard tier's guest can and cannot do, the egress through the
 * forwarder and the runner's own proxy, and the parity of a whole project setup with the microVM path's own scripts. The stand-ins are the least that can be: the upstream "registry" is a local listener behind the proxy's
 * connect seam and the resolver is a function; the proxy, the policy, the forwarder, bubblewrap and the guest scripts are production code. The real-VM half of the parity is `test/vm/projectSetup.real.test.ts`.
 *
 * The suite builds its directories below the real home directory when it can (so the home-directory rules are tested apart from the shared temp directories' own), and removes them.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = BWRAP !== undefined && checkCanLaunch(BWRAP);

const SENTINEL = "FX-ON8E-HOME-SENTINEL";
let base: string;
let home: string;
let stateDir: string;
let jobsRoot: string;
/** The runner's cache directory the guest is told of (`HostGuestDeps.cacheDir`); a test that nests its jobs root below it sets it, the rest use the jobs root's parent. */
let declaredCache: string | undefined;
let bundle: string;
let upstream: net.Server;
let upstreamPort: number;
const decisions: string[] = [];
let counter = 0;

const start: InstallCapture = (command, args, env, cwd, timeoutMs, tailChars, signal, feed, onLine, onData) => runInstall(spawn, command, args, env, cwd, timeoutMs, tailChars, signal, feed, onLine, onData);

function depsFor(): HostGuestDeps {
  return {
    start,
    host: createSandboxHost(async () => ({ code: null, stdout: "", stderr: "", timedOut: false })),
    platform: "linux",
    home,
    stateDir,
    binaryDir: path.join(base, "engine-bin"),
    jobsRoot,
    cacheDir: declaredCache ?? path.dirname(jobsRoot),
    searchPath: process.env["PATH"] ?? "/usr/bin:/bin",
    selfCommand: [process.execPath, bundle],
    uid: process.getuid?.(),
    egress: {
      lookup: async (host) => [{ address: host === "pypi.org" ? "10.1.2.3" : "93.184.216.34", family: 4 }],
      connect: () => net.connect(upstreamPort, "127.0.0.1"),
      onDecision: (decision) => void decisions.push(`${decision.outcome}:${decision.host}`),
    },
  };
}

/** A fresh guest and its root; the proxy holds no policy yet. */
function newGuest(): { guest: ReturnType<typeof createHostGuest>["guest"]; root: string; egressDir: string; run: (cmd: string, args: string[], env?: Record<string, string>) => ReturnType<typeof runInGuest> } {
  mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
  const root = path.join(jobsRoot, `g-t${String(counter++)}`);
  mkdirSync(root, { mode: 0o700 });
  const { guest, egressDir } = createHostGuest(depsFor(), `su-t${String(counter)}`, root);
  return { guest, root, egressDir, run: (cmd, args, env) => runInGuest(guest, { cmd, args, ...(env === undefined ? {} : { env }) }, 30_000) };
}

const CONNECT_CLIENT = [
  "const net = require('net');",
  "const [host, port] = process.argv.slice(1);",
  "const s = net.connect(5253, '127.0.0.1');",
  "let buf = '';",
  "s.on('connect', () => s.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\\r\\nHost: ' + host + ':' + port + '\\r\\n\\r\\n'));",
  "s.on('data', (d) => { buf += d; });",
  "s.on('error', (e) => { buf += 'error:' + e.code; });",
  "s.on('close', () => { console.log(JSON.stringify(buf)); process.exit(0); });",
  "setTimeout(() => { console.log(JSON.stringify(buf + 'timeout')); process.exit(0); }, 8000);",
].join("\n");

beforeAll(() => {
  if (!usable) return;
  let made: string | undefined;
  try {
    made = mkdtempSync(path.join(realpathSync(homedir()), ".fxhg-"));
  } catch {
    // fx-swallow-ok: a home directory that cannot be written falls back to the temp root below
    made = undefined;
  }
  base = made ?? mkdtempSync(path.join(socketTmpRoot(), "fxhg-"));
  home = path.join(base, "home");
  stateDir = path.join(home, ".fx-runner");
  jobsRoot = path.join(base, "jobs");
  for (const dir of [stateDir, path.join(base, "engine-bin"), path.join(base, "bin")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(home, "sentinel.txt"), SENTINEL);
  writeFileSync(path.join(stateDir, "key.pem"), SENTINEL);
  bundle = path.join(base, "bin", "fx-runner.cjs");
  buildSync({ entryPoints: [path.join(__dirname, "..", "..", "bin", "fx-runner.mjs")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle, logLevel: "silent", define: { "import.meta.url": JSON.stringify(pathToFileURL(bundle).href), __FX_BUILD_EPOCH__: '"0"' } });
  upstream = net.createServer((socket) => void socket.end("from-registry\n"));
  return new Promise<void>((resolve) => void upstream.listen(0, "127.0.0.1", () => ((upstreamPort = (upstream.address() as net.AddressInfo).port), resolve())));
}, 60_000);
afterAll(() => {
  if (!usable) return;
  upstream.close();
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!usable)("what a standard-tier command can reach", () => {
  it("control: it runs in the job root, writes there, and sees the host's programs", async () => {
    const g = newGuest();
    const out = await g.run("sh", ["-c", 'pwd; echo ok >w.txt; cat w.txt; test -w "$TMPDIR" && echo tmp-ok; command -v git python3 >/dev/null && echo tools-ok']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.split("\n").slice(0, 4)).toEqual([g.root, "ok", "tmp-ok", "tools-ok"]);
    expect(readFileSync(path.join(g.root, "w.txt"), "utf8")).toBe("ok\n");
    await g.guest.close();
  });

  it("cannot read a file in the person's home directory or the runner's state directory, and the files are really there (control)", async () => {
    const g = newGuest();
    expect(readFileSync(path.join(home, "sentinel.txt"), "utf8")).toBe(SENTINEL);
    for (const file of [path.join(home, "sentinel.txt"), path.join(stateDir, "key.pem")]) {
      const out = await g.run("sh", ["-c", 'cat "$1" 2>&1; echo "exit=$?"', "fx", file]);
      expect(out.stdout, file).not.toContain(SENTINEL);
      expect(out.stdout, file).toMatch(/exit=[1-9]/);
    }
    await g.guest.close();
  });

  it("cannot write anywhere but its own root: not the home, not another job's root, not the system, and a file in the shared temp directory is not there", async () => {
    const other = newGuest();
    const g = newGuest();
    writeFileSync(path.join(other.root, "mine.txt"), "other job");
    const shared = path.join("/tmp", `fx-on8e-${String(process.pid)}.txt`);
    writeFileSync(shared, SENTINEL);
    try {
      const targets = [path.join(home, "planted.txt"), path.join(other.root, "planted.txt"), path.join(base, "planted.txt"), "/etc/fx-on8e-planted", path.join(stateDir, "planted.txt")];
      const out = await g.run("sh", ["-c", 'for t in "$@"; do (echo x >"$t") 2>/dev/null && echo "WROTE $t"; done; cat "$0" 2>/dev/null; cat "$1" 2>/dev/null; echo done', shared, path.join(other.root, "mine.txt"), ...targets]);
      // a hidden directory is an empty memory file system the command may scribble in; what counts is that nothing reaches the host, and that the system and the other job's root refuse the write
      expect(out.stdout).not.toContain(SENTINEL);
      expect(out.stdout).not.toContain("other job");
      expect(out.stdout).not.toContain(`WROTE ${targets[1] as string}`);
      expect(out.stdout).not.toContain("WROTE /etc");
      expect(out.stdout.trim().endsWith("done")).toBe(true);
      for (const target of targets) expect(existsSync(target), target).toBe(false);
    } finally {
      rmSync(shared, { force: true });
    }
    await other.guest.close();
    await g.guest.close();
  });

  it("has no network of its own: a direct connection to an address fails at once", async () => {
    const g = newGuest();
    const out = await g.run(process.execPath, ["-e", "const s = require('net').connect(80, '93.184.216.34'); s.on('connect', () => { console.log('connected'); process.exit(0); }); s.on('error', (e) => { console.log('error:' + e.code); process.exit(0); }); setTimeout(() => { console.log('timeout'); process.exit(0); }, 5000);"]);
    expect(out.stdout.trim()).toMatch(/^error:(ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL)$/);
    await g.guest.close();
  });

  it("carries no credential name: the environment is the microVM table's names and nothing else of the host's", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-not-real";
    try {
      const g = newGuest();
      const out = await g.run("env", [], guestEnvOf({}));
      const names = out.stdout.split("\n").filter((line) => line.includes("=")).map((line) => line.slice(0, line.indexOf("=")));
      const shellAdds = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
      expect(names.filter((name) => !MICROVM_ENV_NAMES.has(name) && !shellAdds.has(name))).toEqual([]);
      expect(out.stdout).not.toContain("sk-test-not-real");
      await g.guest.close();
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  describe("Unix-domain sockets of the host (the session bus, a container runtime, any other program's socket)", () => {
    /** One connection attempt to a socket path from inside the guest; prints exactly `connected` or `error:<code>`. */
    const CONNECT_UNIX = "const s = require('net').connect(process.argv[1]); s.on('connect', () => { console.log('connected'); process.exit(0); }); s.on('error', (e) => { console.log('error:' + e.code); process.exit(0); }); setTimeout(() => { console.log('timeout'); process.exit(0); }, 5000);";
    const listening: net.Server[] = [];
    const listen = (socketPath: string): Promise<void> => {
      // a client that goes away at once is not an error of the host side
      const server = net.createServer((client) => void client.on("error", () => undefined).end("host-side\n"));
      listening.push(server);
      return new Promise<void>((resolve, reject) => void server.once("error", reject).listen(socketPath, resolve));
    };
    afterAll(() => {
      for (const server of listening.splice(0)) server.close();
    });
    const uid = process.getuid?.() ?? 0;
    const runtimeDir = `/run/user/${String(uid)}`;

    it("control: a host listener in the guest's own root is really reachable from a plain program (the host side works, and the check below is not vacuous)", async () => {
      const g = newGuest();
      const sock = path.join(g.root, "host.sock");
      await listen(sock);
      // the same program, outside any sandbox
      const plain = spawnSync(process.execPath, ["-e", CONNECT_UNIX, sock], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
      expect(plain.stdout.trim()).toBe("connected");
      await g.guest.close();
    });

    it("cannot connect to a listening Unix socket it can see (the seccomp filter refuses the socket call), and the same socket is connectable without the sandbox", async () => {
      const g = newGuest();
      const sock = path.join(g.root, "host.sock");
      await listen(sock);
      const out = await g.run(process.execPath, ["-e", CONNECT_UNIX, sock]);
      expect(out.exitCode).toBe(0);
      expect(out.stdout.trim()).toBe("error:EPERM");
      await g.guest.close();
    });

    it("cannot reach the user's runtime directory: a listening socket placed there is hidden (the directory is an empty memory file system), and so is the real session bus when there is one", async () => {
      if (!existsSync(runtimeDir)) return;
      const placed = path.join(runtimeDir, `fx-hg-test-${String(process.pid)}.sock`);
      await listen(placed);
      try {
        const g = newGuest();
        const targets = [placed, path.join(runtimeDir, "bus"), "/run/docker.sock", "/var/run/docker.sock"].filter((target) => target === placed || existsSync(target));
        const seen = await g.run("sh", ["-c", 'for t in "$@"; do if [ -e "$t" ]; then echo "VISIBLE $t"; fi; done; echo done', "fx", ...targets]);
        // the runtime directory's contents are hidden whole; the container runtime's socket is out of reach by the filter, not by a path
        expect(seen.stdout).not.toContain(`VISIBLE ${placed}`);
        expect(seen.stdout).not.toContain(`VISIBLE ${path.join(runtimeDir, "bus")}`);
        for (const target of targets) {
          const out = await g.run(process.execPath, ["-e", CONNECT_UNIX, target]);
          expect(out.stdout.trim(), target).toMatch(/^error:(ENOENT|EPERM)$/);
        }
        await g.guest.close();
      } finally {
        rmSync(placed, { force: true });
      }
    });

    it("the forwarder still reaches the registry through the proxy while the same command's own Unix connect is refused (the forwarder is outside the filter, the command inside it)", async () => {
      const g = newGuest();
      const sock = path.join(g.root, "host2.sock");
      await listen(sock);
      await g.guest.updateNetworkPolicy(projectSetupPolicy());
      const both = "const {execFileSync} = require('child_process'); const out = []; out.push(execFileSync(process.execPath, ['-e', process.argv[1], process.argv[2]]).toString().trim()); out.push(execFileSync(process.execPath, ['-e', process.argv[3], 'registry.npmjs.org', '443']).toString().trim()); console.log(JSON.stringify(out));";
      const run = await g.run(process.execPath, ["-e", both, CONNECT_UNIX, sock, CONNECT_CLIENT], guestEnvOf({}));
      expect(run.exitCode).toBe(0);
      const [unixAnswer, viaProxy] = JSON.parse(run.stdout.trim()) as [string, string];
      expect(unixAnswer).toBe("error:EPERM");
      expect(JSON.parse(viaProxy)).toContain("200 Connection Established");
      await g.guest.close();
    }, 60_000);

    describe("the forwarder's socket cannot be swapped by the command (the command runs as the runner's own uid and writes its whole root)", () => {
      /** A host listener the test controls: it records every connection and answers `TRAP`, standing for a container runtime's socket the forwarder could reach by path. */
      const trap = async (socketPath: string): Promise<{ hits: () => number }> => {
        let hits = 0;
        const server = net.createServer((client) => {
          hits += 1;
          client.on("error", () => undefined).end("HTTP/1.1 200 TRAP\r\n\r\n");
        });
        listening.push(server);
        await new Promise<void>((resolve, reject) => void server.once("error", reject).listen(socketPath, resolve));
        return { hits: () => hits };
      };
      /** Every way to put another socket, link or file where the forwarder looks, then a request through the loopback port; prints one JSON line `{ ops, answer }`. */
      const SWAP = [
        'S="$1/v.sock_5253"; T="$2"; ops=""',
        'try() { name=$1; shift; if "$@" 2>/dev/null; then ops="$ops $name=ok"; else ops="$ops $name=refused"; fi; }',
        'try rm rm "$S"',
        'try symlink ln -s "$T" "$S"',
        'try rename mv "$S" "$S.moved"',
        'try hardlink ln "$T" "$S"',
        'try create sh -c \': >"$0"\' "$S"',
        'try newdir mkdir "$1/sub"',
        'try dirrename mv "$1" "$1.moved"',
        'try rmdir rmdir "$1"',
        'try chmod chmod 0777 "$1"',
        'shift 2; ANSWER=$1; shift; NODE=$1; shift; CLIENT=$1; shift; PORT=$1',
        '"$NODE" -e "$(cat "$CLIENT")" registry.npmjs.org "$PORT" > "$ANSWER"',
        'echo "$ops"',
      ].join("\n");
      const swap = async (g: ReturnType<typeof newGuest>, trapSocket: string): Promise<{ ops: string; answer: string }> => {
        const answerFile = path.join(g.root, "answer.json");
        const client = path.join(g.root, "client.cjs");
        writeFileSync(client, CONNECT_CLIENT);
        const run = await g.run("sh", ["-c", SWAP, "fx", g.egressDir, trapSocket, answerFile, process.execPath, client, "443"], guestEnvOf({}));
        expect(run.exitCode).toBe(0);
        return { ops: run.stdout.trim(), answer: readFileSync(answerFile, "utf8").trim() };
      };

      it("control: the same swaps all succeed on a socket kept in the job root (this is the hole, and the check below is not vacuous)", async () => {
        const g = newGuest();
        const place = path.join(g.root, "inroot");
        mkdirSync(place);
        await listen(path.join(place, "v.sock_5253"));
        const out = await g.run("sh", ["-c", 'rm -f "$1/v.sock_5253" && ln -s "$2" "$1/v.sock_5253" && echo swapped', "fx", place, "/does/not/matter"]);
        expect(out.stdout.trim()).toBe("swapped");
        await g.guest.close();
      });

      it("before the proxy listens: nothing can be created, linked or moved where the forwarder looks, and the request never reaches the host listener", async () => {
        const g = newGuest();
        const target = await trap(path.join(g.root, "trap.sock"));
        const before = readdirSync(g.egressDir);
        const { ops, answer } = await swap(g, path.join(g.root, "trap.sock"));
        expect(ops).toBe("rm=refused symlink=refused rename=refused hardlink=refused create=refused newdir=refused dirrename=refused rmdir=refused chmod=refused");
        expect(readdirSync(g.egressDir)).toEqual(before);
        expect(target.hits()).toBe(0);
        expect(answer).not.toContain("TRAP");
        await g.guest.close();
      }, 60_000);

      it("while the proxy listens: the socket stays the proxy's after rm, a symlink, a rename and a hard link, the request never reaches the host listener, and the registry still works through the proxy", async () => {
        const g = newGuest();
        const target = await trap(path.join(g.root, "trap.sock"));
        await g.guest.updateNetworkPolicy(projectSetupPolicy());
        const socket = path.join(g.egressDir, "v.sock_5253");
        const identity = statSync(socket).ino;
        const { ops, answer } = await swap(g, path.join(g.root, "trap.sock"));
        expect(ops).toBe("rm=refused symlink=refused rename=refused hardlink=refused create=refused newdir=refused dirrename=refused rmdir=refused chmod=refused");
        expect(lstatSync(socket).isSocket()).toBe(true);
        expect(statSync(socket).ino).toBe(identity);
        expect(readdirSync(g.egressDir)).toEqual(["v.sock_5253"]);
        expect(target.hits()).toBe(0);
        expect(answer).toContain("200 Connection Established");
        expect(answer).not.toContain("TRAP");
        // and a second command still gets through the proxy
        expect(JSON.parse((await g.run(process.execPath, ["-e", CONNECT_CLIENT, "registry.npmjs.org", "443"], guestEnvOf({}))).stdout.trim())).toContain("from-registry");
        expect(target.hits()).toBe(0);
        await g.guest.close();
      }, 60_000);

      it("a link planted in the job root itself (the old place of the socket) leads nowhere: the forwarder does not look there", async () => {
        const g = newGuest();
        const target = await trap(path.join(g.root, "trap.sock"));
        await g.guest.updateNetworkPolicy(projectSetupPolicy());
        mkdirSync(path.join(g.root, "egress"));
        symlinkSync(path.join(g.root, "trap.sock"), path.join(g.root, "egress", "v.sock_5253"));
        const out = JSON.parse((await g.run(process.execPath, ["-e", CONNECT_CLIENT, "registry.npmjs.org", "443"], guestEnvOf({}))).stdout.trim()) as string;
        expect(out).toContain("200 Connection Established");
        expect(target.hits()).toBe(0);
        await g.guest.close();
      }, 60_000);
    });

    describe("the forwarder is out of the command's reach", () => {
      it("the command cannot see the forwarder or the wrapper in the process table, cannot signal it, and the forwarder is really running (it still relays afterwards)", async () => {
        const g = newGuest();
        await g.guest.updateNetworkPolicy(projectSetupPolicy());
        const script = [
          'for p in /proc/[0-9]*; do tr "\\0" " " <"$p/cmdline" 2>/dev/null; echo; done > "$1/table.txt"',
          'n=0; for p in /proc/[0-9]*; do n=$((n + 1)); done; echo "count=$n"',
          // the one process that must be refused whatever its number: every other one this command may signal is its own
          'for p in /proc/[0-9]*; do pid=${p#/proc/}; if tr "\\0" " " <"$p/cmdline" 2>/dev/null | grep -q \'e[g]ress-\'; then echo "SEEN $pid"; kill -9 "$pid" 2>/dev/null && echo "KILLED $pid"; fi; done',
          'echo done',
        ].join("\n");
        const out = await g.run("sh", ["-c", script, "fx", g.root]);
        expect(out.stdout).toContain("done");
        expect(out.stdout).not.toContain("SEEN");
        expect(out.stdout).not.toContain("KILLED");
        expect(readFileSync(path.join(g.root, "table.txt"), "utf8")).not.toContain("__egress");
        expect(JSON.parse((await g.run(process.execPath, ["-e", CONNECT_CLIENT, "registry.npmjs.org", "443"], guestEnvOf({}))).stdout.trim())).toContain("200 Connection Established");
        await g.guest.close();
      }, 60_000);

      it("control: from the host the forwarder IS in the process table while a command runs (so the check above is not vacuous)", async () => {
        const g = newGuest();
        const command = await g.guest.runCommand({ cmd: "sleep", args: ["20"], detached: true });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const seen = spawnSync("pgrep", ["-f", `__egress-serve ${g.egressDir}`], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } }).stdout.trim();
        expect(seen).not.toBe("");
        await command.kill("SIGKILL");
        await command.wait();
        await g.guest.close();
      }, 60_000);
    });

    it("cannot start a new namespace of its own to get around the filter's view (unshare is refused)", async () => {
      const g = newGuest();
      const out = await g.run("sh", ["-c", "unshare --user --map-root-user true 2>&1; echo exit=$?"]);
      expect(out.stdout).toMatch(/exit=[1-9]/);
      await g.guest.close();
    });
  });

  it("ends the whole command tree when it is killed: nothing it started is left", async () => {
    const g = newGuest();
    const command = await g.guest.runCommand({ cmd: "sh", args: ["-c", "sleep 31337 & sleep 31338; true"], detached: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await command.kill("SIGKILL");
    expect((await command.wait()).exitCode).toBe(137);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // pgrep exits 1 with no output when nothing matches
    expect(spawnSync("pgrep", ["-f", "sleep 3133[78]"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } }).stdout.trim()).toBe("");
    await g.guest.close();
  }, 30_000);
});

describe.skipIf(!usable)("the way out: the forwarder, the runner's proxy and the closed policy", () => {
  const via = async (g: ReturnType<typeof newGuest>, host: string): Promise<string> => JSON.parse((await g.run(process.execPath, ["-e", CONNECT_CLIENT, host, "443"], guestEnvOf({}))).stdout.trim()) as string;

  it("has no way out until the policy is in force: the forwarder has nothing to relay to", async () => {
    const g = newGuest();
    expect(await via(g, "registry.npmjs.org")).not.toContain("200");
    await g.guest.close();
  });

  it("with the project_setup policy a registry host is reached through the proxy, and github.com, an address literal and a name that resolves to a blocked address are refused", async () => {
    const g = newGuest();
    await g.guest.updateNetworkPolicy(projectSetupPolicy());
    decisions.length = 0;
    const reached = await via(g, "registry.npmjs.org");
    expect(reached).toContain("HTTP/1.1 200 Connection Established");
    expect(reached).toContain("from-registry");
    expect(await via(g, "files.pythonhosted.org")).toContain("200 Connection Established");
    expect(await via(g, "github.com")).toContain("403 not_allowed");
    expect(await via(g, "api.github.com")).toContain("403 not_allowed");
    expect(await via(g, "93.184.216.34")).toContain("403 address_literal");
    expect(await via(g, "127.0.0.1")).toContain("403 address_literal");
    // pypi.org is in the policy but the (stand-in) resolver answers a private address for it
    expect(await via(g, "pypi.org")).toContain("403 blocked_address");
    expect(decisions).toEqual(["allow:registry.npmjs.org", "allow:files.pythonhosted.org", "not_allowed:github.com", "not_allowed:api.github.com", "address_literal:-", "address_literal:-", "blocked_address:pypi.org"]);
    await g.guest.close();
  }, 60_000);

  it("a port other than 443 is refused too", async () => {
    const g = newGuest();
    await g.guest.updateNetworkPolicy(projectSetupPolicy());
    const out = JSON.parse((await g.run(process.execPath, ["-e", CONNECT_CLIENT, "registry.npmjs.org", "22"], guestEnvOf({}))).stdout.trim()) as string;
    expect(out).toContain("403 port_refused");
    await g.guest.close();
  });

  it("the forwarder reports a program it cannot start as a closed failure, not a hang (no runner program at that path)", async () => {
    const deps = { ...depsFor(), selfCommand: [path.join(base, "bin", "missing-runner")] };
    mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
    const root = path.join(jobsRoot, `g-t${String(counter++)}`);
    mkdirSync(root, { mode: 0o700 });
    const guest = createHostGuest(deps, "su-missing", root).guest;
    const out = await runInGuest(guest, { cmd: "true", args: [] }, 30_000);
    expect(out.exitCode).toBe(125);
    expect(out.stderr).toContain("the egress forwarder did not start");
    await guest.close();
  }, 60_000);
});

describe.skipIf(!usable)("files and the root's removal", () => {
  it("files written through writeFiles are the guest's, and a link the guest planted is never written through", async () => {
    const g = newGuest();
    await g.guest.writeFiles([{ path: path.join(g.root, "stage", "a.txt"), content: "from host" }]);
    const out = await g.run("sh", ["-c", 'cat stage/a.txt; ln -s "$1" stage/trap'], undefined);
    expect(out.stdout).toBe("from host");
    // an absolute target the host can see: writing "through" stage/trap would reach it
    const victim = path.join(base, "victim.txt");
    writeFileSync(victim, "keep");
    symlinkSync(victim, path.join(g.root, "stage", "trap2"));
    await expect(g.guest.writeFiles([{ path: path.join(g.root, "stage", "trap2"), content: "pwn" }])).rejects.toThrow();
    expect(readFileSync(victim, "utf8")).toBe("keep");
    await g.guest.close();
  });

  it("the port removes a root a package manager left read-only", async () => {
    const vm = createHostSetupVm(depsFor());
    const port = vm.lifecycle.port as Exclude<typeof vm.lifecycle.port, (...args: never[]) => unknown>;
    await port.create("su-readonly", "agent");
    await port.waitGuest("su-readonly", new AbortController().signal);
    const guest = await vm.guestOf({ runId: "", sandboxName: "su-readonly", sessionId: "" });
    const paths = vm.pathsOf("su-readonly");
    await runInGuest(guest, { cmd: "sh", args: ["-c", 'mkdir -p "$1/ro/inner" && echo x >"$1/ro/inner/f" && chmod -R a-w "$1/ro"', "fx", paths.stage] }, 30_000);
    await port.delete("su-readonly");
    expect(existsSync(path.dirname(paths.stage))).toBe(false);
  }, 60_000);
});

// ---- a whole project setup ----

interface Outcome {
  progress: ReturnType<typeof fakeCloud>["progress"];
  tree: string;
  commit: string;
  files: string[];
}

/** One whole setup of `fx` with the same fixture engine and job, through `slice`: the handler is the production one; only the guest differs. */
async function setupThrough(fx: ReturnType<typeof fixtureRepo>, slice: "microvm-stand-in" | "standard", options: { engine?: Parameters<typeof fixtureEngineTgz>[0] } = {}): Promise<Outcome & { guestHosts: string[] }> {
  const engine = fixtureEngineTgz(options.engine);
  const world = fakeCloud({ engine, baseSha: fx.commit, issuedAt: "2026-11-21T12:00:00.000Z" });
  const deps = hostDeps();
  const hostWs = hostWorkspace(fx.mirror, fx.commit);
  const repos: SetupRepos = { open: async () => ({ mirrorDir: fx.mirror, workspace: hostWs, archive: await buildWorkspaceArchive(deps, fx.mirror, fx.commit), release: async () => undefined }) };
  const logDir = mkdtempSync(path.join(socketTmpRoot(), "fxhg-log-"));
  const caps = { maxVms: 2, maxVcpus: 2, maxMemoryMb: 2048, snapshotDir: "/unused", snapshotQuotaBytes: 0 };
  const lifecycleBase = { registry: new VmRegistry(), caps, request: { vcpus: 1, memoryMb: 512 }, readMemAvailableBytes: () => 64 * 2 ** 30 };
  let vm: ProjectSetupDeps["vm"];
  let paths: ProjectSetupDeps["paths"];
  if (slice === "standard") {
    vm = createHostSetupVm(depsFor());
  } else {
    // the microVM path's own scripts on a local directory standing for the guest (the real microVM is `test/vm/projectSetup.real.test.ts`)
    const guest = localGuest();
    const port: VmPort = { create: async () => undefined, startEgress: async () => undefined, waitGuest: async () => undefined, releaseEgress: async () => undefined, stop: async () => undefined, destroy: async () => undefined, delete: async () => undefined };
    const real = guest.guest.runCommand.bind(guest.guest);
    const wrapped = { ...guest.guest, runCommand: (params: Parameters<typeof real>[0]) => real({ ...params, env: Object.fromEntries(Object.entries(params.env ?? {}).filter(([name]) => name !== "PATH" && name !== "HOME")) }) } as unknown as Awaited<ReturnType<NonNullable<ProjectSetupDeps["vm"]>["guestOf"]>>;
    vm = { guestOf: async () => wrapped, lifecycle: { port, ...lifecycleBase } };
    paths = guest.paths;
  }
  const pw = await pushWorld({ seed: { repo: fx.repo, branch: "main" } });
  try {
    await createProjectSetupHandler({ client: world.client, vm, repos, push: pw.deps, apply: (input) => applyBundle({ git: deps.git, gitLarge: deps.gitLarge, scratchDir: deps.scratchDir, policy: workflowPolicy(deps.gitLarge) }, input), logDir, transport: serveBytes(engine), ...(paths === undefined ? {} : { paths }) })({ job: world.job, reporter: world.reporter, signal: world.signal });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
    await pw.close();
  }
  return { progress: world.progress, tree: git(hostWs, "rev-parse", "HEAD^{tree}"), commit: git(hostWs, "rev-parse", "HEAD"), files: git(hostWs, "ls-tree", "-r", "--name-only", "HEAD").split("\n"), guestHosts: [] };
}

const CORE = ["preflight:started", "preflight:ok", "interview:started", "interview:ok", "wiring:started", "wiring:ok", "deps:started", "deps:ok", "labels:skipped:cloud_owned", "sandbox_hook:started", "sandbox_hook:ok", "bundle:ok", "done:ok"];

describe.skipIf(!usable)("a whole project setup on the standard tier", () => {
  it("parity: the same fixture and fixture engine give the same tree id and the same commit id through the microVM path's scripts and through the OS sandbox", async () => {
    const fx = fixtureRepo();
    const micro = await setupThrough(fx, "microvm-stand-in");
    const standard = await setupThrough(fx, "standard");
    expect(compact(standard.progress).filter((line) => !line.startsWith("engine_") && !line.startsWith("plan_"))).toEqual(compact(micro.progress).filter((line) => !line.startsWith("engine_") && !line.startsWith("plan_")));
    expect(compact(standard.progress).slice(-19)).toEqual(["bootstrap:started", "bootstrap:ok", ...CORE, "finalize:started", "finalize:ok", "bundle_out:started", "bundle_out:ok", "push:started", "push:ok"].slice(-19));
    expect(standard.tree).toBe(micro.tree);
    expect(standard.commit).toBe(micro.commit);
    expect(standard.files).toEqual(expect.arrayContaining([".autonomous-team/project.json", ".autonomous-team/config.json", ".autonomous-team/CLAUDE.project.md", "docs/PRD.md", "README.md"]));
  }, 180_000);

  it("leaves no job root in the jobs directory once a setup has ended", async () => {
    const fx = fixtureRepo();
    const standard = await setupThrough(fx, "standard");
    expect(compact(standard.progress).at(-1)).toBe("push:ok");
    expect(existsSync(jobsRoot) ? readdirSync(jobsRoot).filter((name) => name.startsWith("g-") && !name.startsWith("g-t")) : []).toEqual([]);
  }, 120_000);

  it("a hostile engine's bundle is refused on the standard tier exactly as in a microVM (a link out of the tree)", async () => {
    const fx = fixtureRepo();
    const micro = await setupThrough(fx, "microvm-stand-in", { engine: { bootstrapCommits: "link_kept" } });
    const standard = await setupThrough(fx, "standard", { engine: { bootstrapCommits: "link_kept" } });
    expect(compact(micro.progress).at(-1)).toBe("bundle_out:failed:bundle_refused/symlink");
    expect(compact(standard.progress).at(-1)).toBe("bundle_out:failed:bundle_refused/symlink");
  }, 180_000);

  it("a coldstart that drops a core topic fails the same way with the sandbox's root removed", async () => {
    const fx = fixtureRepo();
    const standard = await setupThrough(fx, "standard", { engine: { coreTopics: ["identity", "stack", "deploy", "autonomy", "mission", "roster"] } });
    expect(compact(standard.progress).at(-1)).toBe("interview:failed:missing_topic:roster");
  }, 120_000);
});

/**
 * The runner's whole cache directory is hidden from the guest wherever `XDG_CACHE_HOME` put it. Layout as `cacheRootsFor` builds it: `<cache>/fx-runner/{mirrors,workspaces,tmp,spill,launch,setup-guests,setup-egress}`.
 * The cache here sits OUTSIDE the fake home (the case where denying the home directory alone covers nothing) and, in the second case, in the default place under it.
 */
describe.skipIf(!usable)("the runner's cache directory is hidden from the guest", () => {
  const HIDDEN = "FX-CACHE-HIDDEN-SENTINEL";
  let saved: string;
  beforeAll(() => {
    saved = jobsRoot;
  });
  afterAll(() => {
    jobsRoot = saved;
    declaredCache = undefined;
  });

  /** Plants a sentinel in each sibling directory of the cache, and returns their paths. */
  const plant = (cacheDir: string): string[] => {
    const files = ["mirrors/github.com/o/r.git/HEAD", "workspaces/job-1/secret.txt", "tmp/job-1/scratch.txt", "spill/run-1/prompt.txt", "launch/q-1/note.txt"].map((rel) => path.join(cacheDir, rel));
    for (const file of files) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, HIDDEN);
    }
    return files;
  };

  it("an XDG_CACHE_HOME outside the home directory: no mirror, workspace, temp, spill or launch file, and no other guest's root, can be read; its own root and egress still work", async () => {
    const cacheDir = path.join(base, "xdg-cache", "fx-runner");
    jobsRoot = path.join(cacheDir, "setup-guests");
    const files = plant(cacheDir);
    const other = newGuest();
    writeFileSync(path.join(other.root, "theirs.txt"), HIDDEN);
    const g = newGuest();
    for (const file of [...files, path.join(other.root, "theirs.txt")]) {
      expect(readFileSync(file, "utf8"), file).toBe(HIDDEN); // control: really there
      const out = await g.run("sh", ["-c", 'cat "$1" 2>&1; echo "exit=$?"', "fx", file]);
      expect(out.stdout, file).not.toContain(HIDDEN);
      expect(out.stdout, file).toMatch(/exit=[1-9]/);
    }
    const listing = await g.run("sh", ["-c", 'ls "$1" 2>&1; echo "exit=$?"', "fx", path.join(cacheDir, "mirrors")]);
    expect(listing.stdout).not.toContain("github.com");
    // its own root and its egress directory are the narrower grants
    const own = await g.run("sh", ["-c", 'echo ok >w.txt; cat w.txt; ls "$1"', "fx", g.egressDir]);
    expect(own.stdout.split("\n")[0]).toBe("ok");
    await g.guest.updateNetworkPolicy(projectSetupPolicy());
    expect(JSON.parse((await g.run(process.execPath, ["-e", CONNECT_CLIENT, "registry.npmjs.org", "443"], guestEnvOf({}))).stdout.trim())).toContain("from-registry");
    await other.guest.close();
    await g.guest.close();
  }, 120_000);

  it("an engine session's layout (`engine-sessions/roots`, nested one level below the cache directory) hides the cache outside the home directory too: the mirrors are not readable, the session's own root and egress work", async () => {
    const cache = path.join(base, "xdg-cache-sessions", "fx-runner");
    declaredCache = cache;
    jobsRoot = path.join(cache, "engine-sessions", "roots");
    const files = plant(cache);
    const g = newGuest();
    try {
      for (const file of files) {
        expect(readFileSync(file, "utf8"), file).toBe(HIDDEN); // control: really there
        const out = await g.run("sh", ["-c", 'cat "$1" 2>&1; echo "exit=$?"', "fx", file]);
        expect(out.stdout, file).not.toContain(HIDDEN);
        expect(out.stdout, file).toMatch(/exit=[1-9]/);
      }
      const listing = await g.run("sh", ["-c", 'ls "$1" 2>&1; echo "exit=$?"', "fx", path.join(cache, "mirrors")]);
      expect(listing.stdout).not.toContain("github.com");
      const own = await g.run("sh", ["-c", 'echo ok >w.txt; cat w.txt; ls "$1"', "fx", g.egressDir]);
      expect(own.stdout.split("\n")[0]).toBe("ok");
    } finally {
      await g.guest.close();
      declaredCache = undefined;
    }
  }, 120_000);

  it("the default layout (cache under the home directory) still works: own root, writes, tools and egress", async () => {
    const cacheDir = path.join(home, ".cache", "fx-runner");
    jobsRoot = path.join(cacheDir, "setup-guests");
    const files = plant(cacheDir);
    const g = newGuest();
    const out = await g.run("sh", ["-c", "pwd; echo ok >w.txt; cat w.txt; command -v git >/dev/null && echo tools-ok"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.split("\n").slice(0, 3)).toEqual([g.root, "ok", "tools-ok"]);
    const read = await g.run("sh", ["-c", 'cat "$1" 2>&1; echo "exit=$?"', "fx", files[0] as string]);
    expect(read.stdout).not.toContain(HIDDEN);
    await g.guest.updateNetworkPolicy(projectSetupPolicy());
    expect(JSON.parse((await g.run(process.execPath, ["-e", CONNECT_CLIENT, "registry.npmjs.org", "443"], guestEnvOf({}))).stdout.trim())).toContain("from-registry");
    await g.guest.close();
  }, 120_000);
});
