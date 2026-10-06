import lock from "../../../infra/sandbox-image/versions.lock.json" with { type: "json" };

/**
 * What the runner boots a sandbox from, and the Claude CLI version that image carries.
 *
 * Both come from ONE record, `infra/sandbox-image/versions.lock.json`: the lockfile that also feeds the image build
 * (scripts/ops/publish-sandbox-image.sh). Its `image` block holds the published registry digest; its
 * `artifacts.claude.version` is the CLI version baked into that image. The runner compiles the file in (a JSON
 * import), so nothing reads a path at run time and the built output can be moved anywhere.
 *
 * There is no fallback. A sandbox created from the managed runtime has no agent CLI on its PATH, so an unset or
 * malformed image is refused up front with `SandboxImageConfigError` rather than quietly booting the wrong thing.
 */

/** A project-scoped Vercel Container Registry reference pinned by digest: `repo@sha256:<64 hex>`. No tag, no URL. */
const IMAGE_REF_RE = /^[a-z0-9][a-z0-9._-]{0,127}@sha256:[0-9a-f]{64}$/;
const CLI_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** The sandbox image setting is missing or not a digest-pinned reference. A configuration error, never retried. */
export class SandboxImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxImageConfigError";
  }
}

/** Returns `ref` when it is a digest-pinned image reference; throws `SandboxImageConfigError` otherwise (it does not echo the value). */
export function resolveSandboxImage(ref: unknown): string {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new SandboxImageConfigError("sandbox image is not set: publish the image and record its digest in infra/sandbox-image/versions.lock.json");
  }
  if (!IMAGE_REF_RE.test(ref)) {
    throw new SandboxImageConfigError("sandbox image must be pinned by digest as <repository>@sha256:<64 hex>");
  }
  return ref;
}

/** The pinned image reference from the lockfile; empty when the lockfile records no digest (`resolveSandboxImage` then refuses it). */
export const SANDBOX_IMAGE_REF: string = lock.image.digest === "" ? "" : `${lock.image.repository}@${lock.image.digest}`;

/** The one Claude Code CLI version the runner accepts: the version the lockfile pins into the image. */
export const CLAUDE_CLI_VERSION: string = lock.artifacts.claude.version;
if (!CLI_VERSION_RE.test(CLAUDE_CLI_VERSION)) throw new Error("versions.lock.json: artifacts.claude.version is not a plain version");

const SHA256_RE = /^[0-9a-f]{64}$/;

/** The SHA-256 of the Claude Code binary the lockfile pins into the image (checked against the binary at every start and resume). */
export const CLAUDE_CLI_SHA256: string = lock.artifacts.claude.sha256;
if (!SHA256_RE.test(CLAUDE_CLI_SHA256)) throw new Error("versions.lock.json: artifacts.claude.sha256 is not a lower-case sha256");
