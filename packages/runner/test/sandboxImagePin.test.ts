import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_BACKEND } from "../src/backends.js";
import {
  CLAUDE_CLI_SHA256,
  CLAUDE_CLI_VERSION,
  LIST_SESSIONS_MAX_LIMIT,
  SANDBOX_AGENT_COMMAND,
  createVercelSandboxPort,
  type SdkCommand,
  type SdkCreateParams,
  type SdkSandbox,
  type SdkSession,
  type VercelSandboxSdk,
} from "../src/vercelSandboxPort.js";
import { SandboxImageConfigError, SANDBOX_IMAGE_REF, resolveSandboxImage } from "../src/sandboxRuntime.js";
import { FX_AGENT_CONFIG_DIR } from "../src/agentConfig.js";
import { PREVIEW_WORKDIR } from "../src/repoClone.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import type { SandboxHandle } from "../src/sandboxPort.js";

/**
 * The sandbox image, the CLI version, the Dockerfile and the session-list page size, pinned together. Reads
 * `infra/sandbox-image` (the Dockerfile and the lockfile) and runs the port against a fake SDK that enforces the
 * real SDK's create-parameter union and Vercel's list limit.
 */
const ROOT = new URL("../../../", import.meta.url).pathname;
const dockerfile = readFileSync(`${ROOT}infra/sandbox-image/Dockerfile`, "utf8");
const lock = JSON.parse(readFileSync(`${ROOT}infra/sandbox-image/versions.lock.json`, "utf8")) as {
  image: { repository: string; digest: string };
  artifacts: { claude: { version: string; url: string; sha256: string } };
};
const dockerLines = dockerfile.split("\n").filter((l) => !l.trim().startsWith("#"));

const DIGEST = `sha256:${"ab".repeat(32)}`;
const NAME = "rn-8-reviewer-run-1";
const handle: SandboxHandle = { runId: "", sandboxName: NAME };
const createOpts = { sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 };

const listError = (limit: number): Error =>
  Object.assign(new Error(`Bad Request: limit should be <= 50 (got ${limit})`), { response: { status: 400 } });

/**
 * A fake SDK that keeps two real contracts. `create` takes the SDK's union: an image, or a legacy runtime, never both
 * and never neither (`runtime?: never` on the image arm). `listSessions` rejects a `limit` over 50 as the API does.
 */
function fakeSdk(pages: SdkSession[][] = [[]]) {
  const created: SdkCreateParams[] = [];
  const lists: { limit?: number; cursor?: string }[] = [];
  const sandbox: SdkSandbox = {
    name: NAME,
    status: "running",
    currentSession: () => ({ sessionId: "sess-1" }),
    async runCommand(): Promise<SdkCommand> {
      return { async *logs() {}, wait: async () => ({ exitCode: 0 }), kill: async () => undefined };
    },
    writeFiles: async () => undefined,
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    async listSessions(params) {
      lists.push({ limit: params?.limit, cursor: params?.cursor });
      if (params?.limit !== undefined && params.limit > 50) throw listError(params.limit);
      const index = Number(params?.cursor ?? 0);
      return { sessions: pages[index] ?? [], pagination: { next: index + 1 < pages.length ? String(index + 1) : null } };
    },
  };
  const sdk: VercelSandboxSdk = {
    async create(params) {
      const p = params as unknown as Record<string, unknown>;
      const hasImage = typeof p.image === "string" && p.image !== "";
      const hasRuntime = "runtime" in p && p.runtime !== undefined;
      if (hasImage === hasRuntime) throw Object.assign(new Error("exactly one of image or runtime"), { response: { status: 400 } });
      created.push(params);
      return sandbox;
    },
    get: async () => sandbox,
  };
  return { sdk, created, lists };
}

const newPort = (sdk: VercelSandboxSdk, extra: { image?: string } = {}) =>
  createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk, measureRetryDelayMs: 0, ...extra });

describe("the pinned sandbox image", () => {
  it("the lockfile records a digest-pinned image and the runner's reference is exactly it", () => {
    expect(lock.image.repository).toBe("fx-agent");
    expect(lock.image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(SANDBOX_IMAGE_REF).toBe(`${lock.image.repository}@${lock.image.digest}`);
    expect(resolveSandboxImage(SANDBOX_IMAGE_REF)).toBe(SANDBOX_IMAGE_REF);
  });

  it("CLAUDE_CLI_VERSION is the version the lockfile pins into the image, not a second literal", () => {
    expect(CLAUDE_CLI_VERSION).toBe(lock.artifacts.claude.version);
    expect(lock.artifacts.claude.url).toContain(`/${CLAUDE_CLI_VERSION}/`);
    const source = readFileSync(new URL("../src/vercelSandboxPort.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/CLAUDE_CLI_VERSION\s*=\s*"/);
  });

  it("the Claude Code digest the runner checks is the lockfile's, and it is the one the backend carries", () => {
    expect(CLAUDE_CLI_SHA256).toBe(lock.artifacts.claude.sha256);
    expect(CLAUDE_CODE_BACKEND.cliSha256).toBe(lock.artifacts.claude.sha256);
    expect(CLAUDE_CODE_BACKEND.cliVersion).toBe(lock.artifacts.claude.version);
    expect(readFileSync(new URL("../src/sandboxRuntime.ts", import.meta.url), "utf8")).not.toMatch(/CLAUDE_CLI_SHA256\s*[:=][^=]*"[0-9a-f]{64}"/);
  });

  it("createSandbox boots the image: `image` is set to the lockfile reference and no `runtime` is passed", async () => {
    const f = fakeSdk();
    await newPort(f.sdk).createSandbox(createOpts);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]!.image).toBe(SANDBOX_IMAGE_REF);
    expect(f.created[0]).not.toHaveProperty("runtime");
  });

  it("an explicit image reaches the SDK as given", async () => {
    const f = fakeSdk();
    await newPort(f.sdk, { image: `fx-agent@${DIGEST}` }).createSandbox(createOpts);
    expect(f.created[0]!.image).toBe(`fx-agent@${DIGEST}`);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["a managed runtime name", "node24"],
    ["a tag, not a digest", "fx-agent:latest"],
    ["a bare repository (resolves to :latest)", "fx-agent"],
    ["a short digest", "fx-agent@sha256:abc"],
    ["a digest with upper-case hex", `fx-agent@sha256:${"AB".repeat(32)}`],
    ["a fully-qualified URL", `vcr.vercel.com/t/p/fx-agent@${DIGEST}`],
  ])("refuses %s with a typed config error, at port construction and not by falling back to a runtime", (_label, value) => {
    expect(() => resolveSandboxImage(value)).toThrow(SandboxImageConfigError);
    const f = fakeSdk();
    expect(() => newPort(f.sdk, { image: value })).toThrow(SandboxImageConfigError);
    expect(f.created).toEqual([]);
  });

  it("the config error never echoes the value it refused", () => {
    try {
      resolveSandboxImage("registry.example/secret-looking-name:tag");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-looking-name");
      expect((err as Error).name).toBe("SandboxImageConfigError");
    }
  });
});

describe("the Dockerfile and what the runner runs, together", () => {
  const envPath = dockerLines.filter((l) => /^ENV\s+PATH=/.test(l.trim()));

  it("starts the agent by the name `claude`, and PATH puts the pinned /opt/fx/bin first so that name is the image's binary", () => {
    expect(SANDBOX_AGENT_COMMAND[0]).toBe("claude");
    expect(envPath).toHaveLength(1);
    const dirs = envPath[0]!.trim().replace(/^ENV\s+PATH=/, "").split(":");
    expect(dirs[0]).toBe("/opt/fx/bin");
    expect(dirs).toEqual(expect.arrayContaining(["/usr/local/bin", "/usr/bin", "/bin"]));
    expect(dockerfile).toContain("/opt/fx/bin/claude");
    expect(dockerfile).toContain("/opt/fx/bin/node");
  });

  it("ships pnpm pinned by url and sha256 at the version the repo's packageManager field names, checked by the Dockerfile, and npm and npx from the verified node tarball", () => {
    const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { packageManager: string };
    const pnpm = (lock.artifacts as Record<string, { version: string; url: string; sha256: string }>).pnpm!;
    expect(pkg.packageManager).toBe(`pnpm@${pnpm.version}`);
    expect(pnpm.url).toBe(`https://github.com/pnpm/pnpm/releases/download/v${pnpm.version}/pnpm-linux-x64.tar.gz`);
    expect(pnpm.sha256).toMatch(/^[0-9a-f]{64}$/);
    const text = dockerLines.join("\n");
    expect(text).toContain('echo "$PNPM_SHA256  /tmp/dl/pnpm.tar.gz" | sha256sum -c -');
    expect(text).toContain("ln -s ../pnpm/pnpm /opt/fx/bin/pnpm");
    // The pnpm binary needs libatomic at run time; a built image without it fails with "cannot open shared object file".
    expect(text).toMatch(/apt-get install [^\n]*\blibatomic1\b/);
    // npm and npx come out of the same tarball whose sha256 the Dockerfile already checked, as links into /opt/fx/lib.
    expect(text.indexOf('echo "$NODE_SHA256 ')).toBeLessThan(text.indexOf("*/lib/node_modules/npm"));
    expect(text).toContain("ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/fx/bin/npm");
    expect(text).toContain("ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/fx/bin/npx");
    // The links must not point out of the root-owned tree.
    for (const l of dockerLines.filter((x) => /\bln -s\b/.test(x))) expect(l, l).toMatch(/ln -s \.\.\/[\w./-]+ \/opt\/fx\/bin\/\w+/);
  });

  it("the runner's shell commands (clone, counters, prompt wrapper, hook) run under /bin/sh, which the base image has", () => {
    expect(readFileSync(new URL("../src/agentConfig.ts", import.meta.url), "utf8")).toContain("`/bin/sh ${FX_LIMIT_HOOK_PATH}`");
  });

  it("installs git, which the clone script runs", () => {
    expect(dockerLines.join("\n")).toMatch(/apt-get install [^\n]*\bgit\b/);
  });

  it("creates, owned by ubuntu, the directories the runner writes: the clone's parent and the agent config", () => {
    const install = dockerLines.find((l) => /install -d -o ubuntu -g ubuntu/.test(l));
    expect(install).toBeDefined();
    const dirs = install!.replace(/.*install -d -o ubuntu -g ubuntu\s+/, "").replace(/\s*\\$/, "").split(/\s+/);
    expect(PREVIEW_WORKDIR.startsWith("/vercel/sandbox/")).toBe(true);
    expect(dirs).toContain("/vercel/sandbox");
    expect(FX_AGENT_CONFIG_DIR.startsWith("/fx/")).toBe(true);
    expect(dirs).toContain("/fx");
  });
});

describe("listing sessions never asks for more than Vercel allows", () => {
  const full = (id: string): SdkSession => ({ id, memory: 4096, region: "iad1", duration: 300_000, activeCpuDurationMs: 60_000, networkTransfer: { ingress: 1, egress: 2 } });

  it("the page size is a named constant at Vercel's maximum", () => {
    expect(LIST_SESSIONS_MAX_LIMIT).toBe(50);
  });

  it("measure asks for 50 per page, follows the cursor across pages, and the fake would have rejected 100", async () => {
    const f = fakeSdk([[full("a"), full("b")], [full("c")], [full("d")]]);
    const usage = await newPort(f.sdk).measure(handle, ["a", "d"]);
    expect(usage.map((u) => u.sessionId).sort()).toEqual(["a", "d"]);
    expect(f.lists.map((l) => l.limit)).toEqual([50, 50, 50]);
    expect(f.lists.map((l) => l.cursor)).toEqual([undefined, "1", "2"]);
    const rejected = await fakeSdk().sdk.get({ name: NAME, teamId: "t", projectId: "p", token: "x" }).then((s) => s.listSessions({ limit: 100 }).catch((e: Error) => e.message));
    expect(rejected).toContain("limit should be <= 50");
  });
});
