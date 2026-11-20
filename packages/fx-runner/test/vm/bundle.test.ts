import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import type { TufBuildConfig } from "../../src/update/buildConfig.js";
import { TufClient } from "../../src/update/tuf.js";
import { LAYOUT } from "../../src/vm/installPlan.js";
import { hostArch, selectTargets, stageBundle, type StagedBundle } from "../../src/vm/bundle.js";
import { buildRepo, makeKeys, type TestTarget } from "../fixtures/tufRepo.js";
import { startTufServer } from "../fixtures/tufServer.js";

/** D#587 B-2a-2 PR-2: the bundle is chosen from the verified listing, fetched through the verifying client, staged privately, and a manifest is built from the digests. */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const bytes = (what: string): Buffer => Buffer.from(`${what} `.repeat(30));

interface Part {
  name: string;
  content: Buffer;
  /** The listed name, when it must differ from the digest of the content. */
  listedAs?: string;
}
const TAG = "vm-fx-agent-0123456789ab";
const parts = (arch: string, alt = ""): Record<string, Part> => {
  const bin = (n: string): Part => {
    const content = bytes(`${n}${alt} ${arch}`);
    return { name: `${n}-${arch}-${sha(content)}`, content };
  };
  const vm = (kind: string): Part => {
    const content = bytes(`${kind}${alt} ${arch}`);
    return { name: `${TAG}/${kind}-${arch}-${sha(content)}`, content };
  };
  return { vmhelper: bin("vmhelper"), jailer: bin("jailer"), firecracker: bin("firecracker"), kernel: vm("kernel"), rootfs: vm("rootfs") };
};

async function world(listed: Part[], tweak: (t: TestTarget[]) => TestTarget[] = (t) => t) {
  const keys = makeKeys();
  const targets = tweak(listed.map((p) => ({ path: p.name, content: p.content })));
  const repo = buildRepo({ root: { version: 1, keys }, targets });
  const server = await startTufServer(repo);
  const stateDir = mkdtempSync(path.join(tmpdir(), "fx-bundle-state-"));
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "fx-bundle-tmp-"));
  cleanups.push(async () => {
    await server.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  const build: TufBuildConfig = { root: repo.rootText, metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase };
  const tuf = new TufClient({ stateDir, build, ca: server.ca });
  return { tuf, server, tmpRoot, stateDir, requested: () => server.requests.filter((r) => r.includes("/targets/")) };
}

const all = (arch: string): Part[] => Object.values(parts(arch));
const refusal = async (p: Promise<unknown>): Promise<CliError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error("expected a refusal");
};

describe("the staged bundle", () => {
  it("stages the host's three binaries, kernel and root disk, privately, and builds the manifest from the verified digests", async () => {
    const amd = parts("amd64");
    const w = await world([...all("amd64"), ...all("arm64")]);
    const staged: StagedBundle = await stageBundle({ tuf: w.tuf, arch: "amd64", tmpRoot: w.tmpRoot });
    cleanups.push(() => staged.cleanup());
    expect(path.dirname(staged.dir)).toBe(w.tmpRoot);
    expect(lstatSync(staged.dir).mode & 0o777).toBe(0o700);
    expect(staged.binaries.vmhelper).toMatchObject({ sha256: sha(amd["vmhelper"]!.content), dest: LAYOUT.helperBinary });
    expect(staged.binaries.jailer.dest).toBe(LAYOUT.jailerBinary);
    expect(staged.binaries.firecracker.dest).toBe(LAYOUT.firecrackerBinary);
    for (const f of [...Object.values(staged.binaries), staged.templates["fx-agent"]!.kernel, staged.templates["fx-agent"]!.rootfs]) {
      expect(lstatSync(f.file).mode & 0o777).toBe(0o600);
      expect(sha(readFileSync(f.file))).toBe(f.sha256);
      expect(f.file.startsWith(staged.dir + path.sep)).toBe(true);
    }
    expect(staged.templates["fx-agent"]!.kernel.dest).toBe(`${LAYOUT.templateDir}/fx-agent/kernel`);
    const manifest = { "fx-agent": { kernel: sha(amd["kernel"]!.content), rootfs: sha(amd["rootfs"]!.content) } };
    expect(JSON.parse(staged.manifest.text)).toEqual(manifest);
    expect(JSON.parse(readFileSync(staged.manifest.file, "utf8"))).toEqual(manifest);
    expect(staged.manifest.dest).toBe(LAYOUT.templateManifest);
    // Only the host's architecture is downloaded.
    expect(w.requested().some((r) => r.includes("arm64"))).toBe(false);
    expect(w.requested()).toHaveLength(5);
    staged.cleanup();
    expect(existsSync(staged.dir)).toBe(false);
  });

  it("fails closed with 'not listed' for each binary and each template file that is missing, and downloads nothing", async () => {
    for (const missing of ["vmhelper", "jailer", "firecracker", "kernel", "rootfs"]) {
      const p = parts("amd64");
      const w = await world(Object.entries(p).filter(([k]) => k !== missing).map(([, v]) => v));
      const e = await refusal(stageBundle({ tuf: w.tuf, arch: "amd64", tmpRoot: w.tmpRoot }));
      expect(e.message).toMatch(/not listed/);
      expect(e.message).toContain(missing === "kernel" || missing === "rootfs" ? missing : `the ${missing}`);
      expect(e.exitCode).not.toBe(0);
      expect(w.requested()).toEqual([]);
      expect(readdirSync(w.tmpRoot)).toEqual([]);
    }
  });

  it("refuses when only the other architecture is listed (arch mismatch)", async () => {
    const w = await world(all("arm64"));
    const e = await refusal(stageBundle({ tuf: w.tuf, arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.message).toMatch(/not listed/);
    expect(w.requested()).toEqual([]);
    const ok = await stageBundle({ tuf: w.tuf, arch: "arm64", tmpRoot: w.tmpRoot });
    ok.cleanup();
  });

  it("refuses a listing that names two files for one slot", async () => {
    const w = await world([...all("amd64"), ...Object.values(parts("amd64", " other"))]);
    const e = await refusal(stageBundle({ tuf: w.tuf, arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.message).toMatch(/more than once/);
    expect(w.requested()).toEqual([]);
  });

  it("refuses a target whose signed length is wrong, removes the staging directory, and leaves no download", async () => {
    const w = await world(all("amd64"), (t) => t.map((x) => (x.path.startsWith("jailer-") ? { ...x, length: x.content.length + 3 } : x)));
    const e = await refusal(stageBundle({ tuf: w.tuf, arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.exitCode).not.toBe(0);
    expect(e.message).toMatch(/could not be downloaded and verified/);
    expect(readdirSync(w.tmpRoot)).toEqual([]);
  });

  it("refuses a target whose signed hash is not the file's, even when the name carries the file's own digest", async () => {
    const w = await world(all("amd64"), (t) => t.map((x) => (x.path.includes("/rootfs-") ? { ...x, hashes: { sha256: sha(Buffer.from("something else")) } } : x)));
    const e = await refusal(stageBundle({ tuf: w.tuf, arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.message).toMatch(/rootfs/);
    expect(readdirSync(w.tmpRoot)).toEqual([]);
  });

  it("refuses a file whose signed name and signed hash disagree (the name is not a promise the metadata keeps)", async () => {
    const p = parts("amd64");
    const lie = { ...p["firecracker"]!, name: `firecracker-amd64-${sha(Buffer.from("another file"))}` };
    const w = await world([p["vmhelper"]!, p["jailer"]!, lie, p["kernel"]!, p["rootfs"]!]);
    const e = await refusal(stageBundle({ tuf: w.tuf, arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.message).toMatch(/firecracker/);
    expect(readdirSync(w.tmpRoot)).toEqual([]);
  });

  it("refuses when the metadata cannot be verified, with a fixed message and no download", async () => {
    const w = await world(all("amd64"));
    const e = await refusal(stageBundle({ tuf: new TufClient({ stateDir: w.stateDir, build: { root: undefined, metadataBaseUrl: undefined, targetBaseUrl: undefined } }), arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.message).toMatch(/could not be verified \(not_configured\)/);
    expect(readdirSync(w.tmpRoot)).toEqual([]);
  });

  it("refuses a client that hands back a file that is not the signed one (a second look at the bytes)", async () => {
    const w = await world(all("amd64"));
    const bad = { listTargets: () => w.tuf.listTargets(), fetchTarget: async (p: string) => {
      const r = await w.tuf.fetchTarget(p);
      if (r.ok && p.startsWith("vmhelper-")) writeFileSync(r.file, Buffer.from("swapped after verification"));
      return r;
    } };
    const e = await refusal(stageBundle({ tuf: bad, arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.message).toMatch(/signed length and hash/);
    expect(readdirSync(w.tmpRoot)).toEqual([]);
  });

  it("refuses a client answer whose digest is not the one in the signed name", async () => {
    const w = await world(all("amd64"));
    const bad = { listTargets: () => w.tuf.listTargets(), fetchTarget: async (p: string) => {
      const r = await w.tuf.fetchTarget(p);
      return r.ok && p.startsWith("jailer-") ? { ...r, sha256: sha(Buffer.from("not this")) } : r;
    } };
    const e = await refusal(stageBundle({ tuf: bad, arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.message).toMatch(/digest in its signed name/);
    expect(readdirSync(w.tmpRoot)).toEqual([]);
  });

  it("refuses a same-length swap of the downloaded bytes (only the hash can catch it)", async () => {
    const w = await world(all("amd64"));
    const bad = { listTargets: () => w.tuf.listTargets(), fetchTarget: async (p: string) => {
      const r = await w.tuf.fetchTarget(p);
      if (r.ok && p.startsWith("vmhelper-")) {
        const b = readFileSync(r.file);
        b[0] = b[0]! ^ 0xff;
        writeFileSync(r.file, b);
        expect(b.length).toBe(r.length);
      }
      return r;
    } };
    const e = await refusal(stageBundle({ tuf: bad, arch: "amd64", tmpRoot: w.tmpRoot }));
    expect(e.message).toMatch(/signed length and hash/);
    expect(readdirSync(w.tmpRoot)).toEqual([]);
  });

  it("refuses a hard link or a regular file planted where a staged file goes, and leaves the outside file alone", async () => {
    for (const plant of ["hardlink", "regular"] as const) {
      const w = await world(all("amd64"));
      const outside = path.join(w.tmpRoot, "outside");
      writeFileSync(outside, "untouched");
      const bad = { listTargets: () => w.tuf.listTargets(), fetchTarget: async (p: string) => {
        if (p.startsWith("jailer-")) {
          for (const d of readdirSync(w.tmpRoot).filter((n) => n.startsWith("fx-vm-bundle-"))) {
            const at = path.join(w.tmpRoot, d, "jailer");
            if (plant === "hardlink") linkSync(outside, at);
            else writeFileSync(at, "planted");
          }
        }
        return w.tuf.fetchTarget(p);
      } };
      await expect(stageBundle({ tuf: bad, arch: "amd64", tmpRoot: w.tmpRoot })).rejects.toThrow(/EEXIST/);
      expect(readFileSync(outside, "utf8")).toBe("untouched");
      expect(readdirSync(w.tmpRoot).filter((n) => n.startsWith("fx-vm-bundle-"))).toEqual([]);
    }
  });

  it("never writes through a link planted where a staged file goes", async () => {
    const w = await world(all("amd64"));
    const outside = path.join(w.tmpRoot, "outside");
    writeFileSync(outside, "untouched");
    const bad = { listTargets: () => w.tuf.listTargets(), fetchTarget: async (p: string) => {
      if (p.startsWith("jailer-")) for (const d of readdirSync(w.tmpRoot).filter((n) => n.startsWith("fx-vm-bundle-"))) symlinkSync(outside, path.join(w.tmpRoot, d, "jailer"));
      return w.tuf.fetchTarget(p);
    } };
    await expect(stageBundle({ tuf: bad, arch: "amd64", tmpRoot: w.tmpRoot })).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(readdirSync(w.tmpRoot).filter((n) => n.startsWith("fx-vm-bundle-"))).toEqual([]);
  });

  it("refuses a downloaded file that is a symlink", async () => {
    const w = await world(all("amd64"));
    const link = path.join(w.tmpRoot, "elsewhere");
    writeFileSync(link, parts("amd64")["jailer"]!.content);
    const bad = { listTargets: () => w.tuf.listTargets(), fetchTarget: async (p: string) => {
      const r = await w.tuf.fetchTarget(p);
      if (r.ok && p.startsWith("jailer-")) {
        rmSync(r.file);
        symlinkSync(link, r.file);
      }
      return r;
    } };
    await expect(stageBundle({ tuf: bad, arch: "amd64", tmpRoot: w.tmpRoot })).rejects.toThrow();
    expect(readdirSync(w.tmpRoot).filter((n) => n.startsWith("fx-vm-bundle-"))).toEqual([]);
  });

  it("never reaches a privileged or process-running API", () => {
    const source = readFileSync(new URL("../../src/vm/bundle.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/child_process|sudo|execFile|spawn|\block\.json\b/);
  });
});

describe("selectTargets and hostArch", () => {
  it("picks by exact name and ignores another template or architecture", () => {
    const p = parts("amd64");
    const other = parts("arm64");
    const s = selectTargets([...Object.values(p), ...Object.values(other)].map((x) => x.name), "amd64");
    expect(s.binaries.vmhelper.sha256).toBe(sha(p["vmhelper"]!.content));
    expect(() => selectTargets(Object.values(p).map((x) => x.name), "amd64", ["fx-other"])).toThrow(/not listed/);
  });
  it("rejects template names that only look like the right one", () => {
    const p = parts("amd64");
    const others = ["vmhelper", "jailer", "firecracker"].map((n) => p[n]!.name);
    for (const kind of ["kernel", "rootfs"] as const) {
      const good = p[kind]!.name;
      const rest = (["kernel", "rootfs"] as const).filter((k) => k !== kind).map((k) => p[k]!.name);
      for (const bad of [`${good}.sig`, `${good}0`, `x${good}`, good.replace(`${TAG}/`, `${TAG}/x/`), good.replace("vm-fx-agent-", "vm-fx-agent-more-")]) {
        expect(() => selectTargets([...others, ...rest, bad], "amd64"), bad).toThrow(new RegExp(`the ${kind} of template fx-agent.*not listed`));
      }
    }
  });
  it("rejects a name that only looks like the right one", () => {
    const content = bytes("x");
    const h = sha(content);
    for (const bad of [`vmhelper-amd64-${h}.sig`, `x/vmhelper-amd64-${h}`, `vmhelper-amd64-${h.toUpperCase()}`, `vmhelper-amd64-${h.slice(1)}`]) {
      expect(() => selectTargets([bad, ...Object.values(parts("amd64")).slice(1).map((x) => x.name)], "amd64")).toThrow(/vmhelper.*not listed/);
    }
  });
  it("refuses a template name that is not plain, before any listing is searched", () => {
    for (const bad of ["../x", "Fx", "a.b", "a/b", ""]) expect(() => selectTargets(["x"], "amd64", [bad])).toThrow(/plain lower-case/);
  });
  it("maps the host architecture and refuses others", () => {
    expect(hostArch("x64")).toBe("amd64");
    expect(hostArch("arm64")).toBe("arm64");
    expect(() => hostArch("ia32")).toThrow(CliError);
  });
});
