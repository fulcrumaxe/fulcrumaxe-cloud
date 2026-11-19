import { constants, fstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, createGuestAgent, viaFirecrackerVsock } from "../../../src/vm/sandboxd/guestAgent.js";
import { VsockRefused, dialVsockDir, hasForeignListener, type FdOps } from "../../../src/vm/sandboxd/vsockFd.js";
import { makeRig, realOps, runCleanups, scratch, startFakeAgent } from "./helpers.js";

afterEach(runCleanups);

/** A real Unix socket at `<dir>/<name>` that says hello to whoever connects, so a connect through a fd path can be told from a refused one. */
function listen(dir: string, name = "v.sock"): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((s) => {
      s.on("error", () => undefined);
      s.end("hello");
    });
    server.listen(path.join(dir, name), () => resolve(server));
  });
}
const read = (s: net.Socket): Promise<string> => new Promise((resolve) => s.once("data", (c) => resolve(String(c))));
const isOpen = (fd: number): boolean => {
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

/** Real calls, with the connector and the stat answers a test wants to change; `dialed` records every path the connector was given. */
function ops(over: Partial<FdOps> = {}): FdOps & { dialed: string[]; opened: number[] } {
  const real = realOps();
  const dialed: string[] = [];
  const opened: number[] = [];
  return {
    ...real,
    open: (p, flags) => {
      const fd = real.open(p, flags);
      opened.push(fd);
      return fd;
    },
    dial: (p) => (dialed.push(p), real.dial(p)),
    ...over,
    dialed,
    opened,
  };
}

describe("the connect goes through checked fds", () => {
  it("connects through /proc/self/fd/N (never the path of v.sock), with the fd still open at the connect, and closes every fd afterwards", async () => {
    const dir = scratch();
    const server = await listen(dir);
    let socketFdWasOpen = false;
    let socketFdWasSocket = false;
    const o = ops();
    const real = o.dial;
    o.dial = (p) => {
      const m = /^\/proc\/self\/fd\/(\d+)$/.exec(p);
      if (m !== null) {
        socketFdWasOpen = isOpen(Number(m[1]));
        socketFdWasSocket = fstatSync(Number(m[1])).isSocket();
      }
      return real(p);
    };
    const socket = await dialVsockDir(dir, o);
    expect(await read(socket)).toBe("hello");
    socket.destroy();
    server.close();
    expect(o.dialed).toHaveLength(1);
    expect(o.dialed[0]).toMatch(/^\/proc\/self\/fd\/\d+$/);
    expect(o.dialed[0]).not.toContain("v.sock");
    expect(socketFdWasOpen).toBe(true);
    expect(socketFdWasSocket).toBe(true);
    expect(o.opened.length).toBe(2); // the directory and the socket, each opened once
    expect(o.opened.filter(isOpen)).toEqual([]); // and both closed again
  });

  it("opens v.sock inside the directory fd and the directory by O_PATH|O_NOFOLLOW|O_DIRECTORY", async () => {
    const dir = scratch();
    const server = await listen(dir);
    const seen: Array<{ p: string; flags: number }> = [];
    const o = ops({ open: (p, flags) => (seen.push({ p, flags }), realOps().open(p, flags)) });
    (await dialVsockDir(dir, o)).destroy();
    server.close();
    expect(seen[0]).toEqual({ p: dir, flags: 0o10000000 | constants.O_NOFOLLOW | constants.O_DIRECTORY });
    expect(seen[1]?.p).toMatch(/^\/proc\/self\/fd\/\d+\/v\.sock$/);
    expect(seen[1]?.flags).toBe(0o10000000 | constants.O_NOFOLLOW);
  });

  it("refuses a v.sock that is a symlink to a real socket, connects to nothing, and leaves no fd open", async () => {
    const dir = scratch();
    const server = await listen(dir, "real.sock");
    symlinkSync(path.join(dir, "real.sock"), path.join(dir, "v.sock"));
    const o = ops();
    await expect(dialVsockDir(dir, o)).rejects.toBeInstanceOf(VsockRefused);
    server.close();
    expect(o.dialed).toEqual([]);
    expect(o.opened.filter(isOpen)).toEqual([]);
  });

  it("refuses a vsock directory that is a symlink", async () => {
    const root = scratch();
    mkdirSync(path.join(root, "real"));
    const server = await listen(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "link"));
    const o = ops();
    await expect(dialVsockDir(path.join(root, "link"), o)).rejects.toBeInstanceOf(VsockRefused);
    server.close();
    expect(o.dialed).toEqual([]);
  });

  it("refuses a v.sock owned by another uid, and a directory owned by another uid", async () => {
    const dir = scratch();
    const server = await listen(dir);
    const real = realOps();
    const elsewhere = (which: "socket" | "dir"): ReturnType<typeof ops> =>
      ops({ fstat: (fd) => {
        const st = real.fstat(fd);
        const wrong = which === "socket" ? st.isSocket() : st.isDirectory();
        return { isDirectory: () => st.isDirectory(), isSocket: () => st.isSocket(), isSymbolicLink: () => st.isSymbolicLink(), uid: wrong ? st.uid + 1 : st.uid, gid: st.gid, mode: st.mode };
      } });
    for (const which of ["socket", "dir"] as const) {
      const o = elsewhere(which);
      await expect(dialVsockDir(dir, o), which).rejects.toBeInstanceOf(VsockRefused);
      expect(o.dialed, which).toEqual([]);
    }
    server.close();
  });

  it("refuses a v.sock that is not a socket (a regular file) and one that is missing", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "v.sock"), "not a socket");
    const o = ops();
    await expect(dialVsockDir(dir, o)).rejects.toBeInstanceOf(VsockRefused);
    expect(o.dialed).toEqual([]);
    expect(o.opened.filter(isOpen)).toEqual([]);
    await expect(dialVsockDir(path.join(dir, "nothing"), ops())).rejects.toBeInstanceOf(VsockRefused);
  });

  it("closes the fds when the connect itself fails (a socket file nobody listens on)", async () => {
    const dir = scratch();
    const server = await listen(dir);
    await new Promise<void>((r) => server.close(() => r())); // the socket file stays or goes; either way there is no listener
    const o = ops();
    await expect(dialVsockDir(dir, o)).rejects.toBeInstanceOf(VsockRefused);
    expect(o.opened.filter(isOpen)).toEqual([]);
  });

  it("a refusal reaches the agent as one fixed error, not the system's message", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "v.sock"), "x");
    const agent = createGuestAgent(viaFirecrackerVsock(() => dialVsockDir(dir, ops())), 500);
    const err = await agent.ping().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: "unreachable" });
    expect(String((err as Error).message)).not.toContain(dir);
  });

  it("the production agent reaches a guest through the real fd path (the rig's fake agent runs the real protocol)", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create({ name: "fd", template: "fx-agent", vcpus: 2, memMb: 512 });
    expect(rig.agents.get("fd")?.pings).toBeGreaterThan(0);
    await sb.writeFiles([{ path: "/x", content: Buffer.from("fd") }]);
    expect(rig.agents.get("fd")?.files.get("/x")?.data.toString()).toBe("fd");
  });
});

describe("a foreign v.sock_<port> in the vsock directory", () => {
  const real = realOps();
  /** Real calls, but every entry that is not a directory looks owned by another uid. */
  const foreignOwner: FdOps = { ...real, fstat: (fd) => {
    const st = real.fstat(fd);
    return { isDirectory: () => st.isDirectory(), isSocket: () => st.isSocket(), isSymbolicLink: () => st.isSymbolicLink(), uid: st.isDirectory() ? st.uid : st.uid + 1, gid: st.gid, mode: st.mode };
  } };

  it("is found by name prefix and owner: the runner's own listeners and other files are fine", () => {
    const dir = scratch();
    expect(hasForeignListener(dir, realOps())).toBe(false);
    writeFileSync(path.join(dir, "v.sock_5253"), "");
    writeFileSync(path.join(dir, "v.sock_5254"), "");
    writeFileSync(path.join(dir, "unrelated"), "");
    expect(hasForeignListener(dir, realOps())).toBe(false); // owned by this process
    expect(hasForeignListener(dir, foreignOwner)).toBe(true); // the same entries, owned by someone else
    const other = scratch();
    writeFileSync(path.join(other, "unrelated"), "");
    expect(hasForeignListener(other, foreignOwner)).toBe(false); // not a listener name: not this check's business
  });

  it("a symlink at a listener name is looked at as the link itself, and an unreadable directory counts as foreign", () => {
    const dir = scratch();
    symlinkSync("/nonexistent-target", path.join(dir, "v.sock_5253"));
    expect(hasForeignListener(dir, foreignOwner)).toBe(true);
    expect(hasForeignListener(path.join(dir, "missing"), realOps())).toBe(true);
  });

  it("a symlink at a listener name is foreign even when it is owned by the runner and points at a file the runner owns", () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "target"), "");
    symlinkSync(path.join(dir, "target"), path.join(dir, "v.sock_5253"));
    expect(hasForeignListener(dir, realOps())).toBe(true); // real ops: the link itself is ours, and still refused
  });

  it("the daemon does not start a sandbox whose vsock directory holds one, and destroys the VM it prepared", async () => {
    const rig = makeRig({ extra: { hasForeignListener: (dir) => hasForeignListener(dir, foreignOwner) } });
    rig.helper.onStart = (_id, dir) => writeFileSync(path.join(dir, "v.sock_5253"), "");
    await expect(rig.daemon.create({ name: "planted", template: "fx-agent", vcpus: 2, memMb: 512 })).rejects.toMatchObject({ code: "vsock_dir_refused" });
    expect(rig.helper.frames.map((f) => f["verb"])).toEqual(["prepare", "start", "destroy"]);
    expect(rig.agents.size).toBe(0);
  });

  it("the daemon starts normally when the listeners are the runner's own", async () => {
    const rig = makeRig();
    rig.helper.onStart = (id, dir) => {
      writeFileSync(path.join(dir, "v.sock_5253"), "");
      rig.agents.set(id, startFakeAgent(dir));
    };
    const sb = await rig.daemon.create({ name: "own", template: "fx-agent", vcpus: 2, memMb: 512 });
    expect(sb.status).toBe("running");
  });
});
