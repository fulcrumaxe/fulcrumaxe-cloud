/**
 * The job files of one guest run (D#587 B-5a-RT-3): the settings file and the MCP file the host engine writes to its own jobs directory
 * (`writeJobFiles`), built here from the same builders (`settingsFor`, `mcpConfigFor`) and the same role tool list, but as bytes for one guest
 * `writeFiles`, 0600, under `<jobsDir>/<runId>/`. The sandbox block is the guest's own (`guestSandboxSettings`) and is checked with the engine's own
 * `assertEnabledSandbox` before anything is built, so a block that is off, or leaves a way out, refuses the start before the guest is touched.
 * Nothing of the host (its home, state directory or binary directory) is an input here, so none can be in a file.
 */
import { SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { assertEnabledSandbox } from "../../sandbox/sandboxSettings.js";
import { EngineRefusal } from "../../engines/claude/refusal.js";
import { jobDirFor } from "../../engines/claude/engine.js";
import { mcpConfigFor, settingsFor } from "../../engines/claude/settingsFile.js";
import { guestProtectedPaths, guestSandboxSettings, type GuestLayout } from "../guestSandboxSettings.js";

export interface GuestJobFiles {
  settingsPath: string;
  mcpPath: string;
  /** The files, in the shape the sandbox's `writeFiles` takes. */
  files: Array<{ path: string; content: string; mode: number }>;
  /** The run's temp directory: the sandbox block's writable scratch place. */
  tempDir: string;
}

export interface GuestJobFilesInput {
  jobsDir: string;
  runId: string;
  role: string;
  workdir: string;
  excludes?: readonly string[] | undefined;
  checkArgv?: readonly string[] | undefined;
  /** Test seam: the sandbox block builder. Every real run uses `guestSandboxSettings`. */
  sandbox?: (layout: GuestLayout) => Record<string, unknown>;
}

export function guestJobFiles(input: GuestJobFilesInput): GuestJobFiles {
  const dir = jobDirFor(input.jobsDir, input.runId);
  // D#845 ON-10c: the project survey's one writable path is /tmp/fx-survey/<run_id>/ (made 0700 and set as TMPDIR by the runtime), and its working copy is read-only.
  const survey = input.role === SURVEY_ROLE;
  const layout: GuestLayout = { workdir: input.workdir, tempDir: survey ? `/tmp/fx-survey/${input.runId}` : `/tmp/fx-${input.runId}`, jobsDir: input.jobsDir, ...(survey ? { readOnlyWorkdir: true } : {}) };
  const sandbox = (input.sandbox ?? guestSandboxSettings)(layout);
  try {
    assertEnabledSandbox(sandbox);
  } catch {
    // fx-swallow-ok: the closed refusal below is the report
    throw new EngineRefusal("bad_start_options", "sandbox block is not enabled");
  }
  const settings = settingsFor(input.role, sandbox, input.workdir, guestProtectedPaths(layout), input.excludes ?? [], undefined, input.checkArgv, undefined);
  const settingsPath = `${dir}/settings.json`;
  const mcpPath = `${dir}/mcp.json`;
  return {
    settingsPath,
    mcpPath,
    tempDir: layout.tempDir,
    files: [
      { path: settingsPath, content: `${JSON.stringify(settings, null, 2)}\n`, mode: 0o600 },
      { path: mcpPath, content: `${JSON.stringify(mcpConfigFor({ role: input.role }), null, 2)}\n`, mode: 0o600 },
    ],
  };
}
