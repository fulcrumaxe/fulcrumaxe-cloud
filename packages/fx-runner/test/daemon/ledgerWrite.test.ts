import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two things about the way the ledger writes cannot be seen from the file it leaves: that the temporary file is opened exclusively
// (its name is random), and that it is flushed before the rename. So the random name is pinned, and the file calls are recorded.
const calls: string[] = [];
vi.mock("node:crypto", async (original) => {
  const real = await original<typeof import("node:crypto")>();
  return { ...real, randomBytes: (size: number) => Buffer.alloc(size, 0xab) };
});
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return {
    ...real,
    fsyncSync: (fd: number) => (calls.push("fsync"), real.fsyncSync(fd)),
    renameSync: (from: string, to: string) => (calls.push(`rename ${path.basename(to)}`), real.renameSync(from, to)),
  };
});

const { createFileLedger } = await import("../../src/daemon/ledger.js");
const { ledgerOptions } = await import("../helpers/ledgerOptions.js");

const A = "11111111-1111-4111-8111-111111111111";
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxr-ledger-write-"));
  file = path.join(dir, "jobs.json");
  calls.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the ledger's write", () => {
  it("flushes the temporary file to disk, and only then renames it over the ledger", () => {
    const ledger = createFileLedger(file, ledgerOptions());
    // Publishing the lock flushes its own temp file too; this test is about the write of the ledger file.
    calls.length = 0;
    expect(ledger.claim(A)).toBe(true);
    expect(calls).toEqual(["fsync", "rename jobs.json"]);
    ledger.close();
  });

  it("opens the temporary file exclusively: a file or link already at that name is never written through, and the claim is refused", () => {
    const ledger = createFileLedger(file, ledgerOptions());
    const victim = path.join(dir, "victim");
    writeFileSync(victim, "keep");
    const temp = `${file}.${"ab".repeat(6)}.tmp`;
    symlinkSync(victim, temp);
    expect(ledger.claim(A)).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    // Not removed either: it was not this call's file.
    expect(lstatSync(temp).isSymbolicLink()).toBe(true);
    expect(existsSync(file)).toBe(false);
    rmSync(temp);
    expect(ledger.claim(A)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    ledger.close();
  });
});
