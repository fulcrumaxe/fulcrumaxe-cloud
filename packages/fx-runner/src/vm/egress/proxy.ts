import dns from "node:dns";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { assertPlainHost } from "../../sandbox/sandboxSettings.js";
import { hostAddresses, isBlockedDestination } from "./address.js";
import { parseEgressPolicy, type EgressPolicy } from "./policy.js";

/**
 * D#587 B-4a: the host-side egress proxy for one microVM. The guest has no network card; its only way out is the VM's vsock. Firecracker turns
 * a guest connection to host port P into a connection to the Unix socket `<uds>_P` in that VM's own vsock directory, and this proxy listens
 * there, so every request is attributed to a sandbox by WHICH SOCKET it arrived on and the policy bound to that listener, never by anything the
 * guest sends. The guest speaks plain `CONNECT host:443` (what pnpm, git and curl send to an HTTPS proxy); the proxy does the DNS.
 *
 * Every CONNECT is checked in this order, and the first failure answers a fixed reason and closes (the reply names the class, never an address):
 * authority well formed, port 443, a plain DNS name (an address literal in any spelling is refused), a host in this sandbox's policy and not one
 * that needs rewriting, one lookup through the proxy, every resolved address public and none this host's own, then the connect goes to a
 * VALIDATED ADDRESS, never back to the name. Nothing is cached, so a name that changes its answer is judged again on the next CONNECT, and the
 * connect cannot re-resolve, so there is no window between the check and the use (DNS rebinding).
 */
export const EGRESS_VSOCK_PORT = 5253;
const CONNECT_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 256;

export type Refusal = "bad_authority" | "port_refused" | "address_literal" | "bad_host" | "not_allowed" | "interception_required" | "dns_failed" | "blocked_address" | "connect_failed";
export interface Decision {
  outcome: "allow" | Refusal;
  /** The requested host when it is a plain DNS name; "-" otherwise (the guest's text is not echoed). */
  host: string;
}
export type Lookup = (host: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

export interface EgressProxyOptions {
  /** The vsock directory the helper reported for this sandbox (`<jail_root>/vsock/<id>`), and the sandbox's id. */
  vsockDir: string;
  sandboxId: string;
  /** The sandbox's gid, when the caller knows it: the directory's group must be exactly it. */
  sandboxGid?: number;
  /** The runner's own uid, given by the caller (as elsewhere in this package): the vsock directory and any existing listener must belong to it. */
  uid: number;
  /** The sandbox's `networkPolicy`; anything the proxy cannot read throws before a socket exists. */
  policy: unknown;
  /** Defaults to `dns.promises.lookup`. */
  lookup?: Lookup;
  /** Opens the upstream leg to an already validated address. Defaults to `net.connect`. */
  connect?: (address: string, port: number) => net.Socket;
  /** This host's own addresses; defaults to its interfaces. */
  ownAddresses?: () => Set<string>;
  onDecision?: (decision: Decision) => void;
}

export interface EgressProxy {
  socketPath: string;
  close(): Promise<void>;
}

export function egressSocketPath(vsockDir: string): string {
  return path.join(vsockDir, `v.sock_${EGRESS_VSOCK_PORT}`);
}

/** The vsock directory must be what the helper's contract says: absolute, normalised, named for the sandbox, a real directory (no symlink) of the runner's uid, mode exactly 01770 (owner and sandbox group, sticky, nobody else), D#587 Correction 8. The sticky bit keeps the sandbox uid from deleting or renaming the runner's listener sockets in it. */
function assertVsockDir(dir: string, id: string, uid: number, sandboxGid?: number): void {
  if (typeof dir !== "string" || dir.includes("\0") || !path.isAbsolute(dir) || dir !== path.normalize(dir) || dir.split(path.sep).includes("..") || path.basename(dir) !== id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new TypeError("egress proxy: the vsock directory is not a normalised absolute path named for the sandbox");
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o1770 || (sandboxGid !== undefined && stat.gid !== sandboxGid)) {
    throw new TypeError("egress proxy: the vsock directory is not a real directory of this user, mode 1770, in the sandbox's group");
  }
}

function parseAuthority(url: string | undefined): { host: string; port: number } | undefined {
  const m = (url ?? "").match(/^([^:/@\s[\]]{1,253}):(\d{1,5})$/);
  return m ? { host: m[1]!.toLowerCase(), port: Number(m[2]) } : undefined;
}

function plainHost(host: string): boolean {
  try {
    assertPlainHost(host);
    return true;
  } catch {
    // fx-swallow-ok: a name that is not a plain DNS name is answered with a fixed refusal
    return false;
  }
}


const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

export async function startEgressProxy(o: EgressProxyOptions): Promise<EgressProxy> {
  const policy: EgressPolicy = parseEgressPolicy(o.policy);
  assertVsockDir(o.vsockDir, o.sandboxId, o.uid, o.sandboxGid);
  const lookup: Lookup = o.lookup ?? ((host, options) => dns.promises.lookup(host, options));
  const open = o.connect ?? ((address, port) => net.connect({ host: address, port }));
  const own = o.ownAddresses ?? hostAddresses;
  const socketPath = egressSocketPath(o.vsockDir);
  const tunnels = new Set<net.Socket>();

  const decide = async (authority: { host: string; port: number } | undefined): Promise<{ refusal: Refusal } | { addresses: string[] }> => {
    if (!authority) return { refusal: "bad_authority" };
    if (authority.port !== 443) return { refusal: "port_refused" };
    if (net.isIP(authority.host) !== 0) return { refusal: "address_literal" };
    if (!plainHost(authority.host)) return { refusal: "bad_host" };
    const mode = policy.hosts.get(authority.host);
    if (mode === undefined) return { refusal: "not_allowed" };
    if (mode !== "direct") return { refusal: "interception_required" };
    let found: Array<{ address: string; family: number }>;
    try {
      found = await withTimeout(lookup(authority.host, { all: true, verbatim: true }), LOOKUP_TIMEOUT_MS);
    } catch {
      // fx-swallow-ok: a failed lookup is answered with a fixed refusal; the resolver's text is not passed on
      return { refusal: "dns_failed" };
    }
    if (!Array.isArray(found) || found.length === 0) return { refusal: "dns_failed" };
    const mine = own();
    const addresses = found.map((f) => String(f.address).toLowerCase());
    if (addresses.some((a) => isBlockedDestination(a) || mine.has(a))) return { refusal: "blocked_address" };
    return { addresses };
  };

  const reach = async (addresses: string[]): Promise<net.Socket | undefined> => {
    for (const address of addresses) {
      const upstream = open(address, 443);
      try {
        await withTimeout(new Promise<void>((resolve, reject) => void upstream.once("connect", resolve).once("error", reject)), CONNECT_TIMEOUT_MS);
        return upstream;
      } catch {
        // fx-swallow-ok: try the next validated address; all failing is a fixed refusal
        upstream.destroy();
      }
    }
    return undefined;
  };

  const server = http.createServer({ maxHeaderSize: 8 * 1024 }, (_req, res) => {
    res.writeHead(405, { connection: "close" });
    res.end();
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connect", (req, client: net.Socket, head: Buffer) => {
    tunnels.add(client);
    client.once("close", () => tunnels.delete(client));
    client.on("error", () => client.destroy());
    const authority = parseAuthority(req.url);
    const logged = authority && plainHost(authority.host) ? authority.host : "-";
    const refuse = (reason: Refusal): void => {
      o.onDecision?.({ outcome: reason, host: logged });
      client.end(`HTTP/1.1 ${reason === "dns_failed" || reason === "connect_failed" ? 502 : 403} ${reason}\r\nconnection: close\r\n\r\n`);
    };
    void (async () => {
      const verdict = await decide(authority);
      if ("refusal" in verdict) return refuse(verdict.refusal);
      const upstream = await reach(verdict.addresses);
      if (!upstream) return refuse("connect_failed");
      if (client.destroyed) return void upstream.destroy();
      tunnels.add(upstream);
      upstream.once("close", () => tunnels.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      o.onDecision?.({ outcome: "allow", host: logged });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    })().catch(() => client.destroy());
  });

  // Only a stale socket the runner itself owns is replaced (an lstat, which never follows a link). Anything else at the listener name, whoever owns it, refuses the start and is left alone.
  try {
    const existing = lstatSync(socketPath);
    if (!existing.isSocket() || existing.uid !== o.uid) throw new TypeError("egress proxy: something other than a socket of this user is at the socket path");
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  // 0666: Firecracker runs as the sandbox uid and must connect. Who may reach the socket is decided by the 01770 directory, which no other uid can enter.
  chmodSync(socketPath, 0o666);
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of tunnels) socket.destroy();
        server.closeAllConnections();
      }),
  };
}
