/**
 * Where a job's working copy crosses into a microVM (D#587 B-5b). The microVM port builds an agent runtime for each start from the guest's command slice
 * (`makeRuntime`); this wraps that one function, so the port itself decides nothing about a working copy.
 *
 *  - Before the agent starts, the repository is built on the host (`source.archive`, from the runner's own mirror, for the commit the host workspace is at)
 *    and sent into the guest (`sendWorkspace`). The agent is then started in the guest's own work directory.
 *  - The host's workspace path never goes further than this wrapper: the runtime the inner function builds, and the options it starts with, name the
 *    guest's directory. (Any other field that carries a host path is the caller's to keep out; the port refuses the ones it knows of.)
 *  - A start that RESUMES a session (the repair turn, or a start after a stop that kept a snapshot) needs the guest's own copy to be still there: the commit
 *    this run sent is remembered, and the guest's marker must name it (`reopenWorkspace`). A copy that is gone (an evicted sandbox, a daemon that restarted) is
 *    refused with `workspace_missing`, so a session is never continued over a copy that was not checked.
 *  - `collect` is the way out: after the agent has ended it asks the guest for a bundle of what the run committed (`pullBundle`), with the commit the run
 *    started from, for the host to check and apply.
 *  - Which source a run uses is bound by run id before the run starts (`bind`) and released after it (`unbind`), because the git path a job takes
 *    (`runner_local` or `runner_verified`) is decided per job, while the port is built once.
 */
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import type { StartDetachedOptions } from "../../sandbox/port.js";
import type { SdkSandbox } from "../sandboxd/sdkSlice.js";
import { pullBundle, reopenWorkspace } from "./bundleOut.js";
import { DEFAULT_GUEST_PATHS, GuestWorkspaceError, sendWorkspace, type GuestPaths, type WorkspaceArchive } from "./guestWorkspace.js";

export type MakeRuntime = (guest: SdkSandbox, opts: StartDetachedOptions) => AgentRuntime;

/** What the host knows about one run's working copy. */
export interface WorkspaceSource {
  /** The commit the host workspace is at now, read the way the push reads it (never from the workspace's own git folder). */
  startCommit(hostWorkspace: string): Promise<string>;
  /** The verified archive of that commit, built from the mirror. */
  archive(commit: string): Promise<WorkspaceArchive>;
}

export interface WorkspaceCrossing {
  makeRuntime: MakeRuntime;
  bind(runId: string, source: WorkspaceSource): void;
  unbind(runId: string): void;
  /** What the guest committed since this run's start commit: a bundle (untrusted) and that commit, or null when nothing was committed. Throws `BundlePullError`, or `workspace_missing` for a run that sent nothing. */
  collect(runId: string, guest: SdkSandbox): Promise<{ bundle: Buffer; base: string } | null>;
}

export function createWorkspaceCrossing(inner: MakeRuntime, options: { paths?: GuestPaths } = {}): WorkspaceCrossing {
  const paths = options.paths ?? DEFAULT_GUEST_PATHS;
  const sources = new Map<string, WorkspaceSource>();
  /** The commit each run sent into its guest. */
  const sent = new Map<string, string>();
  return {
    bind: (runId, source) => void sources.set(runId, source),
    unbind: (runId) => void (sources.delete(runId), sent.delete(runId)),
    async collect(runId, guest) {
      const base = sent.get(runId);
      if (base === undefined) throw new GuestWorkspaceError("workspace_missing");
      const bundle = await pullBundle(guest, base, { paths });
      return bundle === null ? null : { bundle, base };
    },
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
            const base = sent.get(opts.runId);
            if (base === undefined || !(await reopenWorkspace(guest, base, paths))) throw new GuestWorkspaceError("workspace_missing");
          } else {
            const archive = await source.archive(await source.startCommit(hostDir));
            await sendWorkspace(guest, archive, paths);
            sent.set(opts.runId, archive.commit);
          }
          return runtime.start({ ...start, workdir: paths.workspace });
        },
      };
    },
  };
}
