import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import { MIN_CLAUDE_VERSION, compareVersions } from "../../src/engines/claude/pin.js";
import { ARCHES, parseLock } from "../../src/vm/lock.js";

const IMAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image");
const text = readFileSync(path.join(IMAGE_DIR, "lock.json"), "utf8");

interface Pin {
  url: string;
  sha256: string;
}
interface Doc {
  schema: number;
  template: string;
  base_image: string;
  kernel: Record<string, Pin>;
  firecracker: Record<string, Pin>;
  artifacts: Record<string, Record<string, Pin | string>>;
  tools: { crane: Pin; e2fsprogs: Pin & { version: unknown } };
  containers: Record<string, string>;
  rootfs: Record<string, unknown>;
}
const lock = JSON.parse(text) as Doc;
const artifact = (name: string, arch: string): Pin => lock.artifacts[name]![arch] as Pin;

describe("infra/microvm-image/lock.json", () => {
  it("parses, and names the fixed root-disk parameters", () => {
    expect(parseLock(text)).toMatchObject({ template: "fx-agent", e2fsprogsVersion: "1.47.2", rootfs: { label: "fxroot", sourceDateEpoch: 1700000000 } });
  });

  it("pins every download for both architectures: https, no query, and a 64-digit sha256", () => {
    const pins: Array<[string, Pin]> = [];
    for (const arch of ARCHES) {
      pins.push([`kernel.${arch}`, lock.kernel[arch]!], [`firecracker.${arch}`, lock.firecracker[arch]!]);
      for (const name of ["node", "claude", "pnpm"]) pins.push([`artifacts.${name}.${arch}`, artifact(name, arch)]);
    }
    pins.push(["tools.crane", lock.tools.crane], ["tools.e2fsprogs", lock.tools.e2fsprogs]);
    expect(pins.length).toBe(2 * 2 + 3 * 2 + 2);
    for (const [what, pin] of pins) {
      expect(pin.url, what).toMatch(/^https:\/\/[a-z0-9.-]+\/[^?#\s]+$/);
      expect(pin.sha256, what).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the base image is pinned by digest, and the Dockerfile uses the same one in both stages", () => {
    expect(lock.base_image).toMatch(/@sha256:[0-9a-f]{64}$/);
    const dockerfile = readFileSync(path.join(IMAGE_DIR, "Dockerfile"), "utf8");
    const froms = [...dockerfile.matchAll(/^FROM (?:--\S+ )?(\S+)/gm)].map((m) => m[1]);
    expect(froms).toEqual([lock.base_image, lock.base_image]);
  });

  it("the container images the workflow starts are pinned by digest", () => {
    expect(Object.keys(lock.containers).sort()).toEqual(["binfmt", "buildkit", "registry"]);
    for (const [name, ref] of Object.entries(lock.containers)) expect(ref, name).toMatch(/^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/);
  });

  it("the Dockerfile fetches only artifacts the lock has, through the lock", () => {
    const dockerfile = readFileSync(path.join(IMAGE_DIR, "Dockerfile"), "utf8");
    const fetched = [...dockerfile.matchAll(/^\s+fetch (\w+) /gm)].map((m) => m[1]);
    expect(fetched.sort()).toEqual(["claude", "node", "pnpm"]);
    for (const name of fetched) expect(Object.keys(lock.artifacts[name!]!)).toEqual(expect.arrayContaining(["version", ...ARCHES]));
    expect(dockerfile).not.toMatch(/https?:\/\//);
  });

  it("the guest's claude is at least the version the runner's own check demands", () => {
    const version = lock.artifacts["claude"]!["version"] as string;
    expect(compareVersions(version, MIN_CLAUDE_VERSION)).toBeGreaterThanOrEqual(0);
    for (const arch of ARCHES) expect(artifact("claude", arch).url).toContain(`/${version}/`);
  });

  it("refuses a lock it cannot trust", () => {
    const mutate = (fn: (l: Doc) => void): string => {
      const copy = JSON.parse(text) as Doc;
      fn(copy);
      return JSON.stringify(copy);
    };
    const cases: Array<[string, string]> = [
      ["not JSON", "{"],
      ["schema", mutate((l) => (l.schema = 2))],
      ["template", mutate((l) => (l.template = "other"))],
      ["epoch", mutate((l) => (l.rootfs["source_date_epoch"] = -1))],
      ["uuid", mutate((l) => (l.rootfs["fs_uuid"] = "nope"))],
      ["seed", mutate((l) => (l.rootfs["hash_seed"] = 7))],
      ["label", mutate((l) => (l.rootfs["label"] = "../x"))],
      ["e2fsprogs", mutate((l) => (l.tools.e2fsprogs.version = "latest"))],
    ];
    for (const [what, bad] of cases) expect(() => parseLock(bad), what).toThrow(CliError);
  });
});
