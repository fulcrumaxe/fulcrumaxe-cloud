import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vmManifest } from "../../../scripts/vm-manifest.mjs";
import { main as keygen } from "../../../scripts/tuf-keygen.mjs";
import { main as tool } from "../../../scripts/tuf-release.mjs";
import type { TufBuildConfig } from "../../../src/update/buildConfig.js";
import { TufClient } from "../../../src/update/tuf.js";
import type { BootDigests } from "../../../src/vm/bootGate.js";
import { startTufServer } from "../../fixtures/tufServer.js";

/**
 * A signed test release of one microVM image, made by the real tools (`scripts/vm-manifest.mjs`, then `scripts/tuf-release.mjs` with throwaway
 * keys) and served over TLS to the runner's real TUF client. The root is a test root made here: the production root is never touched, and nothing
 * here can be switched on in a real build. Used by the boot facts tests and by the real-VM engine suite, which signs the disks a dispatched run built.
 */
export interface SignedRelease {
  tag: string;
  client: TufClient;
  /** The digest of each file of the release, by architecture. */
  digests(arch: "amd64" | "arm64"): BootDigests;
  /** Withdraws the release (`tuf-release.mjs release --drop <tag>`): the next listing no longer has it. */
  drop(): void;
  /** Removes everything the release made. */
  close(): Promise<void>;
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export async function signRelease(input: { template?: string; files: ReadonlyArray<{ kind: "kernel" | "rootfs" | "agent"; arch: "amd64" | "arm64"; file: string }>; now?: Date }): Promise<SignedRelease> {
  const work = mkdtempSync(path.join(tmpdir(), "fx-vm-release-"));
  const keyFiles: Record<string, string> = {};
  const pub: Record<string, string> = {};
  for (const name of ["root", "targets", "online"]) {
    let out = "";
    if (keygen(["--out", path.join(work, `${name}.pem`)], { out: (s: string) => (out += s), err: () => undefined }) !== 0) throw new Error("key generation failed");
    keyFiles[name] = path.join(work, `${name}.pem`);
    pub[name] = path.join(work, `${name}.pub.json`);
    writeFileSync(pub[name]!, out);
  }
  const meta = path.join(work, "meta");
  const trusted = path.join(work, "trusted.json");
  const run = (argv: string[]): void => {
    let err = "";
    const code = tool(argv, { environment: {}, out: () => undefined, err: (s: string) => (err += s), ...(input.now === undefined ? {} : { now: input.now }) });
    if (code !== 0) throw new Error(`tuf-release failed: ${err.slice(0, 200)}`);
  };
  run(["init-root", "--dir", meta, "--root-key", keyFiles["root"]!, "--targets-pubkey", pub["targets"]!, "--online-pubkey", pub["online"]!]);
  copyFileSync(path.join(meta, "1.root.json"), trusted);
  const out = path.join(work, "release");
  const { tag, manifest } = vmManifest({ template: input.template ?? "fx-agent", files: [...input.files], outDir: out });
  run(["release", "--dir", meta, "--trusted-root", trusted, "--manifest", path.join(out, "vm-manifest.json"), "--targets-key", keyFiles["targets"]!, "--online-key", keyFiles["online"]!]);

  const server = await startTufServer({ rootText: "", metadata: new Map(), files: new Map(), keys: undefined as never });
  const publish = (): void => {
    for (const name of readdirSync(meta)) if (name.endsWith(".json")) server.metadata.set(name, readFileSync(path.join(meta, name)));
  };
  publish();
  for (const entry of manifest) server.files.set(entry.target, readFileSync(path.join(out, entry.target)));
  const stateDir = mkdtempSync(path.join(tmpdir(), "fx-vm-release-state-"));
  const build: TufBuildConfig = { root: readFileSync(path.join(meta, "1.root.json"), "utf8"), metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase };
  const sums = new Map(input.files.map((f) => [`${f.kind}:${f.arch}`, sha(readFileSync(f.file))]));
  return {
    tag,
    client: new TufClient({ stateDir, build, ca: server.ca }),
    digests: (arch) => ({ kernel: sums.get(`kernel:${arch}`)!, rootfs: sums.get(`rootfs:${arch}`)!, agent: sums.get(`agent:${arch}`)! }),
    drop: () => {
      run(["release", "--dir", meta, "--trusted-root", trusted, "--artifacts", out, "--drop", tag, "--targets-key", keyFiles["targets"]!, "--online-key", keyFiles["online"]!]);
      publish();
    },
    close: async () => {
      await server.close();
      rmSync(work, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
