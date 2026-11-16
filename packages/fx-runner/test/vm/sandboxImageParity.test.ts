import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The microVM guest image must carry what infra/sandbox-image carries, so scripts/check.sh behaves the same in a VM: the same node,
 * pnpm and claude (version, and for amd64 the very same download and sha256), Postgres 18, and Chromium at the Playwright version
 * pnpm-lock.yaml resolves, with Chromium's own sandbox left on. These are file-level checks; booting the image is the release gate.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (...p: string[]): string => readFileSync(path.join(ROOT, ...p), "utf8");

interface Pin {
  url: string;
  sha256: string;
}
interface SandboxLock {
  artifacts: Record<string, { version: string; url: string; sha256: string }>;
}
interface VmLock {
  artifacts: Record<string, { version: string; amd64: Pin; arm64: Pin }>;
}

const sandboxLock = JSON.parse(read("infra", "sandbox-image", "versions.lock.json")) as SandboxLock;
const vmLock = JSON.parse(read("infra", "microvm-image", "lock.json")) as VmLock;
const sandboxDockerfile = read("infra", "sandbox-image", "Dockerfile");
const vmDockerfile = read("infra", "microvm-image", "Dockerfile");

const SHARED = ["node", "pnpm", "claude"] as const;

/** Every way the microVM lock differs from the sandbox lock, as readable sentences; empty when they agree. */
export function drift(sandbox: SandboxLock, vm: VmLock): string[] {
  const out: string[] = [];
  for (const name of SHARED) {
    const s = sandbox.artifacts[name];
    const v = vm.artifacts[name];
    if (s === undefined || v === undefined) {
      out.push(`${name}: missing from one lock`);
      continue;
    }
    if (v.version !== s.version) out.push(`${name}: microVM ${v.version}, sandbox ${s.version}`);
    if (v.amd64.url !== s.url) out.push(`${name}: amd64 url differs`);
    if (v.amd64.sha256 !== s.sha256) out.push(`${name}: amd64 sha256 differs`);
    if (!v.arm64.url.includes(s.version)) out.push(`${name}: arm64 url is not for ${s.version}`);
  }
  return out;
}

const code = (text: string): string => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const arg = (text: string, name: string): string | undefined => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(text)?.[1];

describe("microVM image parity with infra/sandbox-image", () => {
  it("node, pnpm and claude are the sandbox image's versions (and for amd64 its exact downloads)", () => {
    expect(drift(sandboxLock, vmLock)).toEqual([]);
  });

  it("the drift check does see a version or checksum that moves on either side", () => {
    const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
    for (const name of SHARED) {
      const older = clone(vmLock);
      older.artifacts[name]!.version = "0.0.1";
      expect(drift(sandboxLock, older).join("\n"), `${name} version`).toContain(`${name}: microVM 0.0.1`);
      const moved = clone(sandboxLock);
      moved.artifacts[name]!.sha256 = "0".repeat(64);
      expect(drift(moved, vmLock).join("\n"), `${name} sha256`).toContain(`${name}: amd64 sha256 differs`);
      const rebuilt = clone(sandboxLock);
      rebuilt.artifacts[name]!.version = "99.0.0";
      expect(drift(rebuilt, vmLock).length, `${name} sandbox bump`).toBeGreaterThan(0);
    }
  });

  it("the guest has npm and npx, which the Chromium install needs, next to the pinned node", () => {
    expect(vmDockerfile).toMatch(/lib\/node_modules\/npm/);
    expect(vmDockerfile).toMatch(/ln -s \.\.\/lib\/node_modules\/npm\/bin\/npx-cli\.js \/opt\/fx\/bin\/npx/);
  });

  it("installs Postgres 18 the way the sandbox image does, with no cluster and the tools on PATH", () => {
    const sandbox = code(sandboxDockerfile);
    const vm = code(vmDockerfile);
    expect(sandbox).toMatch(/\bpostgresql-18\b/);
    expect(vm).toMatch(/\bpostgresql-18\b/);
    expect(vm, "the unversioned package would follow the distribution's default").not.toMatch(/\bpostgresql( |$)/m);
    expect(vm).toContain("create_main_cluster = false");
    const links = (t: string): string | undefined => /for b in ([a-z_ ]+); do ln -s "\/usr\/lib\/postgresql\/18\/bin\/\$b"/.exec(t)?.[1];
    expect(links(vm)).toBeDefined();
    expect(links(vm)).toBe(links(sandbox));
  });

  it("bakes in Chromium at the Playwright version of the sandbox image and pnpm-lock.yaml", () => {
    const pinned = arg(vmDockerfile, "PLAYWRIGHT_VERSION");
    expect(pinned, "ARG PLAYWRIGHT_VERSION with a default").toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinned).toBe(arg(sandboxDockerfile, "PLAYWRIGHT_VERSION"));
    const resolved = [...read("pnpm-lock.yaml").matchAll(/^ {2}'@playwright\/test@(\d+\.\d+\.\d+)':/gm)].map((m) => m[1]);
    expect(resolved).not.toHaveLength(0);
    expect(new Set(resolved)).toEqual(new Set([pinned]));
    expect(vmDockerfile).toMatch(/playwright@\$\{PLAYWRIGHT_VERSION\} install --with-deps chromium\b/);
    expect(vmDockerfile).toMatch(/^ENV PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright$/m);
    expect(vmDockerfile).toMatch(/chmod -R a\+rX \/opt\/ms-playwright/);
    // Installed as root, before the image drops to the normal user.
    expect(vmDockerfile.indexOf("install --with-deps chromium")).toBeLessThan(vmDockerfile.indexOf("USER ubuntu"));
  });

  it("nothing in the image turns Chromium's own sandbox off", () => {
    const files: Array<[string, string]> = [
      ["Dockerfile", code(vmDockerfile)],
      ["guest/init", code(read("infra", "microvm-image", "guest", "init"))],
      ["guest/agent.py", code(read("infra", "microvm-image", "guest", "agent.py"))],
    ];
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/--no-sandbox|--disable-setuid-sandbox|chromiumSandbox\s*[:=]\s*false/);
      expect(text, name).not.toMatch(/unprivileged_userns_clone|max_user_namespaces|apparmor_restrict_unprivileged_userns/);
    }
  });
});
