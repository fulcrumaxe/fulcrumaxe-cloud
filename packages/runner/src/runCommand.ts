import { PLANE_PUBLISH_ROLE } from "./sandboxNaming.js";
import { PLANE_PUBLISH_VCPUS, SANDBOX_VCPUS, type CreateSandboxOptions, type RunCommandOptions, type SandboxFile } from "./sandboxPort.js";

/**
 * D#598 P1f-5a: the argument checks of `SandboxPort.runCommand`, shared by the real port and the fake so neither is more lenient. Nothing here is
 * a shell: the program is named from a short list and run with an argv, and every file goes through the provider's file API.
 */
export const RUN_COMMAND_PROGRAMS: readonly string[] = Object.freeze(["node"]);
export const RUN_COMMAND_FILE_DIR = "/fx/plane-publish/";
export const RUN_COMMAND_MAX_TIMEOUT_MS = 15 * 60_000;
export const RUN_COMMAND_MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_FILES_CHARS = 8 * 1024 * 1024;
const MAX_ARG_CHARS = 4096;
const FILE_RE = /^\/fx\/plane-publish\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Thrown when an agent launch (start or resume) is asked of a publish sandbox or for the publish role. The message names no value. */
export class PublishSandboxAgentRefused extends Error {
  constructor() {
    super("a publish sandbox never launches an agent");
    this.name = "PublishSandboxAgentRefused";
  }
}

/** Refuses an agent launch on any `pp-` handle (whatever the role) and for the `plane_publish` role (whatever the handle). */
export function assertNoAgentInPublishSandbox(sandboxName: string, role: string): void {
  if (sandboxName.startsWith("pp-") || role === PLANE_PUBLISH_ROLE) throw new PublishSandboxAgentRefused();
}

/**
 * The vCPUs a sandbox is created with. A `pp-` publish sandbox is exactly `PLANE_PUBLISH_VCPUS` and never persistent; any other sandbox is
 * `SANDBOX_VCPUS`, and asking it for the publish figure is refused, so the number cannot drift onto an agent sandbox.
 */
export function vcpusForCreate(opts: Pick<CreateSandboxOptions, "sandboxName" | "vcpus" | "retention">): number {
  if (opts.sandboxName.startsWith("pp-")) {
    if (opts.vcpus !== PLANE_PUBLISH_VCPUS || opts.retention.persistent) throw new Error("createSandbox: a pp- sandbox is created with 1 vCPU and is not persistent");
    return PLANE_PUBLISH_VCPUS;
  }
  if (opts.vcpus !== undefined && opts.vcpus !== SANDBOX_VCPUS) throw new Error("createSandbox: only a pp- sandbox may set its vCPUs");
  return SANDBOX_VCPUS;
}

/** Throws a plain Error naming the rule, never a value. The env is checked by the caller (`assertSandboxEnvMatchesRole`). */
export function assertRunCommandOptions(opts: RunCommandOptions): void {
  const bad = (rule: string): never => {
    throw new Error(`runCommand: ${rule}`);
  };
  if (opts.role !== PLANE_PUBLISH_ROLE) bad("only the plane_publish role may run a command without an agent");
  if (!RUN_COMMAND_PROGRAMS.includes(opts.cmd)) bad("the program is not on the list");
  // An argument is one literal element of an argv list, so `;`, `$(...)` and a newline are ordinary characters; only a NUL (which cannot be in an argv) is refused.
  if (opts.args.length > 8 || !opts.args.every((a) => typeof a === "string" && a.length >= 1 && a.length <= MAX_ARG_CHARS && !a.includes("\0"))) bad("an argument has an unexpected shape");
  // No model rule, no registry, no other host: the one GitHub proxy rule.
  if (opts.networkPolicy.length !== 1 || opts.networkPolicy[0]?.purpose !== "github_proxy") bad("the network policy must be the GitHub proxy rule alone");
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > RUN_COMMAND_MAX_TIMEOUT_MS) bad("timeoutMs is out of range");
}

/** The checks of `SandboxPort.writeFiles`: a `pp-` sandbox only, paths directly under the publish directory, modes up to 0755, a size cap. */
export function assertWriteFiles(sandboxName: string, files: readonly SandboxFile[]): void {
  const bad = (rule: string): never => {
    throw new Error(`writeFiles: ${rule}`);
  };
  if (!sandboxName.startsWith("pp-")) bad("files are written only into a pp- sandbox");
  let size = 0;
  for (const f of files) {
    if (!FILE_RE.test(f.path)) bad("a file path is outside the publish directory");
    if (f.mode !== undefined && (!Number.isInteger(f.mode) || f.mode < 0 || f.mode > 0o755)) bad("a file mode is out of range");
    size += f.content.length;
  }
  if (size > MAX_FILES_CHARS) bad("the files are too large");
}
