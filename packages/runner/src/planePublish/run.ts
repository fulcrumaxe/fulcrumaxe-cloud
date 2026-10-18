import { buildSandboxEnv } from "../sandboxEnv.js";
import { PLANE_PUBLISH_ROLE } from "../sandboxNaming.js";
import { PLANE_PUBLISH_VCPUS, type SandboxPort } from "../sandboxPort.js";
import type { NetworkPolicyRule } from "../networkPolicy.js";
import { PLANE_PUBLISH_HOOK_PATH, PLANE_PUBLISH_INPUT_PATH, parsePhaseOutput, terminalLine, type PlanePublishInput, type PlanePublishLine } from "./protocol.js";

/**
 * D#598 P1f-5a: one publish sandbox, from create to delete. The worker's publish step (P1f-5b) calls this with the hook's built bytes and the
 * input it has just read; this file is the only place the pieces are put together, so the guarantees hold for every caller:
 *  - 1 vCPU, no persistence, the env of the `plane_publish` role (CA paths only) and the GitHub-proxy policy alone: no model connection;
 *  - the hook is written with mode 0555 and the input with 0444, through the port's file call; nothing is run through a shell;
 *  - the sandbox is stopped and deleted on every outcome: a clean run, a refusal, a non-zero exit, a timeout, a failed write or run, a throw.
 * A run counts as finished only when the command exited 0, was not cut or timed out, and printed exactly one terminal line. Anything else
 * is `crashed`: the lines are returned for the log, but no outcome is read from them.
 */
export const PUBLISH_SANDBOX_TIMEOUT_MS = 75 * 60_000;
export const PUBLISH_COMMAND_TIMEOUT_MS = 10 * 60_000;

export type PublishRun =
  | { kind: "finished"; terminal: PlanePublishLine; lines: PlanePublishLine[] }
  | { kind: "crashed"; why: "exit" | "timeout" | "truncated" | "no_terminal" | "rejected_line"; exitCode: number | null; lines: PlanePublishLine[] };

export interface PublishSandboxRequest {
  sandboxName: string;
  /** The built `fx-plane-publish.mjs`. */
  hook: string;
  input: PlanePublishInput;
  networkPolicy: NetworkPolicyRule[];
  onSession?: (sessionId: string) => void | Promise<void>;
}

export async function runPublishSandbox(port: SandboxPort, req: PublishSandboxRequest): Promise<PublishRun> {
  const handle = await port.createSandbox({ sandboxName: req.sandboxName, retention: { persistent: false }, timeoutMs: PUBLISH_SANDBOX_TIMEOUT_MS, vcpus: PLANE_PUBLISH_VCPUS });
  try {
    await port.writeFiles(handle, [
      { path: PLANE_PUBLISH_HOOK_PATH, content: req.hook, mode: 0o555 },
      { path: PLANE_PUBLISH_INPUT_PATH, content: JSON.stringify(req.input), mode: 0o444 },
    ]);
    const r = await port.runCommand(handle, {
      role: PLANE_PUBLISH_ROLE,
      cmd: "node",
      args: [PLANE_PUBLISH_HOOK_PATH],
      env: buildSandboxEnv(PLANE_PUBLISH_ROLE),
      networkPolicy: req.networkPolicy,
      timeoutMs: PUBLISH_COMMAND_TIMEOUT_MS,
      ...(req.onSession !== undefined && { onSession: req.onSession }),
    });
    const { lines, rejected } = parsePhaseOutput(r.stdout);
    if (r.timedOut) return { kind: "crashed", why: "timeout", exitCode: r.exitCode, lines };
    if (r.truncated) return { kind: "crashed", why: "truncated", exitCode: r.exitCode, lines };
    if (r.exitCode !== 0) return { kind: "crashed", why: "exit", exitCode: r.exitCode, lines };
    // A marked line the contract refuses (an unknown field, content, a bad value, past the cap) makes the whole run a crash, even beside a valid terminal line.
    if (rejected > 0) return { kind: "crashed", why: "rejected_line", exitCode: r.exitCode, lines };
    const terminal = terminalLine(lines);
    return terminal === undefined ? { kind: "crashed", why: "no_terminal", exitCode: r.exitCode, lines } : { kind: "finished", terminal, lines };
  } finally {
    // Stop, then delete, whatever happened above. A failed stop never skips the delete; a failed delete reaches the caller (the reaper is the net).
    try {
      await port.stop(handle);
    } catch {
      // fx-swallow-ok: stop is idempotent and best effort; the delete below removes the sandbox either way
    }
    await port.deleteSandbox(handle);
  }
}
