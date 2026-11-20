/**
 * Where a job's working copy crosses into a microVM (D#587 B-5b). The microVM port builds an agent runtime for each start from the guest's command slice
 * (`makeRuntime`); this wraps that one function, so the port itself decides nothing about a working copy.
 *
 *  - Before the agent starts, the repository is built on the host (`source.archive`, from the runner's own mirror, for the commit the host workspace is at)
 *    and sent into the guest (`sendWorkspace`). The agent is then started in the guest's own work directory.
 *  - The host's workspace path never goes further than this wrapper: the runtime the inner function builds, and the options it starts with, name the
 *    guest's directory. (Any other field that carries a host path is the caller's to keep out; the port refuses the ones it knows of.)
 *  - A start that RESUMES a session needs the guest's own copy to be still there. This part is B-5b's persistence (`reopenWorkspace`); a wrapper built
 *    without it refuses a resume with `workspace_missing`, so a session is never continued over a copy that was not checked.
 *  - Which source a run uses is bound by run id before the run starts (`bind`) and released after it (`unbind`), because the git path a job takes
 *    (`runner_local` or `runner_verified`) is decided per job, while the port is built once.
 */
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import type { StartDetachedOptions } from "../../sandbox/port.js";
import type { SdkSandbox } from "../sandboxd/sdkSlice.js";
import { DEFAULT_GUEST_PATHS, GuestWorkspaceError, sendWorkspace, type GuestPaths, type WorkspaceArchive } from "./guestWorkspace.js";

export type MakeRuntime = (guest: SdkSandbox, opts: StartDetachedOptions) => AgentRuntime;

/** What the host knows about one run's working copy. */
export interface WorkspaceSource {
  /** The commit the host workspace is at now, read the way the push reads it (never from the workspace's own git folder). */
  startCommit(hostWorkspace: string): Promise<string>;
  /** The verified archive of that commit, built from the mirror. */
  archive(commit: string): Promise<WorkspaceArchive>;
  /** Present once the guest's copy can be reopened after a stop (B-5b persistence). */
  reopen?(guest: SdkSandbox, hostWorkspace: string): Promise<boolean>;
}

export interface WorkspaceCrossing {
  makeRuntime: MakeRuntime;
  bind(runId: string, source: WorkspaceSource): void;
  unbind(runId: string): void;
}

export function createWorkspaceCrossing(inner: MakeRuntime, options: { paths?: GuestPaths } = {}): WorkspaceCrossing {
  const paths = options.paths ?? DEFAULT_GUEST_PATHS;
  const sources = new Map<string, WorkspaceSource>();
  return {
    bind: (runId, source) => void sources.set(runId, source),
    unbind: (runId) => void sources.delete(runId),
    makeRuntime(guest, opts) {
      const source = sources.get(opts.runId);
      const hostDir = opts.workdir;
      const runtime = inner(guest, { ...opts, workdir: paths.workspace });
      return {
        ...runtime,
        async start(start) {
          if (source === undefined || hostDir === undefined) throw new GuestWorkspaceError("workspace_missing");
          const resumed = (start as { resumeSessionId?: string }).resumeSessionId !== undefined;
          if (resumed) {
            if (source.reopen === undefined || !(await source.reopen(guest, hostDir))) throw new GuestWorkspaceError("workspace_missing");
          } else {
            await sendWorkspace(guest, await source.archive(await source.startCommit(hostDir)), paths);
          }
          return runtime.start({ ...start, workdir: paths.workspace });
        },
      };
    },
  };
}
