import { toPolicy, type NetworkContext, type NetworkFragment } from "@fx/env-network";
import { parse } from "@fx/env-spec";
import type { RunSandboxPort } from "./ports.js";

/** What a past run recorded: the version and image it used, and the canonical spec stored with that version. */
export interface RunEnvironmentRecord {
  readonly envVersionId: string;
  readonly imageDigest: string;
  readonly canonicalSpec: string;
}

/**
 * Replay has no way to read a repo: this interface has no file or proposal reader, so the config that exists today
 * cannot reach it (C8). What it uses is the digest on the run and the spec that was stored with that version.
 */
export interface ReplayPorts {
  /** The run's recorded environment, or null for a run with none (older than E9, or a repo with no environment). */
  getRunEnvironment(runId: string): Promise<RunEnvironmentRecord | null>;
  networkContext(): NetworkContext;
  sandbox: RunSandboxPort;
}

export type ReplayErrorCode = "no_environment_recorded" | "recorded_spec_unreadable";

export class ReplayError extends Error {
  constructor(readonly code: ReplayErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReplayError";
  }
}

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Creates the run-phase sandbox. It is never persistent: a run's sandbox does not snapshot on stop (C1). */
export function createRunSandbox(port: RunSandboxPort, args: { imageDigest: string; network: NetworkFragment }) {
  return port.create({ imageDigest: args.imageDigest, persistent: false, network: args.network });
}

/**
 * Re-creates the sandbox a past run used, from the image digest recorded on that run. The egress is rebuilt from the
 * spec stored with that version, not from the repo's file, so a config edited after the run changes nothing here.
 */
export async function replay(
  ports: ReplayPorts, runId: string,
): Promise<{ sandboxName: string; envVersionId: string; imageDigest: string }> {
  const rec = await ports.getRunEnvironment(runId);
  if (rec === null || !IMAGE_DIGEST.test(rec.imageDigest)) {
    throw new ReplayError("no_environment_recorded", "the run did not record an image digest, so there is nothing to re-create");
  }
  const parsed = parse(rec.canonicalSpec);
  if (!parsed.ok) throw new ReplayError("recorded_spec_unreadable", "the spec stored with this run's environment no longer parses");
  const network = toPolicy(parsed.spec, ports.networkContext());
  const created = await createRunSandbox(ports.sandbox, { imageDigest: rec.imageDigest, network });
  return { sandboxName: created.sandboxName, envVersionId: rec.envVersionId, imageDigest: rec.imageDigest };
}
