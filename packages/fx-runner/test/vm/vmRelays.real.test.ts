import { randomBytes } from "node:crypto";
import https from "node:https";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBootFactsSource } from "../../src/vm/bootFacts.js";
import { startEgressProxy, type Decision } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint, TEST_HOOKS, type ReverseDecision } from "../../src/vm/egress/reverse.js";
import { TEMPLATES } from "../../src/vm/lock.js";
import { createHelperClient } from "../../src/vm/sandboxd/helperClient.js";
import { createEgressPolicyPort, type EgressStarters } from "../../src/vm/sandboxd/policyPort.js";
import { createProductionSandboxd } from "../../src/vm/sandboxd/production.js";
import { createDaemonSdk } from "../../src/vm/sandboxd/sdkAdapter.js";
import type { SdkSandbox } from "../../src/vm/sandboxd/sdkSlice.js";
import { generateSelfSignedCert } from "../helpers/selfSignedCert.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { connectUnix } from "./sandboxd/helpers.js";

/**
 * D#587 B-5b-3c-v (A1 criterion 26a, the relay checks) against a REAL Firecracker: both egress listeners answer a request that a program INSIDE the guest makes, and a domain that is not in the
 * policy fails on both. It builds what the runner builds under `run` (the production daemon, the real helper client, the real egress policy port with the real proxy and reverse endpoint, the
 * SDK adapter), makes one VM, and runs a program in it. Stand-ins, each the least it can be:
 *   - the guest's two relays (127.0.0.1:5253 to the host's vsock port 5253, and 127.0.0.1:8080 to 5254): the shipped guest image does not carry them yet (the image rows own that; the egress doc says so),
 *     so the program starts two small relays of its own, speaking only what Firecracker's vsock gives a guest process;
 *   - the upstream the host side reaches: a local TLS server and a local echo socket, given to the proxy and the reverse endpoint through their own test hooks (an answer for the lookup, where to
 *     connect, and the certificate to trust). Nothing here leaves the machine.
 * The host side's own decisions are read from the listeners (`onDecision`), so a refusal is the listener's, not the guest's guess.
 *
 * Needs the environment a dispatched `microvm-image.yml` run sets (see vmJob.real.test.ts); skips with a message without it.
 */
const env = { helper: process.env["FX_VM_HELPER_SOCKET"], template: process.env["FX_VM_TEMPLATE"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"], agent: process.env["FX_VM_AGENT"] };
const ready = env.helper !== undefined && env.template === TEMPLATES[0] && env.kernel !== undefined && env.rootfs !== undefined && env.agent !== undefined && process.geteuid !== undefined && process.geteuid() !== 0;
if (!ready) console.warn("vmRelays.real: FX_VM_HELPER_SOCKET, FX_VM_TEMPLATE, FX_VM_KERNEL, FX_VM_ROOTFS and FX_VM_AGENT are not all set (or this is root); the real-VM relay suite is skipped");

const DIRECT = "direct.relay.test";
const REWRITTEN = "rewritten.relay.test";
const OUTSIDE = "outside.relay.test";
const PUBLIC = "93.184.216.34";
const HEADER = "x-fx-relay";
/** What the job's own policy is, as `policyOf` makes it for the model rule: a plain list. */
const MODEL_HOST = "api.anthropic.com";

/** The program that runs in the guest: two relays, then one request per case, and one JSON line of what each answered. */
const PROBE = `import json, socket, threading
HOST = 2
def pump(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data: break
            b.sendall(data)
    except OSError: pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
def relay(listen_port, vsock_port):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", listen_port)); srv.listen(16)
    def serve():
        while True:
            c, _ = srv.accept()
            def go(c=c):
                v = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
                try: v.connect((HOST, vsock_port))
                except OSError:
                    c.close(); return
                threading.Thread(target=pump, args=(c, v), daemon=True).start()
                pump(v, c)
            threading.Thread(target=go, daemon=True).start()
    threading.Thread(target=serve, daemon=True).start()
relay(5253, 5253); relay(8080, 5254)
def connect(host):
    s = socket.create_connection(("127.0.0.1", 5253), timeout=30)
    s.sendall(("CONNECT %s:443 HTTP/1.1\\r\\nHost: %s:443\\r\\n\\r\\n" % (host, host)).encode())
    buf = b""
    while b"\\r\\n\\r\\n" not in buf:
        d = s.recv(4096)
        if not d: break
        buf += d
    status = buf.split(b"\\r\\n")[0].decode()
    echo = ""
    if status.startswith("HTTP/1.1 200"):
        s.sendall(b"ping\\n"); echo = s.recv(4096).decode()
    s.close()
    return {"status": status, "echo": echo}
def get(host):
    s = socket.create_connection(("127.0.0.1", 8080), timeout=60)
    s.sendall(("GET /probe HTTP/1.0\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n" % host).encode())
    data = b""
    while True:
        d = s.recv(65536)
        if not d: break
        data += d
    s.close()
    head, _, body = data.partition(b"\\r\\n\\r\\n")
    return {"status": head.split(b"\\r\\n")[0].decode(), "body": body.decode()}
print(json.dumps({"direct": connect("${DIRECT}"), "outside": connect("${OUTSIDE}"), "rewrittenTunnel": connect("${REWRITTEN}"), "rewritten": get("${REWRITTEN}"), "outsideReverse": get("${OUTSIDE}"), "model": get("${MODEL_HOST}")}))
`;

describe.skipIf(!ready)("both egress relays, from a program in a real guest (criterion 26a)", () => {
  let signed: SignedRelease;
  let daemon: ReturnType<typeof createProductionSandboxd>;
  let upstream: https.Server;
  let echo: net.Server;
  let sandbox: SdkSandbox | undefined;
  let sdk: ReturnType<typeof createDaemonSdk>;
  let tunnels: Decision[];
  let reverse: ReverseDecision[];
  let seenHeaders: Array<string | string[] | undefined>;
  const sockets = new Set<net.Socket>();

  beforeAll(async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: TEMPLATES[0], files: [{ kind: "kernel", arch, file: env.kernel as string }, { kind: "rootfs", arch, file: env.rootfs as string }, { kind: "agent", arch, file: env.agent as string }] });
    const d = signed.digests(arch);
    const boot = createBootFactsSource({ tuf: signed.client, template: TEMPLATES[0], nodeArch: process.arch, readManifest: () => JSON.stringify({ [TEMPLATES[0]]: { kernel: d.kernel, rootfs: d.rootfs } }), now: Date.now });
    daemon = createProductionSandboxd({ helperSocket: env.helper as string, host: { euid: process.geteuid?.(), platform: process.platform }, boot });
    const cert = generateSelfSignedCert(REWRITTEN, 1, { dnsNames: [REWRITTEN] });
    seenHeaders = [];
    upstream = https.createServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
      seenHeaders.push(req.headers[HEADER]);
      res.end(JSON.stringify({ [HEADER]: req.headers[HEADER] ?? null, host: req.headers.host ?? null, url: req.url ?? null }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    echo = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as net.AddressInfo).port;
    tunnels = [];
    reverse = [];
    const lookup = async (): Promise<Array<{ address: string; family: number }>> => [{ address: PUBLIC, family: 4 }];
    const egress: EgressStarters = {
      startProxy: (o) => startEgressProxy({ ...o, lookup, connect: () => net.connect({ host: "127.0.0.1", port: echoPort }), onDecision: (decision) => void tunnels.push(decision) }),
      startReverse: (o) => startReverseEndpoint({ ...o, lookup, onDecision: (decision) => void reverse.push(decision), [TEST_HOOKS]: { target: () => ({ address: "127.0.0.1", port: upstreamPort }), ca: cert.certPem } }),
    };
    const helper = createHelperClient(connectUnix(env.helper as string));
    const policy = createEgressPolicyPort({ helper, uid: process.geteuid?.() ?? -1, egress });
    sdk = createDaemonSdk({ daemon, policy, template: TEMPLATES[0], memMb: 512 });
  }, 120_000);
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => echo?.close(() => resolve()));
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    await signed?.close();
  });
  afterEach(async () => {
    await sandbox?.delete().catch(() => undefined); // fx-swallow-ok: a sandbox the daemon no longer holds is the wanted state
    sandbox = undefined;
  });

  it("a request through each relay is answered by its listener, and a domain outside the policy fails on both", async () => {
    const name = `relay-${randomBytes(6).toString("hex")}`;
    // the policy: one host the tunnel may open (a plain list entry), one the reverse endpoint serves with a header transform, and the model host as the job's own policy has it (no rules)
    const policy = { allow: { [DIRECT]: [], [REWRITTEN]: [{ transform: [{ headers: { [HEADER]: "added-by-the-host" } }] }], [MODEL_HOST]: [] } };
    sandbox = await sdk.create({ teamId: "local", projectId: "local", token: "local", name, image: "microvm", timeout: 10 * 60_000, persistent: false, resources: { vcpus: 1 }, tags: {}, networkPolicy: policy });
    await sandbox.writeFiles([{ path: "/tmp/relay-probe.py", content: PROBE, mode: 0o755 }]);
    const command = await sandbox.runCommand({ cmd: "/usr/bin/python3", args: ["/tmp/relay-probe.py"], detached: true });
    let out = "";
    let errText = "";
    for await (const log of command.logs()) {
      const text = typeof log.data === "string" ? log.data : Buffer.from(log.data as Uint8Array).toString("utf8");
      if (log.stream === "stderr") errText += text;
      else out += text;
    }
    const finished = await command.wait();
    expect(finished.exitCode, `the probe program failed: ${errText}`).toBe(0);
    const answered = JSON.parse(out.trim().split("\n").pop() as string) as Record<string, { status: string; echo?: string; body?: string }>;
    // the CONNECT relay: the allowed host is tunnelled to the upstream and answers what it was sent; a host outside the policy is refused, and a rewritten host is sent to the reverse endpoint
    expect(answered["direct"]!.status).toBe("HTTP/1.1 200 Connection Established");
    expect(answered["direct"]!.echo).toBe("echo:ping\n");
    expect(answered["outside"]!.status).toContain("403");
    expect(answered["rewrittenTunnel"]!.status).toContain("403");
    // the reverse relay: the rewritten host is served, over real TLS made by the host with the header added there; a host outside the policy is refused
    expect(answered["rewritten"]!.status).toMatch(/^HTTP\/1\.[01] 200 OK$/);
    expect(JSON.parse(answered["rewritten"]!.body as string)).toMatchObject({ [HEADER]: "added-by-the-host", host: REWRITTEN, url: "/probe" });
    expect(answered["outsideReverse"]!.status).toContain("403");
    // the listeners' own decisions, which the guest cannot forge: the same story from the host side
    expect(tunnels).toEqual([{ outcome: "allow", host: DIRECT }, { outcome: "not_allowed", host: OUTSIDE }, { outcome: "interception_required", host: REWRITTEN }]);
    expect(reverse.filter((d) => d.host !== MODEL_HOST)).toEqual([{ outcome: "allow", host: REWRITTEN }, { outcome: "not_allowed", host: OUTSIDE }]);
    expect(seenHeaders).toEqual(["added-by-the-host"]);
    // what the reverse relay answered for the model host under a plain-list entry (the shape the job's own policy gives it): recorded, not judged here
    console.warn(`vmRelays.real: the model host through the reverse relay, under a policy entry with no rules, was answered "${answered["model"]!.status}" (the host's decision: ${JSON.stringify(reverse.filter((d) => d.host === MODEL_HOST))})`);
  }, 420_000);
});
