import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SIDECAR_DIR, buildSidecar, packSidecar, swapSidecar, unpackSidecar, verifySidecar } from "../../scripts/sidecar.mjs";
import { sidecarTarget, type SidecarOps } from "../../src/update/updater.js";
import { linkedVersion, versionsDir } from "../../src/update/versions.js";
import { tmpRoot } from "../helpers/tmpRoot.js";
import { program, updateWorld } from "../helpers/updateWorld.js";

/**
 * D#749 V2c-2c: the updater installs the release's Playwright sidecar beside the binary in the same staging directory (one rename), refuses the whole update when a listed sidecar fails any check,
 * and lays one down for the version in use. The sidecar here is the REAL pinned library, packed by the release's own code; only the release client is a stand-in (as for the binaries).
 */
let archive: Buffer;
let digest: string;
beforeAll(() => {
  const dir = path.join(mkdtempSync(path.join(tmpRoot(), "upd-sidecar-")), SIDECAR_DIR);
  const built = buildSidecar({ dest: dir });
  archive = packSidecar(dir);
  digest = built.digest;
  rmSync(path.dirname(dir), { recursive: true, force: true });
});

const ops = (over: Partial<SidecarOps> = {}): SidecarOps => ({
  unpack: (bytes, dest) => void unpackSidecar(bytes, dest),
  swap: (next, final) => swapSidecar(next, final),
  intact: (dir) => verifySidecar(dir, digest),
  ...over,
});
const folder = (stateDir: string, version: string): string => path.join(versionsDir(stateDir), version, SIDECAR_DIR);
const listing = (stateDir: string): string[] => readdirSync(versionsDir(stateDir)).sort();
const flip = (bytes: Buffer, fromEnd: number): Buffer => {
  const copy = Buffer.from(bytes);
  copy[copy.length - fromEnd] = copy[copy.length - fromEnd]! ^ 0xff;
  return copy;
};

describe("installing a release that has a sidecar", () => {
  it("lands the binary and the verified sidecar folder together, then switches the link", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add("v1.1.0/fx-runner-linux-x64", program("1.1.0"));
    w.tuf.add(sidecarTarget("1.1.0"), archive);
    const result = await w.updater.applyLatest();
    expect(result).toMatchObject({ ok: true, version: "1.1.0" });
    expect(linkedVersion(w.stateDir)).toBe("1.1.0");
    expect(readdirSync(path.join(versionsDir(w.stateDir), "1.1.0")).sort()).toEqual(["fx-runner", SIDECAR_DIR]);
    expect(verifySidecar(folder(w.stateDir, "1.1.0"), digest)).toBe(true);
    expect(listing(w.stateDir)).toEqual(["1.0.0", "1.1.0"]);
    expect(w.tuf.fetchCalls).toContain("v1.1.0/fx-runner-linux-x64");
    expect(w.tuf.fetchCalls).toContain("v1.1.0/fx-runner-playwright.fxsc");
  });

  it("unpacks the very bytes whose hash was checked: the archive is read once, and what the host gets is those bytes (a file swapped on disk afterwards is never what is unpacked)", async () => {
    const seen: Buffer[] = [];
    const downloads = (): string => (w.tuf as unknown as { dir: string }).dir;
    const swappedOnDisk = flip(archive, 50);
    const w = updateWorld({
      current: "1.0.0",
      over: {
        sidecar: ops({
          unpack: (bytes, dest) => {
            seen.push(bytes);
            // The download on disk is replaced after the updater has what it needs: the install must not read it again.
            for (const name of readdirSync(downloads())) if (name.startsWith("dl-")) writeFileSync(path.join(downloads(), name), swappedOnDisk);
            unpackSidecar(bytes, dest);
          },
        }),
      },
    });
    w.tuf.add("v1.1.0/fx-runner-linux-x64", program("1.1.0"));
    w.tuf.add(sidecarTarget("1.1.0"), archive);
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true, version: "1.1.0" });
    expect(seen).toHaveLength(1);
    expect(Buffer.isBuffer(seen[0])).toBe(true);
    expect(createHash("sha256").update(seen[0]!).digest("hex")).toBe(createHash("sha256").update(archive).digest("hex"));
    expect(verifySidecar(folder(w.stateDir, "1.1.0"), digest)).toBe(true);
  });

  it("a release that lists no sidecar installs as before, with no folder", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add("v1.1.0/fx-runner-linux-x64", program("1.1.0"));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true, version: "1.1.0" });
    expect(existsSync(folder(w.stateDir, "1.1.0"))).toBe(false);
  });

  const unchanged = (w: ReturnType<typeof updateWorld>): void => {
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    expect(listing(w.stateDir)).toEqual(["1.0.0"]);
  };

  it("an archive with a changed file is refused (the signed hash covers the changed bytes, the header does not): the link, the versions and the staging area are untouched", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add("v1.1.0/fx-runner-linux-x64", program("1.1.0"));
    w.tuf.add(sidecarTarget("1.1.0"), flip(archive, 50));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "sidecar_refused" });
    unchanged(w);
  });

  it("an archive whose bytes are not the signed hash is refused", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add("v1.1.0/fx-runner-linux-x64", program("1.1.0"));
    w.tuf.add(sidecarTarget("1.1.0"), archive);
    w.tuf.lies.set(sidecarTarget("1.1.0"), "a".repeat(64));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "sidecar_refused" });
    unchanged(w);
  });

  it("a sidecar the release client refuses (a bad signature, say) refuses the whole update; the binary is not installed without it", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add("v1.1.0/fx-runner-linux-x64", program("1.1.0"));
    w.tuf.add(sidecarTarget("1.1.0"), archive);
    w.tuf.refusals.set(sidecarTarget("1.1.0"), { ok: false, state: "refused", code: "target_mismatch", message: "x" });
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "target_mismatch" });
    unchanged(w);
  });

  it("a binary that fails its start check takes its sidecar with it: nothing of that version stays", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add("v1.1.0/fx-runner-linux-x64", program("1.1.0", { doctorExit: 1 }));
    w.tuf.add(sidecarTarget("1.1.0"), archive);
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "start_check_failed" });
    unchanged(w);
  });

  it("an unpack that dies part-way leaves nothing", async () => {
    const w = updateWorld({
      current: "1.0.0",
      over: {
        sidecar: ops({
          unpack: (_bytes, dest) => {
            mkdirSync(path.join(dest, "node_modules"), { recursive: true });
            throw new Error("disk full");
          },
        }),
      },
    });
    w.tuf.add("v1.1.0/fx-runner-linux-x64", program("1.1.0"));
    w.tuf.add(sidecarTarget("1.1.0"), archive);
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "sidecar_refused" });
    unchanged(w);
  });
});

describe("laying a sidecar down for the version in use", () => {
  it("fetches, verifies and swaps it in beside the binary once, and does nothing when it is already intact", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add(sidecarTarget("1.0.0"), archive);
    expect(await w.updater.ensureSidecar()).toMatchObject({ ok: true, version: "1.0.0" });
    expect(verifySidecar(folder(w.stateDir, "1.0.0"), digest)).toBe(true);
    expect(listing(w.stateDir)).toEqual(["1.0.0"]);
    expect(await w.updater.ensureSidecar()).toMatchObject({ ok: true, message: "the Playwright sidecar is in place" });
    expect(w.tuf.fetchCalls).toEqual([sidecarTarget("1.0.0")]);
  });

  it("replaces a folder that is not the one the running program was built with", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    mkdirSync(path.join(folder(w.stateDir, "1.0.0"), "node_modules", "evil"), { recursive: true });
    w.tuf.add(sidecarTarget("1.0.0"), archive);
    expect(await w.updater.ensureSidecar()).toMatchObject({ ok: true });
    expect(verifySidecar(folder(w.stateDir, "1.0.0"), digest)).toBe(true);
    expect(existsSync(path.join(folder(w.stateDir, "1.0.0"), "node_modules", "evil"))).toBe(false);
  });

  it("a swap that fails puts the old folder back and leaves no staging directory", async () => {
    const w = updateWorld({
      current: "1.0.0",
      over: {
        sidecar: ops({
          swap: (next, final) => {
            let calls = 0;
            swapSidecar(next, final, (from: string, to: string) => {
              calls += 1;
              if (calls === 2) throw new Error("rename failed");
              renameSync(from, to);
            });
          },
        }),
      },
    });
    mkdirSync(path.join(folder(w.stateDir, "1.0.0"), "node_modules", "old"), { recursive: true });
    w.tuf.add(sidecarTarget("1.0.0"), archive);
    expect(await w.updater.ensureSidecar()).toMatchObject({ ok: false, code: "sidecar_refused" });
    expect(existsSync(path.join(folder(w.stateDir, "1.0.0"), "node_modules", "old"))).toBe(true);
    expect(listing(w.stateDir)).toEqual(["1.0.0"]);
    expect(readdirSync(path.join(versionsDir(w.stateDir), "1.0.0")).sort()).toEqual(["fx-runner", SIDECAR_DIR]);
  });

  it("cleanup removes a fx-runner-playwright.old-<hex> folder that a swap which died left in a version directory, and keeps the real folder", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    mkdirSync(path.join(folder(w.stateDir, "1.0.0"), "node_modules"), { recursive: true });
    const stale = `${folder(w.stateDir, "1.0.0")}.old-0123456789ab`;
    mkdirSync(stale);
    await w.updater.cleanup();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(folder(w.stateDir, "1.0.0"))).toBe(true);
  });

  it("a tampered archive is refused and the version in use is left as it is", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add(sidecarTarget("1.0.0"), flip(archive, 70));
    expect(await w.updater.ensureSidecar()).toMatchObject({ ok: false, code: "sidecar_refused" });
    expect(existsSync(folder(w.stateDir, "1.0.0"))).toBe(false);
    expect(listing(w.stateDir)).toEqual(["1.0.0"]);
  });

  it("a release with no sidecar is left alone, and a program with no sidecar support does nothing", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    expect(await w.updater.ensureSidecar()).toMatchObject({ ok: true, message: expect.stringContaining("without a Playwright sidecar") });
    expect(existsSync(folder(w.stateDir, "1.0.0"))).toBe(false);
    const plain = updateWorld({ current: "1.0.0" });
    expect(await plain.updater.ensureSidecar()).toMatchObject({ ok: true });
    expect(plain.tuf.fetchCalls).toEqual([]);
  });

  it("an automatic update check lays it down first, then goes on to look for a newer version", async () => {
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops() } });
    w.tuf.add(sidecarTarget("1.0.0"), archive);
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true });
    expect(verifySidecar(folder(w.stateDir, "1.0.0"), digest)).toBe(true);
    expect(w.tuf.listCalls).toBe(1);
  });

  it("is a no-op for an install it does not manage", async () => {
    const elsewhere = mkdtempSync(path.join(tmpRoot(), "elsewhere-"));
    const w = updateWorld({ current: "1.0.0", over: { sidecar: ops(), execPath: path.join(elsewhere, "fx-runner") } });
    w.tuf.add(sidecarTarget("1.0.0"), archive);
    expect(await w.updater.ensureSidecar()).toMatchObject({ ok: false, code: "unmanaged" });
    expect(w.tuf.fetchCalls).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
