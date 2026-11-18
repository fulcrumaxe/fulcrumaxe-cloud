import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEgressProxy, type Decision, type EgressProxy, type EgressProxyOptions, type Lookup } from "../../../src/vm/egress/proxy.js";
import { generateSelfSignedCert } from "../../helpers/selfSignedCert.js";

const UID = process.getuid!();
const PUBLIC_A = "93.184.216.34";
const PUBLIC_B = "93.184.216.35";
const NAMES = ["pkg.example.com", "other.example.com"];
const cert = generateSelfSignedCert("pkg.example.com", 1, { dnsNames: NAMES });

let root: string;
let proxies: EgressProxy[];
let sockets: Set<net.Socket>;
let upstream: https.Server;
let upstreamPort: number;
let upstreamHits: number;

beforeEach(async () => {
  // Under /tmp, searchable by others (0711), so a user-namespace child can reach the sandbox directory and only that directory's own mode decides.
  root = mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : os.tmpdir(), "fx-egress-"));
  chmodSync(root, 0o711);
  proxies = [];
  sockets = new Set();
  upstreamHits = 0;
  upstream = https.createServer({ key: cert.keyPem, cert: cert.certPem }, (_req, res) => {
    upstreamHits += 1;
    res.end("registry says hello");
  });
  upstream.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterEach(async () => {
  for (const p of proxies) await p.close();
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

interface Harness {
  proxy: EgressProxy;
  lookups: string[];
  connects: Array<{ address: string; port: number }>;
  decisions: Decision[];
}

/** A proxy on a real Unix socket. `answers` is what each lookup of a name returns, in order; the last one repeats. The upstream leg is the real `net.connect`, aimed at the local TLS server. */
async function start(policy: unknown, answers: Record<string, string[][]> = {}, extra: Partial<EgressProxyOptions> = {}, id = "sb1"): Promise<Harness> {
  const dir = path.join(root, id);
  mkdirSync(dir, { mode: 0o1770 });
  chmodSync(dir, 0o1770);
  const h = { lookups: [] as string[], connects: [] as Array<{ address: string; port: number }>, decisions: [] as Decision[] } as Harness;
  const seen: Record<string, number> = {};
  const lookup: Lookup = async (host) => {
    h.lookups.push(host);
    const list = answers[host];
    if (!list) throw new Error("ENOTFOUND");
    const n = seen[host] ?? 0;
    seen[host] = n + 1;
    return (list[Math.min(n, list.length - 1)] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  h.proxy = await startEgressProxy({
    uid: UID,
    vsockDir: dir,
    sandboxId: id,
    policy,
    lookup,
    ownAddresses: () => new Set(["198.51.100.9", PUBLIC_B]),
    connect: (address, port) => {
      h.connects.push({ address, port });
      return net.connect({ host: "127.0.0.1", port: upstreamPort });
    },
    onDecision: (d) => h.decisions.push(d),
    ...extra,
  });
  proxies.push(h.proxy);
  return h;
}

/** What the in-guest shim sends: CONNECT over the VM's Unix socket. */
function connectVia(socketPath: string, authority: string): Promise<{ status: number; message: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: "CONNECT", path: authority });
    req.once("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, message: res.statusMessage ?? "", socket }));
    req.once("error", reject);
    req.end();
  });
}

async function fetchThrough(socketPath: string, host: string): Promise<string> {
  const { status, socket } = await connectVia(socketPath, `${host}:443`);
  expect(status).toBe(200);
  return new Promise((resolve, reject) => {
    // Real TLS over the tunnel, verified against the generated certificate for this name.
    const secure = tls.connect({ socket, servername: host, ca: cert.certPem }, () => secure.write(`GET / HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`));
    let body = "";
    secure.on("data", (c) => (body += String(c)));
    secure.once("end", () => resolve(body));
    secure.once("error", reject);
  });
}

async function refusal(h: Harness, authority: string): Promise<string> {
  const { status, message, socket } = await connectVia(h.proxy.socketPath, authority);
  socket.destroy();
  expect(status === 403 || status === 502 || status === 400, `${authority} -> ${status}`).toBe(true);
  return message;
}

describe("egress proxy: an allowed host", () => {
  it("tunnels real TLS to the policy's host, connecting to the validated address", async () => {
    const h = await start({ allow: { "pkg.example.com": [] } }, { "pkg.example.com": [[PUBLIC_A]] });
    expect(await fetchThrough(h.proxy.socketPath, "pkg.example.com")).toContain("registry says hello");
    expect(h.connects).toEqual([{ address: PUBLIC_A, port: 443 }]);
    expect(h.lookups).toEqual(["pkg.example.com"]);
    expect(h.decisions).toEqual([{ outcome: "allow", host: "pkg.example.com" }]);
  });
  it("answers 64 parallel tunnels without serialising them", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A]] });
    const bodies = await Promise.all(Array.from({ length: 64 }, () => fetchThrough(h.proxy.socketPath, "pkg.example.com")));
    expect(bodies.every((b) => b.includes("registry says hello"))).toBe(true);
    expect(upstreamHits).toBe(64);
  });
  it("accepts an upper case host in the request and answers for the policy's lower case one", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A]] });
    const { status, socket } = await connectVia(h.proxy.socketPath, "PKG.Example.COM:443");
    socket.destroy();
    expect(status).toBe(200);
  });
});

describe("egress proxy: what is refused before any lookup", () => {
  const LITERALS = ["169.254.169.254:443", "127.0.0.1:443", "10.0.0.1:443", "93.184.216.34:443", "[::1]:443", "[fe80::1]:443", "2130706433:443", "0x7f000001:443", "127.1:443", "localhost:443"];
  it.each(LITERALS)("refuses the address literal %s and never resolves or connects", async (authority) => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A]] });
    await refusal(h, authority);
    expect(h.lookups).toEqual([]);
    expect(h.connects).toEqual([]);
    expect(h.decisions.every((d) => d.outcome !== "allow")).toBe(true);
  });
  it("names the class: a dotted or bracketed literal is address_literal or bad_authority, a numeric spelling bad_host", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, {});
    expect(await refusal(h, "169.254.169.254:443")).toBe("address_literal");
    expect(await refusal(h, "[::1]:443")).toBe("bad_authority");
    expect(await refusal(h, "2130706433:443")).toBe("bad_host");
  });
  it("refuses a host that is not in this sandbox's policy, and a deny-all policy", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "other.example.com": [[PUBLIC_A]] });
    expect(await refusal(h, "other.example.com:443")).toBe("not_allowed");
    const none = await start("deny-all", { "pkg.example.com": [[PUBLIC_A]] }, {}, "sb2");
    expect(await refusal(none, "pkg.example.com:443")).toBe("not_allowed");
    expect(h.lookups.concat(none.lookups)).toEqual([]);
  });
  it("refuses any port but 443, and a malformed authority", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A]] });
    expect(await refusal(h, "pkg.example.com:80")).toBe("port_refused");
    expect(await refusal(h, "pkg.example.com:22")).toBe("port_refused");
    expect(await refusal(h, "pkg.example.com")).toBe("bad_authority");
    expect(await refusal(h, "user@pkg.example.com:443")).toBe("bad_authority");
    expect(h.lookups).toEqual([]);
  });
  it("refuses a host whose rule rewrites the request (forwardURL, transform): a tunnel cannot carry the rewrite", async () => {
    const h = await start(
      { allow: { "pkg.example.com": [{ forwardURL: "https://proxy.example.com/api/gh-proxy" }], "other.example.com": [{ transform: [{ headers: { Authorization: "Bearer x" } }] }] } },
      { "pkg.example.com": [[PUBLIC_A]], "other.example.com": [[PUBLIC_A]] },
    );
    expect(await refusal(h, "pkg.example.com:443")).toBe("interception_required");
    expect(await refusal(h, "other.example.com:443")).toBe("interception_required");
    expect(h.lookups).toEqual([]);
    expect(h.connects).toEqual([]);
  });
  it("answers a plain request that is not CONNECT with 405", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, {});
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ socketPath: h.proxy.socketPath, path: "http://pkg.example.com/" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    expect(status).toBe(405);
    expect(h.connects).toEqual([]);
  });
});

describe("egress proxy: refusal after DNS resolution", () => {
  const BAD = ["10.1.2.3", "172.16.0.1", "192.168.0.7", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "198.51.100.9"];
  it.each(BAD)("refuses a name that resolves to %s", async (address) => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[address]] });
    expect(await refusal(h, "pkg.example.com:443")).toBe("blocked_address");
    expect(h.connects).toEqual([]);
  });
  it("refuses when any one answer of several is blocked, and a name that resolves to this host's own public address", async () => {
    const h = await start({ allow: ["pkg.example.com", "other.example.com"] }, { "pkg.example.com": [[PUBLIC_A, "10.0.0.1"]], "other.example.com": [[PUBLIC_B]] });
    expect(await refusal(h, "pkg.example.com:443")).toBe("blocked_address");
    expect(await refusal(h, "other.example.com:443")).toBe("blocked_address");
    expect(h.connects).toEqual([]);
  });
  it("refuses when the lookup fails, answers nothing, or answers something that is not an address", async () => {
    const h = await start({ allow: ["pkg.example.com", "other.example.com"] }, { "other.example.com": [[]] });
    expect(await refusal(h, "pkg.example.com:443")).toBe("dns_failed");
    expect(await refusal(h, "other.example.com:443")).toBe("dns_failed");
    const odd = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [["pkg.example.com"]] }, {}, "sb2");
    expect(await refusal(odd, "pkg.example.com:443")).toBe("blocked_address");
    expect(h.connects.concat(odd.connects)).toEqual([]);
  });
  it("answers a fixed word and never the address it found", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [["10.9.8.7"]] });
    const { socket } = await connectVia(h.proxy.socketPath, "pkg.example.com:443");
    const seen = JSON.stringify(h.decisions);
    socket.destroy();
    expect(seen).not.toContain("10.9.8.7");
  });
});

describe("egress proxy: DNS rebinding", () => {
  it("judges a name again on every CONNECT: public first, private on the second lookup", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A], ["10.0.0.5"]] });
    expect(await fetchThrough(h.proxy.socketPath, "pkg.example.com")).toContain("registry says hello");
    expect(await refusal(h, "pkg.example.com:443")).toBe("blocked_address");
    expect(h.lookups).toEqual(["pkg.example.com", "pkg.example.com"]);
    expect(h.connects).toEqual([{ address: PUBLIC_A, port: 443 }]);
  });
  it("resolves once per CONNECT and connects to that answer, never back to the name", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A], ["169.254.169.254"], ["127.0.0.1"]] });
    await fetchThrough(h.proxy.socketPath, "pkg.example.com");
    expect(h.lookups).toHaveLength(1);
    for (const c of h.connects) expect(net.isIP(c.address)).not.toBe(0);
    expect(h.connects.map((c) => c.address)).toEqual([PUBLIC_A]);
  });
});

describe("egress proxy: attribution is by socket", () => {
  it("applies each listener's own policy, whatever the guest asks for", async () => {
    const a = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A]], "other.example.com": [[PUBLIC_A]] }, {}, "sbA");
    const b = await start({ allow: ["other.example.com"] }, { "pkg.example.com": [[PUBLIC_A]], "other.example.com": [[PUBLIC_A]] }, {}, "sbB");
    expect(a.proxy.socketPath).not.toBe(b.proxy.socketPath);
    expect(await fetchThrough(a.proxy.socketPath, "pkg.example.com")).toContain("hello");
    expect(await refusal(b, "pkg.example.com:443")).toBe("not_allowed");
    expect(await fetchThrough(b.proxy.socketPath, "other.example.com")).toContain("hello");
    expect(await refusal(a, "other.example.com:443")).toBe("not_allowed");
  });
});

describe("egress proxy: fails closed at start", () => {
  it("refuses an unreadable policy before a socket exists", async () => {
    for (const policy of ["allow-all", { allow: ["*.example.com"] }, { allow: ["10.0.0.1"] }, { subnets: {} }, undefined]) {
      const dir = path.join(root, "bad");
      mkdirSync(dir, { mode: 0o1770, recursive: true });
      chmodSync(dir, 0o1770);
      await expect(startEgressProxy({ uid: UID, vsockDir: dir, sandboxId: "bad", policy })).rejects.toThrow(/egress policy refused/);
      expect(existsSync(path.join(dir, "v.sock_5253"))).toBe(false);
    }
  });
  it("refuses a vsock directory that is not the helper's contract", async () => {
    const policy = "deny-all";
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o1770 });
    chmodSync(real, 0o1770);
    const link = path.join(root, "link");
    symlinkSync(real, link);
    // Exactly 01770 is the contract: group-writable without the sticky bit, world-reachable, or the old 0710 layout is refused.
    for (const [name, mode] of [["m755", 0o755], ["m770", 0o770], ["m1771", 0o1771], ["m1777", 0o1777], ["m1700", 0o1700], ["m710", 0o710]] as const) {
      const bad = path.join(root, name);
      mkdirSync(bad);
      chmodSync(bad, mode);
      await expect(startEgressProxy({ uid: UID, vsockDir: bad, sandboxId: name, policy }), name).rejects.toThrow(/mode 1770/);
    }
    const other = path.join(root, "gid");
    mkdirSync(other, { mode: 0o1770 });
    chmodSync(other, 0o1770);
    await expect(startEgressProxy({ uid: UID, vsockDir: other, sandboxId: "gid", policy, sandboxGid: (process.getgid?.() ?? 0) + 12345 })).rejects.toThrow(/mode 1770/);
    const named = path.join(root, "named");
    mkdirSync(named, { mode: 0o1770 });
    chmodSync(named, 0o1770);
    await expect(startEgressProxy({ uid: UID, vsockDir: link, sandboxId: "link", policy })).rejects.toThrow(/real directory/);
    await expect(startEgressProxy({ uid: UID, vsockDir: named, sandboxId: "other", policy })).rejects.toThrow(/named for the sandbox/);
    await expect(startEgressProxy({ uid: UID, vsockDir: `${root}/named/../named`, sandboxId: "named", policy })).rejects.toThrow(/normalised/);
    await expect(startEgressProxy({ uid: UID, vsockDir: "named", sandboxId: "named", policy })).rejects.toThrow(/absolute/);
    await expect(startEgressProxy({ uid: UID, vsockDir: path.join(root, "missing"), sandboxId: "missing", policy })).rejects.toThrow();
  });
  it("refuses to replace something at the socket path that is not a socket, and replaces a stale socket", async () => {
    const dir = path.join(root, "sb3");
    mkdirSync(dir, { mode: 0o1770 });
    chmodSync(dir, 0o1770);
    writeFileSync(path.join(dir, "v.sock_5253"), "precious");
    await expect(startEgressProxy({ uid: UID, vsockDir: dir, sandboxId: "sb3", policy: "deny-all" })).rejects.toThrow(/other than a socket/);
    rmSync(path.join(dir, "v.sock_5253"));
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(path.join(dir, "v.sock_5253"), resolve));
    stale.unref();
    const p = await startEgressProxy({ uid: UID, vsockDir: dir, sandboxId: "sb3", policy: "deny-all" });
    proxies.push(p);
    stale.close();
    expect(p.socketPath).toBe(path.join(dir, "v.sock_5253"));
  });
  it("leaves a socket the runner does not own where it is and refuses to start", async () => {
    const dir = path.join(root, "sb4");
    mkdirSync(dir, { mode: 0o1770 });
    chmodSync(dir, 0o1777);
    // A socket made by another uid: a child in a user namespace with a subordinate uid, in a directory opened for it only while it binds.
    const script = `const s=require("node:net").createServer();s.listen(process.argv[1],()=>{console.log("BOUND");setTimeout(()=>process.exit(0),200)});s.on("error",(e)=>{console.log(e.code);process.exit(0)});`;
    const made = spawnSync("unshare", ["--map-users=auto", "--map-groups=auto", "--setuid=1", "--setgid=1", process.execPath, "-e", script, path.join(dir, "v.sock_5253")], { encoding: "utf8", timeout: 20_000 });
    chmodSync(dir, 0o1770);
    expect(made.stdout.trim(), made.stderr).toBe("BOUND");
    const before = lstatSync(path.join(dir, "v.sock_5253"));
    expect(before.uid).not.toBe(UID);
    await expect(startEgressProxy({ uid: UID, vsockDir: dir, sandboxId: "sb4", policy: "deny-all" })).rejects.toThrow(/of this user/);
    const after = lstatSync(path.join(dir, "v.sock_5253"));
    expect(after.ino).toBe(before.ino);
  });
  it("listens at mode 0666 inside the 01770 directory: the owner connects, another uid in a user namespace cannot enter", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A]] }, {}, "sb5");
    expect(lstatSync(h.proxy.socketPath).mode & 0o7777).toBe(0o666);
    expect(lstatSync(path.dirname(h.proxy.socketPath)).mode & 0o7777).toBe(0o1770);
    expect(await fetchThrough(h.proxy.socketPath, "pkg.example.com")).toContain("hello");
    // A child in a user namespace whose uid is a subordinate uid of this user: no owner, no group, so only the directory's other bits (none) apply.
    const script = `const s=require("node:net").connect(process.argv[1]);s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",(e)=>{console.log(e.code);process.exit(0)});`;
    const out = spawnSync("unshare", ["--map-users=auto", "--map-groups=auto", "--setuid=1", "--setgid=1", process.execPath, "-e", script, h.proxy.socketPath], { encoding: "utf8", timeout: 20_000 });
    if (out.status === 0 && out.stdout.trim() !== "") expect(out.stdout.trim()).toBe("EACCES");
    else expect.soft(out.error?.message ?? out.stderr, "no unprivileged user namespace on this host").toBe("unavailable");
  });
  it("close() ends open tunnels and stops listening", async () => {
    const h = await start({ allow: ["pkg.example.com"] }, { "pkg.example.com": [[PUBLIC_A]] });
    const { socket } = await connectVia(h.proxy.socketPath, "pkg.example.com:443");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await h.proxy.close();
    await closed;
    await expect(connectVia(h.proxy.socketPath, "pkg.example.com:443")).rejects.toThrow();
  });
});
