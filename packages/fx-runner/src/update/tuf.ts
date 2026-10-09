/**
 * The TUF client for runner updates (D#6 R6-2a, correction C38 section 2).
 *
 * Every check of the metadata is `tuf-js`'s, an implementation of the TUF client workflow: root rotation (each new root must be signed by
 * a threshold of the previous root's keys and of its own, and its version must be exactly one more), signature thresholds per role,
 * expiry of every role, a version that never goes back (timestamp, snapshot, targets, and each file listed in the snapshot), the
 * snapshot's hashes and versions as the timestamp names them, a limit on how much any metadata file may be, and the target's length and
 * hashes. This file chooses what is trusted and where it is fetched from, and turns every failure into a refusal. It writes no
 * cryptography of its own.
 *
 * Fail closed: `fetchTarget` never throws and never returns a file unless `tuf-js` verified it and this file checked length and
 * SHA-256 again. Any other outcome is a refusal that names its class, and a failed download leaves no file behind. It stages nothing:
 * a verified file is only handed back, in a private directory under the state directory, for the caller to install.
 *
 * Built-in trust, nothing else: the first root, the metadata location and the target location come from the build constants in buildConfig.ts. Without a root
 * the updater is "not configured in this build": it makes no network call and writes nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Updater, type Fetcher } from "tuf-js";
import { BadVersionError, DownloadError, DownloadLengthMismatchError, ExpiredMetadataError, RepositoryError, RuntimeError, ValueError } from "tuf-js/dist/error.js";
import { ensurePrivateDir } from "../watch/layout.js";
import { TUF_BUILD, type TufBuildConfig } from "./buildConfig.js";
import { FetchRefusal, PinnedFetcher } from "./pinnedFetcher.js";

export const NOT_CONFIGURED_TEXT = "updates are not configured in this build";

/** What a refusal was about. Anything not named here is `verification_failed`. */
export type TufRefusalCode =
  | "metadata_expired"
  | "rollback"
  | "bad_signature"
  | "invalid_metadata"
  | "target_not_found"
  | "target_mismatch"
  | "redirect_refused"
  | "url_not_allowed"
  | "download_failed"
  | "bad_target_path"
  | "verification_failed";

export type TufOutcome =
  | { ok: true; file: string; remotePath: string; length: number; sha256: string }
  /** No root in this build: nothing was read, fetched or written. */
  | { ok: false; state: "not_configured"; message: string }
  /** Updates are off until the release metadata is renewed. Jobs are never affected. `expiredOn` is `YYYY-MM-DD`, when known. */
  | { ok: false; state: "paused"; code: "metadata_expired"; expiredOn: string | undefined; message: string }
  | { ok: false; state: "refused"; code: Exclude<TufRefusalCode, "metadata_expired">; message: string };

export interface TufClientOptions {
  stateDir: string;
  /** What the build trusts. Only tests pass anything but the default. */
  build?: TufBuildConfig | undefined;
  /** A replacement transport. Only tests pass one. */
  fetcher?: Fetcher | undefined;
  /** Extra TLS trust anchor for a local test server. Production never sets it. */
  ca?: string | Buffer | undefined;
}

/** The largest release file this client will download (the metadata's own length is checked as well). */
export const MAX_TARGET_BYTES = 512 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A target path is relative, plain and short: no dot segments, no encoded characters, no query or fragment. */
const TARGET_PATH = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/;

export function tufDir(stateDir: string): string {
  return path.join(stateDir, "tuf");
}

/** True when this build carries a root and both locations. Everything else about the updater follows from it. */
export function tufConfigured(build: TufBuildConfig = TUF_BUILD): boolean {
  return build.root !== undefined && build.metadataBaseUrl !== undefined && build.targetBaseUrl !== undefined;
}

function rootVersion(text: string): number | undefined {
  try {
    const version = (JSON.parse(text) as { signed?: { version?: unknown } }).signed?.version;
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 1 ? version : undefined;
  } catch {
    // fx-swallow-ok: text that is not a root has no version; the caller replaces it with the build's root
    return undefined;
  }
}

/**
 * Put the build's root in `<stateDir>/tuf/root.json` when there is none, when the one there cannot be read, or when the build's is a
 * newer version. A cached root newer than the build's (it came from a verified rotation) is kept.
 */
function seedRoot(dir: string, buildRoot: string): void {
  ensurePrivateDir(dir);
  const file = path.join(dir, "root.json");
  const cachedVersion = existsSync(file) ? rootVersion(readFileSync(file, "utf8")) : undefined;
  const builtVersion = rootVersion(buildRoot);
  if (builtVersion === undefined) throw new Error("the build's root is not a root");
  if (cachedVersion !== undefined && cachedVersion >= builtVersion) return;
  const staging = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(staging, buildRoot, { mode: 0o600 });
  renameSync(staging, file);
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function dateOf(bytes: Buffer | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  try {
    const expires = (JSON.parse(bytes.toString("utf8")) as { signed?: { expires?: unknown } }).signed?.expires;
    const parsed = typeof expires === "string" ? new Date(expires) : undefined;
    return parsed !== undefined && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : undefined;
  } catch {
    // fx-swallow-ok: metadata that cannot be read has no date; the pause message then carries none
    return undefined;
  }
}

export class TufClient {
  private readonly build: TufBuildConfig;
  private readonly stateDir: string;
  private readonly fetcher: Fetcher | undefined;
  private readonly ca: string | Buffer | undefined;

  constructor(options: TufClientOptions) {
    this.build = options.build ?? TUF_BUILD;
    this.stateDir = options.stateDir;
    this.fetcher = options.fetcher;
    this.ca = options.ca;
  }

  get configured(): boolean {
    return tufConfigured(this.build);
  }

  /**
   * Refresh the metadata and download one release file, verified. `targetPath` is the path the targets metadata lists, for example
   * `v1.2.3/fx-runner-linux-x64`.
   */
  async fetchTarget(targetPath: string): Promise<TufOutcome> {
    const { root, metadataBaseUrl, targetBaseUrl } = this.build;
    if (root === undefined || metadataBaseUrl === undefined || targetBaseUrl === undefined) return { ok: false, state: "not_configured", message: NOT_CONFIGURED_TEXT };
    if (!TARGET_PATH.test(targetPath) || targetPath.length > 200 || targetPath.split("/").some((segment) => segment.startsWith(".") || segment.includes(".."))) {
      return { ok: false, state: "refused", code: "bad_target_path", message: "the release file name is not a plain relative path" };
    }

    const dir = tufDir(this.stateDir);
    let pinned: PinnedFetcher | undefined;
    let destination: string | undefined;
    try {
      const opened = this.open(root, metadataBaseUrl, targetBaseUrl, dir);
      pinned = opened.pinned;
      const { updater, targets } = opened;
      await updater.refresh();
      const info = await updater.getTargetInfo(targetPath);
      if (info === undefined) return { ok: false, state: "refused", code: "target_not_found", message: "the release metadata does not list that file" };
      const expectedSha = info.hashes["sha256"];
      if (expectedSha === undefined || !SHA256_HEX.test(expectedSha) || !Number.isSafeInteger(info.length) || info.length < 0 || info.length > MAX_TARGET_BYTES) {
        return { ok: false, state: "refused", code: "invalid_metadata", message: "the release metadata does not describe that file with a SHA-256 and a sensible length" };
      }
      // A file left by an earlier download is never mistaken for this one.
      destination = path.join(targets, encodeURIComponent(info.path));
      rmSync(destination, { force: true });
      await updater.downloadTarget(info, destination, targetBaseUrl);
      // tuf-js verified the file before it wrote it; look again, so a fault there still cannot hand back a wrong file.
      if (statSync(destination).size !== info.length || sha256File(destination) !== expectedSha) {
        rmSync(destination, { force: true });
        return { ok: false, state: "refused", code: "target_mismatch", message: "the downloaded file does not match the signed length and hash" };
      }
      chmodSync(destination, 0o600);
      return { ok: true, file: destination, remotePath: info.path, length: info.length, sha256: expectedSha };
    } catch (error) {
      // fx-swallow-ok: fail closed; every failure becomes a typed refusal below, and the raw text is classified, never shown
      if (destination !== undefined) rmSync(destination, { force: true });
      return this.refusal(error, pinned, dir);
    }
  }

  /** The updater over the state directory's `tuf` folder. Called inside the callers' try: a base address that is not plain https is a refusal like any other. */
  private open(root: string, metadataBaseUrl: string, targetBaseUrl: string, dir: string): { updater: Updater; pinned: PinnedFetcher | undefined; targets: string } {
    const targets = path.join(dir, "targets");
    const pinned = this.fetcher === undefined ? new PinnedFetcher({ allowedBases: [metadataBaseUrl, targetBaseUrl], ca: this.ca }) : undefined;
    const fetcher = this.fetcher ?? pinned;
    seedRoot(dir, root);
    ensurePrivateDir(targets);
    const updater = new Updater({
      metadataDir: dir,
      metadataBaseUrl,
      targetDir: targets,
      targetBaseUrl,
      ...(fetcher === undefined ? {} : { fetcher }),
      config: { prefixTargetsWithHash: false, userAgent: "fx-runner" },
    });
    return { updater, pinned, targets };
  }

  /**
   * The paths the verified top-level targets metadata lists (D#6 R6-2b: how the updater learns which versions exist). The metadata is
   * verified exactly as for `fetchTarget` and nothing is downloaded. The list is read from the client's trusted set, which
   * `getTargetInfo` fills only after every check passed (tuf-js is an exact version in the lockfile for that reason).
   */
  async listTargets(): Promise<{ ok: true; paths: string[] } | Exclude<TufOutcome, { ok: true }>> {
    const { root, metadataBaseUrl, targetBaseUrl } = this.build;
    if (root === undefined || metadataBaseUrl === undefined || targetBaseUrl === undefined) return { ok: false, state: "not_configured", message: NOT_CONFIGURED_TEXT };
    const dir = tufDir(this.stateDir);
    let pinned: PinnedFetcher | undefined;
    try {
      const opened = this.open(root, metadataBaseUrl, targetBaseUrl, dir);
      pinned = opened.pinned;
      await opened.updater.refresh();
      await opened.updater.getTargetInfo("v0.0.0/none");
      const trusted = (opened.updater as unknown as { trustedSet?: { targets?: { signed?: { targets?: Record<string, unknown> } } } }).trustedSet;
      const listed = trusted?.targets?.signed?.targets;
      if (listed === undefined || typeof listed !== "object") return { ok: false, state: "refused", code: "invalid_metadata", message: "release metadata could not be verified; nothing was installed" };
      return { ok: true, paths: Object.keys(listed) };
    } catch (error) {
      // fx-swallow-ok: fail closed; every failure becomes a typed refusal
      return this.refusal(error, pinned, dir) as Exclude<TufOutcome, { ok: true }>;
    }
  }

  /** Every failure ends here. The text names the class of failure and never carries an address or server text. */
  private refusal(error: unknown, pinned: PinnedFetcher | undefined, dir: string): TufOutcome {
    const refusal = pinned?.lastRefusal ?? (error instanceof FetchRefusal ? error : undefined);
    if (refusal !== undefined) {
      const messages = {
        redirect_refused: "a download redirected somewhere it must not (not https, or too many hops); nothing was installed",
        url_not_allowed: "a download address is outside the configured update locations; nothing was installed",
        download_failed: "a download failed; nothing was installed",
      } as const;
      return { ok: false, state: "refused", code: refusal.code, message: messages[refusal.code] };
    }
    const text = error instanceof Error ? error.message : String(error);
    // tuf-js wraps some failures into a plain error that keeps only the inner message, so the text is read as well as the class.
    const expired = text.match(/(root|timestamp|snapshot|targets)\.json is expired/);
    if (error instanceof ExpiredMetadataError || expired !== null) {
      const role = (expired?.[1] ?? "timestamp") as "root" | "timestamp" | "snapshot" | "targets";
      const bytes = role === "root" ? readCached(dir) : pinned?.metadataBytes.get(role);
      const expiredOn = dateOf(bytes);
      const message = expiredOn === undefined ? "updates paused: release metadata expired" : `updates paused: release metadata expired on ${expiredOn}`;
      return { ok: false, state: "paused", code: "metadata_expired", expiredOn, message };
    }
    if (error instanceof BadVersionError || /is less than|less than current|Expected version|does not match snapshot version|doesn't match timestamp/.test(text)) {
      return { ok: false, state: "refused", code: "rollback", message: "the release metadata went back to an older version; nothing was installed" };
    }
    if (/signed by \d+\/\d+ keys|failed to verify .* signature|no signature for key|no public key|Unsupported key type/.test(text)) {
      return { ok: false, state: "refused", code: "bad_signature", message: "release metadata did not carry enough valid signatures; nothing was installed" };
    }
    if (error instanceof DownloadLengthMismatchError || /Expected length|Expected hash|Hash algorithm/.test(text)) {
      return { ok: false, state: "refused", code: "target_mismatch", message: "a release file or metadata file did not match its signed length or hash; nothing was installed" };
    }
    if (error instanceof DownloadError || /Failed to download|fetch failed/.test(text)) {
      return { ok: false, state: "refused", code: "download_failed", message: "a download failed; nothing was installed" };
    }
    if (error instanceof RepositoryError || error instanceof TypeError || error instanceof SyntaxError || error instanceof ValueError || error instanceof RuntimeError) {
      return { ok: false, state: "refused", code: "invalid_metadata", message: "release metadata could not be verified; nothing was installed" };
    }
    return { ok: false, state: "refused", code: "verification_failed", message: "the update could not be verified; nothing was installed" };
  }
}

function readCached(dir: string): Buffer | undefined {
  try {
    return readFileSync(path.join(dir, "root.json"));
  } catch {
    // fx-swallow-ok: no readable cached root means no date to report
    return undefined;
  }
}

/** The doctor line for the updater: whether this build can update at all. */
export function updaterDoctorLine(build: TufBuildConfig = TUF_BUILD): { level: "PASS" | "INFO"; detail: string } {
  return tufConfigured(build)
    ? { level: "PASS", detail: "release metadata is trusted from a root in this build" }
    : { level: "INFO", detail: `${NOT_CONFIGURED_TEXT}; the runner does not update itself` };
}
