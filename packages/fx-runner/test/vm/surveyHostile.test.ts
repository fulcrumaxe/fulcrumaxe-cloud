import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { startEgressProxy, type Decision, type EgressProxy, type Lookup } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint, TEST_HOOKS, type ReverseDecision, type ReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { policyOf } from "../../src/vm/sandboxd/microvmSandbox.js";
import { MODEL_HOST } from "../../src/sandbox/sandboxSettings.js";
import { guestJobFiles } from "../../src/vm/sandboxd/guestJobFiles.js";
import { GUEST_JOBS_DIR } from "../../src/vm/sandboxd/guestRuntime.js";
import { RUN_ID } from "../engines/claude/harness.js";

/**
 * D#845 ON-10c: the hostile fake agent's network half on the microVM tier, over the REAL egress listeners (the CONNECT proxy and the reverse endpoint a guest reaches through its two relays), on real Unix sockets, with the
 * policy the engine puts in force for a survey job: `policyOf` of the one rule `runJob` gives it, the model host. What the agent tries: `github.com:443` through the proxy and as a request to the reverse relay (the guest's
 * hosts file maps `github.com` there), a sibling GitHub host, the address literals of the machine and the metadata service, a port other than 443, and the model host itself resolved to a private address. Each is refused with a
 * closed reason, nothing is looked up or connected for it, and the model host (control) is let through to the validated public address.
 *
 * The filesystem half of the guest (a read-only working copy and one writable directory, /tmp/fx-survey/<run_id>) is in the guest runtime test (the block it writes) and in `daemon/jobHandlerVm.test.ts` (a guest that committed is
 * refused `workspace_written` and its bundle is never applied). The same attempts inside a REAL microVM need the helper and the image, which wait for the real-VM suites (D#845 Ruling 88: like ON-8d); nothing here claims them.
 */
const UID = process.getuid!();
const PUBLIC = "93.184.216.34";
const POLICY = policyOf([{ host: MODEL_HOST, purpose: "model" }]);
let root: string;
let closers: Array<() => Promise<void>>;
beforeEach(() => {
  root = mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : os.tmpdir(), "fx-survey-vm-"));
  chmodSync(root, 0o711);
  closers = [];
});
afterEach(async () => {
  for (const close of closers) await close();
  rmSync(root, { recursive: true, force: true });
});

interface Rig {
  proxy: EgressProxy;
  reverse: ReverseEndpoint;
  lookups: string[];
  connects: string[];
  proxyDecisions: Decision[];
  reverseDecisions: ReverseDecision[];
}

async function start(answers: Record<string, string[]>, id = "sb1"): Promise<Rig> {
  const dir = path.join(root, id);
  mkdirSync(dir, { mode: 0o1770 });
  chmodSync(dir, 0o1770);
  const rig = { lookups: [], connects: [], proxyDecisions: [], reverseDecisions: [] } as unknown as Rig;
  // The "upstream" the proxy's connect is aimed at: a plain listener that accepts and closes, so an allowed tunnel opens (the control) and anything else never gets here.
  const upstream = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  closers.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const lookup: Lookup = async (host) => {
    rig.lookups.push(host);
    const list = answers[host];
    if (list === undefined) throw new Error("ENOTFOUND");
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  rig.proxy = await startEgressProxy({
    uid: UID, vsockDir: dir, sandboxId: id, policy: POLICY, lookup, ownAddresses: () => new Set(["198.51.100.9"]),
    connect: (address) => (rig.connects.push(address), net.connect({ host: "127.0.0.1", port: upstreamPort })),
    onDecision: (d) => rig.proxyDecisions.push(d),
  });
  rig.reverse = await startReverseEndpoint({
    uid: UID, vsockDir: dir, sandboxId: id, policy: POLICY, lookup, ownAddresses: () => new Set(["198.51.100.9"]),
    [TEST_HOOKS]: { target: (address) => (rig.connects.push(address), { address: "127.0.0.1", port: upstreamPort }), ca: "" },
    onDecision: (d) => rig.reverseDecisions.push(d),
  });
  closers.push(() => rig.proxy.close(), () => rig.reverse.close());
  return rig;
}

/** What the in-guest shim sends: CONNECT over the VM's Unix socket. */
function connectVia(socketPath: string, authority: string): Promise<{ status: number; message: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: "CONNECT", path: authority });
    req.once("connect", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, message: res.statusMessage ?? "" });
    });
    req.once("error", reject);
    req.end();
  });
}

/** A plain request to the reverse relay, as the guest's `github.com` or model-host name reaches it. */
function viaReverse(socketPath: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let data = "";
    socket.on("data", (c) => (data += String(c)));
    socket.once("error", reject);
    socket.once("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), body: data.split("\r\n\r\n").slice(1).join("") }));
    socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

describe("the hostile fake agent's network on the microVM tier (real egress listeners, the survey's own policy)", () => {
  it("the policy a survey job puts in force is the model host alone", () => {
    expect(POLICY).toEqual({ allow: ["api.anthropic.com"] });
  });

  it.each([
    ["github.com:443", "not_allowed"],
    ["api.github.com:443", "not_allowed"],
    ["codeload.github.com:443", "not_allowed"],
    ["raw.githubusercontent.com:443", "not_allowed"],
    ["registry.npmjs.org:443", "not_allowed"],
    ["api.anthropic.com:80", "port_refused"],
    ["api.anthropic.com:22", "port_refused"],
    ["169.254.169.254:443", "address_literal"],
    ["127.0.0.1:443", "address_literal"],
    ["10.0.0.1:443", "address_literal"],
    ["192.168.1.1:443", "address_literal"],
    ["[::1]:443", "bad_authority"],
    ["localhost:443", "bad_host"],
  ])("CONNECT %s is refused (%s) before anything is looked up or connected", async (authority, reason) => {
    const rig = await start({ "api.anthropic.com": [PUBLIC], "github.com": [PUBLIC], "api.github.com": [PUBLIC], "registry.npmjs.org": [PUBLIC] });
    const answered = await connectVia(rig.proxy.socketPath, authority);
    expect([400, 403, 502], authority).toContain(answered.status);
    expect(answered.message).toBe(reason);
    expect(rig.lookups).toEqual([]);
    expect(rig.connects).toEqual([]);
    expect(rig.proxyDecisions.every((d) => d.outcome !== "allow")).toBe(true);
  });

  it("the model host resolved to an address on this machine's own network is refused after the lookup (blocked_address), and never connected", async () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "192.168.0.7", "::1", "198.51.100.9"]) {
      const rig = await start({ "api.anthropic.com": [address] }, `sb-${address.replace(/[^0-9a-f]/g, "")}`);
      const answered = await connectVia(rig.proxy.socketPath, "api.anthropic.com:443");
      expect(answered.message, address).toBe("blocked_address");
      expect(rig.connects, address).toEqual([]);
    }
  });

  it("a request for github.com (or any host but the model's) at the reverse relay is refused not_allowed, with nothing looked up or connected", async () => {
    const rig = await start({ "github.com": [PUBLIC], "api.anthropic.com": [PUBLIC] });
    for (const host of ["github.com", "api.github.com", "127.0.0.1", "169.254.169.254", "evil.example.com"]) {
      const answered = await viaReverse(rig.reverse.socketPath, host);
      expect(answered.status, host).toBeGreaterThanOrEqual(400);
      expect(answered.body, host).toMatch(/egress refused: (not_allowed|bad_host|host_mismatch)/);
    }
    expect(rig.lookups).toEqual([]);
    expect(rig.connects).toEqual([]);
    expect(rig.reverseDecisions.every((d) => d.outcome !== "allow")).toBe(true);
  });

  it("control: the model host is let through, to the validated public address (so the refusals above are the policy)", async () => {
    const rig = await start({ "api.anthropic.com": [PUBLIC] });
    const answered = await connectVia(rig.proxy.socketPath, "api.anthropic.com:443");
    expect(answered.status).toBe(200);
    expect(rig.connects).toEqual([PUBLIC]);
    expect(rig.proxyDecisions).toEqual([{ outcome: "allow", host: "api.anthropic.com" }]);
  });

  it("the guest's files for a survey name this same host and no other, and the working copy as read-only", () => {
    const files = guestJobFiles({ jobsDir: GUEST_JOBS_DIR, runId: RUN_ID, role: SURVEY_ROLE, workdir: "/vercel/sandbox/work" });
    const settings = JSON.parse(files.files.find((f) => f.path.endsWith("settings.json"))!.content) as { sandbox: { network: { allowedDomains: string[] }; filesystem: { allowWrite: string[]; denyWrite: string[] } } };
    expect(settings.sandbox.network.allowedDomains).toEqual([MODEL_HOST]);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([`/tmp/fx-survey/${RUN_ID}`]);
    expect(settings.sandbox.filesystem.denyWrite).toContain("/vercel/sandbox/work");
  });
});
