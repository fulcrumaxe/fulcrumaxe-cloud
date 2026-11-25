import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createInstallScriptRoute } from "@fulcrumaxe/release-verify/installRoute";
import { startInstallRelease, stubsDir, stubRunner, targetPath, type InstallReleaseWorld } from "../helpers/installRelease.js";
import { generateSelfSignedCert } from "../helpers/selfSignedCert.js";

/**
 * D#845 ON-4b: the install script, served by the real route over local TLS, run with `sh` in two clean containers that have curl and nothing else
 * (Debian slim, and Alpine with busybox). No Node, no openssl, no jq. The release is a fixture one made by the real release tools with fixture keys;
 * the route runs the same TufClient, the same refresh and the same getTargetInfo as production, through the factory's test-only `{build, ca}`.
 * The fixture CA reaches curl through CURL_CA_BUNDLE, a curl setting; the script has no flag for it and FX_INSTALL_BASE_URL is never set.
 *
 * This needs a Docker daemon and, the first time, the network (to pull the base images and install curl). Where Docker is not usable the suite is
 * skipped with a message that says why, unless FX_REQUIRE_DOCKER=1, which turns that into a failure (use it wherever the suite has to be proof).
 * Nothing here runs the real `claude` command: the only `claude` in a container is a stub that prints a version.
 */
const DOCKER_ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test" as const };
const docker = (args: string[], options: { input?: string; timeout?: number } = {}) =>
  spawnSync("docker", args, { encoding: "utf8", env: DOCKER_ENV, timeout: options.timeout ?? 120_000, killSignal: "SIGKILL", ...(options.input === undefined ? {} : { input: options.input }) });

function dockerProblem(): string | undefined {
  const probe = docker(["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 });
  if (probe.error !== undefined || probe.status !== 0) return "no usable Docker daemon";
  return undefined;
}
const PROBLEM = dockerProblem();
if (PROBLEM !== undefined) console.warn(`install-containers: skipped, ${PROBLEM}. Set FX_REQUIRE_DOCKER=1 to make this a failure.`);

const IMAGES = [
  { name: "debian", dockerfile: "FROM debian:stable-slim\nRUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*\n", shell: "dash" },
  { name: "alpine", dockerfile: "FROM alpine:3\nRUN apk add --no-cache curl\n", shell: "busybox ash" },
] as const;
const tagOf = (image: (typeof IMAGES)[number]): string => `fx-on4b-${image.name}:${createHash("sha256").update(image.dockerfile).digest("hex").slice(0, 12)}`;

const UID = "1000";
const HOME_IN = "/home/fx";

interface Run {
  fetched: number | undefined;
  exit: number | undefined;
  version: string | undefined;
  link: string | undefined;
  tree: string[];
  stdout: string;
  stderr: string;
}

/** Fetch the script from the route and run it with `sh`, as MC-5's fixed stage command does (to a file, not a pipe), then report what is on disk. */
async function inContainer(image: (typeof IMAGES)[number], url: string, caFile: string, stubs: string): Promise<Run> {
  const script = [
    "set -u",
    `curl --proto '=https' --tlsv1.2 -fsSL "$INSTALL_URL" -o /tmp/install.sh`,
    'echo "FETCH:$?"',
    "sh /tmp/install.sh --yes --non-interactive",
    'echo "EXIT:$?"',
    'if [ -x "$HOME/.local/bin/fx-runner" ]; then echo "VERSION:$("$HOME/.local/bin/fx-runner" --version)"; echo "LINK:$(readlink "$HOME/.local/bin/fx-runner")"; fi',
    'find "$HOME" | sort | sed 1d | sed "s#^$HOME#~#" | sed "s#^#TREE:#"',
  ].join("\n");
  const name = `fx-on4b-${randomBytes(5).toString("hex")}`;
  try {
    // Asynchronous on purpose: the route server runs in this process, and a blocking call would stop it answering the container's curl.
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        "docker",
        [
          "run", "--rm", "--name", name, "--network", "host", "--user", `${UID}:${UID}`,
          "--tmpfs", `${HOME_IN}:rw,exec,uid=${UID},gid=${UID},mode=0755`,
          "-v", `${caFile}:/fixture-ca.pem:ro`, "-v", `${stubs}:/stubs:ro`,
          "-e", `HOME=${HOME_IN}`, "-e", "CURL_CA_BUNDLE=/fixture-ca.pem", "-e", `INSTALL_URL=${url}`,
          "-e", "PATH=/stubs:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          tagOf(image), "sh", "-c", script,
        ],
        { env: DOCKER_ENV, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve({ stdout, stderr });
      });
    });
    const lines = result.stdout.split("\n");
    const pick = (key: string): string | undefined => lines.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1);
    const number = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
    return { fetched: number(pick("FETCH")), exit: number(pick("EXIT")), version: pick("VERSION"), link: pick("LINK"), tree: lines.filter((l) => l.startsWith("TREE:")).map((l) => l.slice(5)), stdout: result.stdout, stderr: result.stderr };
  } finally {
    docker(["rm", "-f", name], { timeout: 30_000 });
  }
}

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  world: InstallReleaseWorld;
  url: string;
  caFile: string;
  stubs: string;
  /** The `x-fx-install-state` the route answered with, one per request. */
  states: string[];
  /** Replaces the route that answers (a new factory over the same TUF state directory, or over another build). */
  useRoute(route: () => Promise<Response>): void;
  stateDir: string;
}

/** The real route behind a real TLS server, over a fixture release. The factory is the production one; only `{build, ca, stateDir}` are the test's. */
async function harness(): Promise<Harness> {
  const world = await startInstallRelease();
  closers.push(() => world.close());
  const dir = mkdtempSync(path.join(tmpdir(), "fx-on4b-"));
  dirs.push(dir);
  const stateDir = path.join(dir, "tuf-state");
  const stubs = stubsDir();
  dirs.push(stubs);
  const cert = generateSelfSignedCert("127.0.0.1", 1, { ipAddresses: ["127.0.0.1"] });
  const caFile = path.join(dir, "ca.pem");
  writeFileSync(caFile, `${world.ca}\n${cert.certPem}\n`);
  const states: string[] = [];
  let route = createInstallScriptRoute({ build: world.build, ca: world.ca, stateDir });
  const server = https.createServer({ cert: cert.certPem, key: cert.keyPem }, (req, res) => {
    if (req.method !== "GET" || req.url !== "/install.sh") return void res.writeHead(404).end();
    route()
      .then(async (answer) => {
        states.push(answer.headers.get("x-fx-install-state") ?? "");
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
      })
      .catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
  return { world, url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/install.sh`, caFile, stubs, states, stateDir, useRoute: (next) => void (route = next) };
}

const suite = describe.skipIf(PROBLEM !== undefined && process.env.FX_REQUIRE_DOCKER !== "1");

suite("install.sh from the route, in clean containers", () => {
  beforeAll(() => {
    if (PROBLEM !== undefined) throw new Error(`FX_REQUIRE_DOCKER=1 but there is ${PROBLEM}`);
    for (const image of IMAGES) {
      const built = docker(["build", "-q", "-t", tagOf(image), "-"], { input: image.dockerfile, timeout: 540_000 });
      if (built.status !== 0) throw new Error(`could not build the ${image.name} image (needs the network the first time): ${built.stderr.slice(0, 300)}`);
    }
  }, 600_000);

  it("the images hold curl and no Node, openssl, jq or sudo", () => {
    for (const image of IMAGES) {
      const probe = docker(["run", "--rm", tagOf(image), "sh", "-c", "for t in curl sha256sum; do command -v $t >/dev/null || echo missing:$t; done; for t in node npm openssl jq sudo python3; do command -v $t >/dev/null && echo present:$t; done; echo done"]);
      expect(probe.stdout.trim(), image.name).toBe("done");
    }
  }, 120_000);

  it("no test here sets the script's base-URL seam", () => {
    expect(process.env.FX_INSTALL_BASE_URL).toBeUndefined();
    expect(DOCKER_ENV).not.toHaveProperty("FX_INSTALL_BASE_URL");
  });

  describe.each(IMAGES)("on $name ($shell)", (image) => {
    const T = 180_000;

    it("(a) installs the newest complete release: fx-runner --version prints it, the link and the layout are there, a version missing a platform is skipped", async () => {
      const h = await harness();
      h.world.publish("1.0.0");
      h.world.publish("1.1.0");
      h.world.publish("2.0.0", { platforms: ["darwin-arm64", "darwin-x64", "linux-arm64"] }); // no linux-x64 file: never served, on any platform
      const run = await inContainer(image, h.url, h.caFile, h.stubs);
      expect(run.fetched, run.stderr).toBe(0);
      expect(run.exit, run.stdout + run.stderr).toBe(0);
      expect(run.version).toBe("fx-runner 1.1.0 (fixture)");
      expect(run.link).toBe(`${HOME_IN}/.fx-runner/bin/fx-runner`);
      expect(run.tree).toEqual(expect.arrayContaining(["~/.fx-runner/versions/1.1.0/fx-runner", "~/.fx-runner/bin/fx-runner", "~/.local/bin/fx-runner"]));
      expect(run.tree.some((l) => l.includes("2.0.0"))).toBe(false);
      expect(run.tree.some((l) => l.includes("1.0.0"))).toBe(false);
      expect(h.states).toEqual(["ok"]);
    }, T);

    it("(b) bytes of the same length as the signed file but different: exit 1, nothing in ~/.local/bin, no versions/<v>", async () => {
      const h = await harness();
      h.world.publish("1.0.0");
      const real = stubRunner("1.0.0", "linux-x64");
      h.world.replaceFile(targetPath("1.0.0", "linux-x64"), Buffer.from(real.toString("utf8").replace("fixture runner", "pwned!! runner")));
      const run = await inContainer(image, h.url, h.caFile, h.stubs);
      expect(run.exit, run.stdout + run.stderr).toBe(1);
      expect(run.stderr).toContain("does not match the checksum");
      expect(run.tree.filter((l) => l.includes(".local") || l.includes("versions") || l.includes("/bin"))).toEqual([]);
      expect(run.version).toBeUndefined();
    }, T);

    it("(c) a file longer or shorter than the signed length: exit 1, the size cap is hit, nothing installed", async () => {
      const h = await harness();
      h.world.publish("1.0.0");
      const real = stubRunner("1.0.0", "linux-x64");
      h.world.replaceFile(targetPath("1.0.0", "linux-x64"), Buffer.concat([real, Buffer.from(`# ${"padding ".repeat(500)}\n`)]));
      const padded = await inContainer(image, h.url, h.caFile, h.stubs);
      expect(padded.exit, padded.stdout + padded.stderr).toBe(1);
      expect(padded.stderr).toMatch(/Maximum file size exceeded|\(63\)/);
      h.world.replaceFile(targetPath("1.0.0", "linux-x64"), real.subarray(0, real.length - 7));
      const short = await inContainer(image, h.url, h.caFile, h.stubs);
      expect(short.exit, short.stdout + short.stderr).toBe(1);
      expect(short.stderr).toContain("bytes, not the");
      for (const run of [padded, short]) {
        expect(run.tree.filter((l) => l.includes(".local") || l.includes("versions") || l.includes("/bin"))).toEqual([]);
        expect(run.version).toBeUndefined();
      }
    }, T);

    it("(d) metadata re-signed with a key the root does not list: the refusal script, exit 1, refused:bad_signature, nothing written", async () => {
      const h = await harness();
      h.world.publish("1.0.0");
      h.world.resignTargetsWithStranger();
      const run = await inContainer(image, h.url, h.caFile, h.stubs);
      expect(run.fetched).toBe(0);
      expect(run.exit).toBe(1);
      expect(run.stderr).toContain("fx-runner install: refused:");
      expect(h.states).toEqual(["refused:bad_signature"]);
      expect(run.tree).toEqual([]);
    }, T);

    it("(e) an expired timestamp: paused:metadata_expired", async () => {
      const h = await harness();
      h.world.publish("1.0.0", { now: new Date(Date.now() - 4 * 86_400_000), days: { timestamp: 1, snapshot: 1 } });
      const run = await inContainer(image, h.url, h.caFile, h.stubs);
      expect(run.exit).toBe(1);
      expect(run.stderr).toContain("fx-runner install: paused:");
      expect(h.states).toEqual(["paused:metadata_expired"]);
      expect(run.tree).toEqual([]);
    }, T);

    it("(f) an older snapshot served after a newer one was trusted: refused:rollback", async () => {
      const h = await harness();
      h.world.publish("1.0.0");
      const older = h.world.snapshotMetadata();
      h.world.publish("1.1.0");
      expect((await inContainer(image, h.url, h.caFile, h.stubs)).exit).toBe(0);
      // a route instance that remembers what it trusted (the same TUF state), now handed the older metadata
      h.world.restoreMetadata(older);
      h.useRoute(createInstallScriptRoute({ build: h.world.build, ca: h.world.ca, stateDir: h.stateDir }));
      const run = await inContainer(image, h.url, h.caFile, h.stubs);
      expect(run.exit).toBe(1);
      expect(run.stderr).toContain("fx-runner install: refused:");
      expect(h.states).toEqual(["ok", "refused:rollback"]);
    }, T);

    it("(g) a build with no base URLs: not_configured, exit 1, a fixed line on stderr, nothing fetched from the release host", async () => {
      const h = await harness();
      h.world.publish("1.0.0");
      h.useRoute(createInstallScriptRoute({ build: { root: h.world.build.root, metadataBaseUrl: undefined, targetBaseUrl: undefined }, ca: h.world.ca, stateDir: h.stateDir }));
      const before = h.world.server.requests.length;
      const run = await inContainer(image, h.url, h.caFile, h.stubs);
      expect(run.exit).toBe(1);
      expect(run.stderr).toContain("fx-runner install: not_configured:");
      expect(h.states).toEqual(["not_configured"]);
      expect(h.world.server.requests.length).toBe(before);
      expect(run.tree).toEqual([]);
    }, T);
  });
});
