import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_SESSION_NETWORK, engineSessionPolicy } from "../../src/engineSession/sessionPolicy.js";
import { PROJECT_SETUP_HOSTS } from "../../src/setup/setupPolicy.js";
import { parseEgressPolicy } from "../../src/vm/egress/policy.js";
import { startEgressProxy, type Decision, type EgressProxy, type Lookup } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint, TEST_HOOKS, type ReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { REVERSE_HOSTS } from "../../src/vm/sandboxd/guestEnv.js";

/** D#845 ON-13a1 item 4: the `engine_session` egress policy is the six hosts the engine's own code calls, and nothing else. */
const SIX = ["api.anthropic.com", "github.com", "api.github.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
const CLOUD_ORIGIN_HOST = "cloud.fulcrum-fixture.test";
const PUBLIC_A = "93.184.216.34";
const UID = process.getuid!();

describe("the engine_session network policy", () => {
  it("is exactly the six hosts, in order, with the setup's registries as the same constant", () => {
    expect(ENGINE_SESSION_NETWORK.map((r) => r.host)).toEqual(SIX);
    expect(ENGINE_SESSION_NETWORK.map((r) => r.purpose)).toEqual(["model", "github_git", "github_api", "package_registry", "package_registry", "package_registry"]);
    expect(ENGINE_SESSION_NETWORK.slice(3).map((r) => r.host)).toEqual([...PROJECT_SETUP_HOSTS]);
    expect(Object.isFrozen(ENGINE_SESSION_NETWORK)).toBe(true);
    for (const rule of ENGINE_SESSION_NETWORK) expect(Object.isFrozen(rule)).toBe(true);
  });

  it("is `{allow: [six hosts]}`, and the proxy's own parser reads every host as direct with no route", () => {
    expect(engineSessionPolicy()).toEqual({ allow: SIX });
    const parsed = parseEgressPolicy(engineSessionPolicy());
    expect([...parsed.hosts]).toEqual(SIX.map((host) => [host, "direct"]));
    expect(parsed.routes.size).toBe(0);
  });

  it("holds every host the reverse relay serves", () => {
    for (const host of REVERSE_HOSTS) expect(SIX).toContain(host);
  });

  it("injects no header, is no `github_proxy`, and does not name the cloud's origin", () => {
    for (const rule of ENGINE_SESSION_NETWORK) {
      expect(rule).not.toHaveProperty("authHeader");
      expect(rule).not.toHaveProperty("authValue");
      expect(rule.purpose).not.toBe("github_proxy");
    }
    expect(JSON.stringify(engineSessionPolicy())).not.toContain(CLOUD_ORIGIN_HOST);
    expect(SIX).not.toContain(CLOUD_ORIGIN_HOST);
  });
});

describe("the policy on the real egress proxy and reverse relay", () => {
  let root: string;
  let proxies: EgressProxy[];
  let endpoints: ReverseEndpoint[];
  let target: net.Server;
  let targetPort: number;
  beforeEach(async () => {
    root = mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : os.tmpdir(), "fx-session-policy-"));
    chmodSync(root, 0o711);
    proxies = [];
    endpoints = [];
    target = net.createServer((s) => s.end());
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    targetPort = (target.address() as net.AddressInfo).port;
  });
  afterEach(async () => {
    for (const p of proxies) await p.close();
    for (const e of endpoints) await e.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const lookup: Lookup = async () => [{ address: PUBLIC_A, family: 4 }];
  async function proxy(id: string): Promise<{ proxy: EgressProxy; decisions: Decision[]; connects: string[] }> {
    const dir = path.join(root, id);
    mkdirSync(dir, { mode: 0o1770 });
    chmodSync(dir, 0o1770);
    const seen = { decisions: [] as Decision[], connects: [] as string[] };
    const started = await startEgressProxy({
      uid: UID, vsockDir: dir, sandboxId: id, policy: engineSessionPolicy(), lookup, ownAddresses: () => new Set(["198.51.100.9"]),
      connect: (address) => (seen.connects.push(address), net.connect({ host: "127.0.0.1", port: targetPort })),
      onDecision: (d) => seen.decisions.push(d),
    });
    proxies.push(started);
    return { proxy: started, ...seen };
  }
  const connectVia = (socketPath: string, authority: string): Promise<{ status: number; message: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method: "CONNECT", path: authority });
      req.once("connect", (res, socket) => (socket.destroy(), resolve({ status: res.statusCode ?? 0, message: res.statusMessage ?? "" })));
      req.once("error", reject);
      req.end();
    });

  it("lets CONNECT through to api.github.com:443 and registry.npmjs.org:443, and to the other four", async () => {
    for (const host of SIX) {
      const h = await proxy(`ok-${host.replaceAll(".", "-").slice(0, 12)}`);
      const r = await connectVia(h.proxy.socketPath, `${host}:443`);
      expect({ host, status: r.status }).toEqual({ host, status: 200 });
    }
  });

  it("refuses github.com:22 as port_refused, and every host outside the six as not_allowed, resolving and connecting to none", async () => {
    const h = await proxy("refusals");
    expect((await connectVia(h.proxy.socketPath, "github.com:22")).message).toBe("port_refused");
    for (const host of ["uploads.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "codeload.github.com", "statsig.anthropic.com", "claude.ai", CLOUD_ORIGIN_HOST]) {
      const r = await connectVia(h.proxy.socketPath, `${host}:443`);
      expect({ host, message: r.message, status: r.status }).toEqual({ host, message: "not_allowed", status: 403 });
    }
    expect(h.connects).toEqual([]);
    expect(h.decisions.every((d) => d.outcome !== "allow")).toBe(true);
  });

  it("the reverse relay refuses a Host outside the policy", async () => {
    const dir = path.join(root, "reverse");
    mkdirSync(dir, { mode: 0o1770 });
    chmodSync(dir, 0o1770);
    const decisions: unknown[] = [];
    const endpoint = await startReverseEndpoint({ uid: UID, vsockDir: dir, sandboxId: "reverse", policy: engineSessionPolicy(), lookup, ownAddresses: () => new Set(["198.51.100.9"]), [TEST_HOOKS]: { target: () => ({ address: "127.0.0.1", port: targetPort }) }, onDecision: (d) => decisions.push(d) });
    endpoints.push(endpoint);
    for (const host of ["uploads.github.com", "claude.ai", CLOUD_ORIGIN_HOST]) {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(endpoint.socketPath);
        let data = "";
        socket.on("data", (c) => (data += String(c)));
        socket.once("error", reject);
        socket.once("close", () => resolve(data));
        socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      expect({ host, status: /^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1], reason: /egress refused: (\w+)/.exec(reply)?.[1] }).toEqual({ host, status: "403", reason: "not_allowed" });
    }
  });
});
