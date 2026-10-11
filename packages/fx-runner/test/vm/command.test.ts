import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import type { BuildHost } from "../../src/vm/buildImage.js";
import { vmCommand } from "../../src/vm/command.js";

const IMAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image");
const IMAGE = `registry.example/fx/agent@sha256:${"c".repeat(64)}`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Answers like crane, tar and mke2fs; each disk's bytes name its architecture, so the two digests differ. */
const host = (): BuildHost => {
  let arch = "";
  return {
    async run(file, args) {
      if (file === "crane" && args[0] === "digest") return { code: 0, output: `sha256:${"c".repeat(64)}\n` };
      if (file === "crane") {
        arch = args[2]!;
        writeFileSync(args[4]!, "t");
        return { code: 0, output: "" };
      }
      if (file === "tar") return { code: 0, output: args[0] === "--list" ? "-rw-r--r-- 0/0 10 2026-01-01 00:00 f\n" : "" };
      if (args[0] === "-V") return { code: 0, output: "mke2fs 1.47.2 (1-Jan-2025)" };
      writeFileSync(args[args.length - 1]!, Buffer.concat([Buffer.alloc(1080), Buffer.from([0x53, 0xef]), Buffer.from(`disk ${arch}`)]));
      return { code: 0, output: "" };
    },
  };
};
const run = async (args: string[]): Promise<{ code: number; lines: string[] }> => {
  const lines: string[] = [];
  const out = mkdtempSync(path.join(tmpdir(), "fx-vm-cmd-"));
  dirs.push(out);
  const code = await vmCommand(args.map((a) => (a === "OUT" ? out : a)), host(), (l) => lines.push(l));
  return { code, lines };
};
const base = ["build-image", "--template", "fx-agent", "--image", IMAGE, "--out", "OUT", "--lock", path.join(IMAGE_DIR, "lock.json"), "--guest-dir", path.join(IMAGE_DIR, "guest")];

describe("fx-runner vm build-image", () => {
  it("builds both architectures when none is named, and prints the two rootfs digests", async () => {
    const { code, lines } = await run(base);
    expect(code).toBe(0);
    const roots = lines.filter((l) => l.startsWith("rootfs "));
    expect(roots).toHaveLength(2);
    expect(roots[0]).toMatch(/^rootfs amd64 sha256:[0-9a-f]{64} size \d+$/);
    expect(roots[1]).toMatch(/^rootfs arm64 sha256:[0-9a-f]{64} size \d+$/);
    expect(roots[0]!.split(" ")[2]).not.toBe(roots[1]!.split(" ")[2]);
    expect(lines.join("\n")).toMatch(/agent sha256:[0-9a-f]{64}/);
  });

  it("builds one architecture when asked", async () => {
    const { lines } = await run([...base, "--arch", "arm64"]);
    expect(lines.filter((l) => l.startsWith("rootfs "))).toHaveLength(1);
    expect(lines[0]).toMatch(/^rootfs arm64 /);
  });

  it("refuses bad usage with exit code 2 and names nothing it was given", async () => {
    const bad: string[][] = [
      [],
      ["unknown"],
      ["build-image"],
      ["build-image", "--template", "other", "--image", IMAGE, "--out", "OUT"],
      [...base, "--arch", "riscv"],
      [...base, "--arch"],
      [...base, "--unknown", "x"],
      [...base, "--out", "twice"],
      ["build-image", "--template", "fx-agent", "--image", "registry.example/fx/agent:latest", "--out", "OUT", "--lock", path.join(IMAGE_DIR, "lock.json"), "--guest-dir", path.join(IMAGE_DIR, "guest")],
      [...base.slice(0, -4), "--lock", "/nonexistent/lock.json"],
    ];
    for (const args of bad) {
      const error = await run(args).then(() => undefined, (e: unknown) => e);
      expect(error, JSON.stringify(args)).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode, JSON.stringify(args)).toBe(2);
      expect((error as CliError).message).not.toContain("/nonexistent");
    }
  });
});
