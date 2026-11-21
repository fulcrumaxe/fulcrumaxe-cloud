import { randomBytes } from "node:crypto";
import https from "node:https";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBootFactsSource } from "../../src/vm/bootFacts.js";
import { startEgressProxy, type Decision } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint, TEST_HOOKS, type ReverseDecision } from "../../src/vm/egress/reverse.js";
import { TEMPLATES } from "../../src/vm/lock.js";
import { guestEnvOf } from "../../src/vm/sandboxd/guestEnv.js";
import { createHelperClient } from "../../src/vm/sandboxd/helperClient.js";
import { createEgressPolicyPort, type EgressStarters } from "../../src/vm/sandboxd/policyPort.js";
import { createProductionSandboxd } from "../../src/vm/sandboxd/production.js";
import { createDaemonSdk } from "../../src/vm/sandboxd/sdkAdapter.js";
import type { SdkSandbox } from "../../src/vm/sandboxd/sdkSlice.js";
import { generateSelfSignedCert } from "../helpers/selfSignedCert.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { connectUnix } from "./sandboxd/helpers.js";

/**
 * D#587 B-5b-RELAY (A1 criterion 26a, the relay checks) against a REAL Firecracker: both egress listeners answer a request that a program INSIDE the guest makes through the IMAGE's own relays
 * (`relay.py`, started by the guest's init at 127.0.0.1:5253 and 127.0.0.1:80), and a domain that is not in the policy fails on both. It builds what the runner builds under `run` (the
 * production daemon, the real helper client, the real egress policy port with the real proxy and reverse endpoint, the SDK adapter), makes one VM, and runs a program in it, with the environment
 * the runner gives a job (`guestEnvOf`: the proxy variables, the model base URL and git's rewrite). The only stand-in is the upstream the host side reaches: a local TLS server and a local
 * echo socket, given to the proxy and the reverse endpoint through their own test hooks (an answer for the lookup, where to connect, and the certificate to trust). Nothing leaves the machine.
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
/** The model host and the git host: the two names the guest maps to its loopback. */
const MODEL_HOST = "api.anthropic.com";
const GIT_HOST = "github.com";
const SHA = "1".repeat(40);

/** The program that runs in the guest: one request per case through the image's own relays, and one JSON line of what each answered. */
const PROBE = `import json, socket, subprocess
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
    s = socket.create_connection(("127.0.0.1", 80), timeout=60)
    s.sendall(("GET /probe HTTP/1.0\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n" % host).encode())
    data = b""
    while True:
        d = s.recv(65536)
        if not d: break
        data += d
    s.close()
    head, _, body = data.partition(b"\\r\\n\\r\\n")
    return {"status": head.split(b"\\r\\n")[0].decode(), "body": body.decode()}
def git(url):
    out = subprocess.run(["git", "ls-remote", url], capture_output=True, text=True, timeout=60)
    return {"status": "exit %d" % out.returncode, "body": out.stdout.strip()}
print(json.dumps({"direct": connect("${DIRECT}"), "outside": connect("${OUTSIDE}"), "rewrittenTunnel": connect("${REWRITTEN}"), "rewritten": get("${REWRITTEN}"), "outsideReverse": get("${OUTSIDE}"), "model": get("${MODEL_HOST}"), "git": git("https://${GIT_HOST}/fx-test/repo.git"), "gitOutside": git("https://${OUTSIDE}/fx-test/repo.git")}))
`;

type Answer = { status: string; echo?: string; body?: string };

describe.skipIf(!ready)("both egress relays of the image, from a program in a real guest (criterion 26a)", () => {
  let signed: SignedRelease;
  let daemon: ReturnType<typeof createProductionSandboxd>;
  let upstream: https.Server;
  let echo: net.Server;
  let sandbox: SdkSandbox | undefined;
  let sdk: ReturnType<typeof createDaemonSdk>;
  let tunnels: Decision[];
  let reverse: ReverseDecision[];
  let upstreamSaw: Array<{ host: string | undefined; url: string | undefined; header: string | string[] | undefined; credential: string | string[] | undefined }>;
  const sockets = new Set<net.Socket>();

  const pkt = (text: string): string => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
  beforeAll(async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: TEMPLATES[0], files: [{ kind: "kernel", arch, file: env.kernel as string }, { kind: "rootfs", arch, file: env.rootfs as string }, { kind: "agent", arch, file: env.agent as string }] });
    const d = signed.digests(arch);
    const boot = createBootFactsSource({ tuf: signed.client, template: TEMPLATES[0], nodeArch: process.arch, readManifest: () => JSON.stringify({ [TEMPLATES[0]]: { kernel: d.kernel, rootfs: d.rootfs } }), now: Date.now });
    daemon = createProductionSandboxd({ helperSocket: env.helper as string, host: { euid: process.geteuid?.(), platform: process.platform }, boot });
    // one certificate for every name the host side connects to; the endpoint checks it against the NAME it was asked for
    const cert = generateSelfSignedCert(REWRITTEN, 1, { dnsNames: [REWRITTEN, MODEL_HOST, GIT_HOST] });
    upstream = https.createServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
      upstreamSaw.push({ host: req.headers.host, url: req.url, header: req.headers[HEADER], credential: req.headers["authorization"] ?? req.headers["x-api-key"] });
      req.resume();
      if (req.headers.host === GIT_HOST) {
        // a git smart-HTTP advertisement for a repository with one branch
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
        res.end(`${pkt("# service=git-upload-pack\n")}0000${pkt(`${SHA} HEAD\0multi_ack agent=fx\n`)}${pkt(`${SHA} refs/heads/main\n`)}0000`);
        return;
      }
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
    upstreamSaw = [];
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
    tunnels.length = 0;
    reverse.length = 0;
    upstreamSaw.length = 0;
  });

  /** Makes a VM under `networkPolicy`, runs the probe in it as the job's tools would be run (the runner's guest environment) and answers what each case got. */
  async function probe(networkPolicy: unknown): Promise<Record<string, Answer>> {
    const name = `relay-${randomBytes(6).toString("hex")}`;
    sandbox = await sdk.create({ teamId: "local", projectId: "local", token: "local", name, image: "microvm", timeout: 10 * 60_000, persistent: false, resources: { vcpus: 1 }, tags: {}, networkPolicy });
    await sandbox.writeFiles([{ path: "/tmp/relay-probe.py", content: PROBE, mode: 0o755 }]);
    const command = await sandbox.runCommand({ cmd: "/usr/bin/python3", args: ["/tmp/relay-probe.py"], env: guestEnvOf({}), detached: true });
    let out = "";
    let errText = "";
    for await (const log of command.logs()) {
      const text = typeof log.data === "string" ? log.data : Buffer.from(log.data as Uint8Array).toString("utf8");
      if (log.stream === "stderr") errText += text;
      else out += text;
    }
    const finished = await command.wait();
    expect(finished.exitCode, `the probe program failed: ${errText}`).toBe(0);
    return JSON.parse(out.trim().split("\n").pop() as string) as Record<string, Answer>;
  }

  it("a request through each relay is answered by its listener, git reaches its host through the reverse relay, and a domain outside the policy fails on both", async () => {
    // the policy: one host the tunnel may open (no rules), one the reverse endpoint serves with a header transform, and the model and git hosts with no rules
    const answered = await probe({ allow: { [DIRECT]: [], [REWRITTEN]: [{ transform: [{ headers: { [HEADER]: "added-by-the-host" } }] }], [MODEL_HOST]: [], [GIT_HOST]: [] } });
    // the CONNECT relay (127.0.0.1:5253, from the image): the allowed host is tunnelled to the upstream and answers what it was sent; a host outside the policy is refused, and a rewritten host is sent to the reverse endpoint
    expect(answered["direct"]!.status).toBe("HTTP/1.1 200 Connection Established");
    expect(answered["direct"]!.echo).toBe("echo:ping\n");
    expect(answered["outside"]!.status).toContain("403");
    expect(answered["rewrittenTunnel"]!.status).toContain("403");
    // the reverse relay (127.0.0.1:80, from the image): the rewritten host is served, over real TLS made by the host with the header added there; a host outside the policy is refused
    expect(answered["rewritten"]!.status).toMatch(/^HTTP\/1\.[01] 200 OK$/);
    expect(JSON.parse(answered["rewritten"]!.body as string)).toMatchObject({ [HEADER]: "added-by-the-host", host: REWRITTEN, url: "/probe" });
    expect(answered["outsideReverse"]!.status).toContain("403");
    // the model host, with no rules (the shape the job's policy gives it): served as itself
    expect(answered["model"]!.status).toMatch(/^HTTP\/1\.[01] 200 OK$/);
    expect(JSON.parse(answered["model"]!.body as string)).toMatchObject({ host: MODEL_HOST, url: "/probe" });
    // git, with the runner's rewrite (https://github.com/ to http://github.com/): the guest's own name for github.com reaches the reverse relay, and the advertisement comes back through it
    expect(answered["git"]).toEqual({ status: "exit 0", body: `${SHA}\tHEAD\n${SHA}\trefs/heads/main` });
    // git to a host outside the policy goes through the CONNECT relay and fails
    expect(answered["gitOutside"]!.status).toBe("exit 128");
    // the listeners' own decisions, which the guest cannot forge: the same story from the host side
    expect(tunnels).toEqual([{ outcome: "allow", host: DIRECT }, { outcome: "not_allowed", host: OUTSIDE }, { outcome: "interception_required", host: REWRITTEN }, { outcome: "not_allowed", host: OUTSIDE }]);
    expect(reverse).toEqual([{ outcome: "allow", host: REWRITTEN }, { outcome: "not_allowed", host: OUTSIDE }, { outcome: "allow", host: MODEL_HOST }, { outcome: "allow", host: GIT_HOST }]);
    // what reached the upstream: the added header on the rewritten host only, and no credential from the guest anywhere
    expect(upstreamSaw.map((s) => [s.host, s.url])).toEqual([[REWRITTEN, "/probe"], [MODEL_HOST, "/probe"], [GIT_HOST, "/fx-test/repo.git/info/refs?service=git-upload-pack"]]);
    expect(upstreamSaw.map((s) => s.header)).toEqual(["added-by-the-host", undefined, undefined]);
    expect(upstreamSaw.every((s) => s.credential === undefined)).toBe(true);
  }, 420_000);

  it("under the job's own policy, a plain list of hosts, the model host is served and git's host and every other host are refused", async () => {
    const answered = await probe({ allow: [MODEL_HOST] });
    expect(answered["model"]!.status).toMatch(/^HTTP\/1\.[01] 200 OK$/);
    expect(JSON.parse(answered["model"]!.body as string)).toMatchObject({ host: MODEL_HOST });
    // not listed: github.com (git's rewrite reaches the reverse relay and is refused there), and the others, on both relays
    expect(answered["git"]!.status).toBe("exit 128");
    expect(answered["outsideReverse"]!.status).toContain("403");
    for (const key of ["direct", "outside", "rewrittenTunnel"]) expect(answered[key]!.status, key).toContain("403");
    expect(answered["rewritten"]!.status).toContain("403");
    expect(reverse.filter((d) => d.outcome === "allow")).toEqual([{ outcome: "allow", host: MODEL_HOST }]);
    expect(reverse.some((d) => d.outcome === "not_allowed" && d.host === GIT_HOST)).toBe(true);
    expect(tunnels.every((d) => d.outcome !== "allow")).toBe(true);
    expect(upstreamSaw.map((s) => s.host)).toEqual([MODEL_HOST]);
  }, 420_000);
});
