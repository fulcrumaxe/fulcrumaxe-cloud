import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Metadata, MetadataKind, Signature } from "@tufjs/models";
import { ARTIFACT_NAMES } from "../../scripts/install-render.mjs";
import { generateKeyPair, initRoot, release } from "../../scripts/tuf-lib.mjs";
import type { TufBuildConfig } from "../../src/update/buildConfig.js";
import { startTufServer, type TufServer } from "../fixtures/tufServer.js";

/**
 * A fixture runner release, made by the real release tools (`scripts/tuf-lib.mjs`: `initRoot`, then `release` once per version) with throwaway
 * keys made here, and served over local TLS under the consistent-snapshot names the production release host uses. The root is a fixture root:
 * the production root is never touched and nothing here can be switched on in a real build. Each runner file is a tiny shell script that
 * answers `--version` and `doctor --sandbox-only`; the install script's own download, length and SHA-256 checks run on it as on a real binary.
 */
export const PLATFORMS: readonly string[] = Object.keys(ARTIFACT_NAMES);

export const targetPath = (version: string, platform: string): string => `v${version}/${ARTIFACT_NAMES[platform as keyof typeof ARTIFACT_NAMES]}`;

/** The bytes of the fixture runner for one version and platform. They differ by version and platform, so a wrong file is never mistaken for the right one. */
export function stubRunner(version: string, platform: string): Buffer {
  return Buffer.from(`#!/bin/sh\n# fixture runner ${version} ${platform}\ncase "$1" in\n  --version) echo "fx-runner ${version} (fixture)"; exit 0 ;;\n  doctor) exit 0 ;;\nesac\nexit 64\n`);
}

export interface PublishOptions {
  /** Only these platforms get a file in this release (default: all four). A version that lacks one is never served by the route. */
  platforms?: readonly string[];
  /** The clock of the signing run. Metadata signed far enough in the past is expired now. */
  now?: Date;
  /** Metadata lifetimes in days. */
  days?: { targets?: number; snapshot?: number; timestamp?: number };
}

export interface InstallReleaseWorld {
  server: TufServer;
  /** The root text and the two base addresses a build would carry. */
  build: TufBuildConfig;
  /** The trust anchor for the metadata and target server (PEM). */
  ca: string;
  /** Signs and serves one more version, keeping the earlier ones. */
  publish(version: string, options?: PublishOptions): void;
  /** A copy of everything the metadata side serves now, and putting such a copy back (to serve older metadata than was served before). */
  snapshotMetadata(): Map<string, Buffer>;
  restoreMetadata(copy: Map<string, Buffer>): void;
  /** Replaces the newest targets file by one signed by a key the root does not list. */
  resignTargetsWithStranger(): void;
  /** Serves other bytes under a target path (the signed metadata is untouched). */
  replaceFile(target: string, bytes: Buffer): void;
  close(): Promise<void>;
}

export async function startInstallRelease(): Promise<InstallReleaseWorld> {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-install-release-"));
  const meta = path.join(dir, "meta");
  const keys = { root: generateKeyPair(), targets: generateKeyPair(), online: generateKeyPair() };
  initRoot({ dir: meta, rootSigner: keys.root, targetsPublic: keys.targets.publicHex, onlinePublic: keys.online.publicHex });
  const rootBytes = readFileSync(path.join(meta, "1.root.json"));
  const server = await startTufServer({ rootText: "", metadata: new Map(), files: new Map(), keys: undefined as never });
  const sync = (): void => {
    for (const name of readdirSync(meta)) if (name.endsWith(".json")) server.metadata.set(name, readFileSync(path.join(meta, name)));
  };
  sync();
  const build: TufBuildConfig = { root: rootBytes.toString("utf8"), metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase };
  return {
    server,
    build,
    ca: server.ca,
    publish(version, options = {}) {
      const manifest = (options.platforms ?? PLATFORMS).map((platform) => {
        const bytes = stubRunner(version, platform);
        server.files.set(targetPath(version, platform), bytes);
        return { version, platform, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
      });
      release({ dir: meta, trustedRoot: rootBytes, manifest, targetsSigners: keys.targets, onlineSigners: keys.online, ...(options.days === undefined ? {} : { days: options.days }), ...(options.now === undefined ? {} : { now: options.now }) });
      sync();
    },
    snapshotMetadata: () => new Map(server.metadata),
    restoreMetadata(copy) {
      server.metadata.clear();
      for (const [name, bytes] of copy) server.metadata.set(name, bytes);
    },
    resignTargetsWithStranger() {
      const newest = [...server.metadata.keys()].filter((n) => n.endsWith(".targets.json")).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).at(-1);
      if (newest === undefined) throw new Error("test bug: nothing published yet");
      const signed = Metadata.fromJSON(MetadataKind.Targets, JSON.parse((server.metadata.get(newest) as Buffer).toString("utf8")));
      signed.signatures = {};
      const stranger = generateKeyPair();
      signed.sign((data: Buffer) => new Signature({ keyID: stranger.keyID, sig: stranger.sign(data) }));
      server.metadata.set(newest, Buffer.from(JSON.stringify(signed.toJSON())));
    },
    replaceFile: (target, bytes) => void server.files.set(target, bytes),
    close: async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A scratch directory that holds the stub programs a container may see (the stand-in for a signed-in Claude Code, never the real one). */
export function stubsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-install-stubs-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "claude"), '#!/bin/sh\necho "2.1.295 (Claude Code)"\n', { mode: 0o755 });
  return dir;
}
