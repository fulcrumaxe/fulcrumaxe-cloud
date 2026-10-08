import { createHash } from "node:crypto";
import { PRESETS } from "@fx/env-presets";
import { EnvBuildError, plan, type Plan } from "@fx/env-build";
import { EnvNetworkError, toPolicy } from "@fx/env-network";
import { EnvSpecError, canonicalize, parse } from "@fx/env-spec";
import { ENV_FILE, type EnsurePorts, type RunCtx } from "./ports.js";

/**
 * What the environment step decided for a run. Structurally the runner's `RunEnvironment`, so a caller binds
 * `() => ensureEnvironment(ports, ctx)` to `startAgentRun`'s `ensureEnv` without either package importing the other.
 * `error` ends the start before anything is written: no run row, no run event (C14).
 */
export type EnsuredEnvironment =
  | { kind: "none" }
  | { kind: "ready"; envVersionId: string; imageDigest: string }
  | { kind: "error"; file: string; step: string; message: string };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const isUniqueViolation = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "23505";

function failure(step: string, message: string): EnsuredEnvironment {
  return { kind: "error", file: ENV_FILE, step, message: `${ENV_FILE}: ${step}: ${message}` };
}

/** The repo's file at the run's commit is the sole authority; the stored proposal only fills in for a missing file (C15). */
async function readSpecText(ports: EnsurePorts, ctx: RunCtx): Promise<{ text: string; source: "repo" | "proposal" } | null> {
  const file = await ports.readRepoFile(ctx, ENV_FILE);
  if (file !== null) return { text: file, source: "repo" };
  const proposal = await ports.readProposal(ctx);
  return proposal === null ? null : { text: proposal, source: "proposal" };
}

/** A failure before any version existed: the row is keyed by a digest of the text that failed, so it is stable. */
const unresolvedKey = (text: string): string => sha256(`unresolved\n${text}`);

/**
 * The `ensure-env` step (D#5 E9; C8, C12, C14, C15).
 *   1. Read `.fulcrumaxe/env.yaml` at the run's commit; only when it is absent, the stored proposal; neither: `none`.
 *   2. The plan gives the version id. A stored version is a cache hit and nothing is built.
 *   3. A miss builds under the dollar reservation, records the version, and settles the reservation on every path.
 * A failure returns `error` after writing an `env_builds` row that names the failing step. Nothing here can write a
 * run event: the ports have no such method, so a failed environment leaves no trace on the run side.
 *
 * Specs that are not preset-based (dockerfile, nix, image) stop at step `plan` with the planner's own refusal until
 * those builds exist. Version-file pins need a tree listing that the port set does not have, so they are not read.
 */
export async function ensureEnvironment(ports: EnsurePorts, ctx: RunCtx): Promise<EnsuredEnvironment> {
  const found = await readSpecText(ports, ctx);
  if (found === null) return { kind: "none" };

  /** Opens and closes a failed build row for a failure that happens before the build is attempted. */
  const recordFailed = async (key: string, step: string): Promise<void> => {
    const row = await ports.store.startBuild(key, ctx.budget);
    await ports.store.finishBuild(row.id, { status: "failed", failingStep: step, costUsd: 0 });
  };

  const parsed = parse(found.text);
  if (!parsed.ok) {
    await recordFailed(unresolvedKey(found.text), "parse_config");
    return failure("parse_config", parsed.error.message);
  }
  const spec = parsed.spec;

  let planned: Plan;
  let baseImageDigest: string;
  try {
    // An unknown or missing preset is refused by the planner with a named code; a placeholder base lets it get there.
    const baseRef = PRESETS.find((p) => p.id === spec.preset?.[0])?.base ?? `unresolved@sha256:${"0".repeat(64)}`;
    planned = plan(spec, baseRef, { accountId: ctx.accountId });
    baseImageDigest = baseRef.slice(baseRef.lastIndexOf("@") + 1);
  } catch (e) {
    if (!(e instanceof EnvBuildError || e instanceof EnvSpecError)) throw e;
    await recordFailed(unresolvedKey(found.text), "plan");
    return failure("plan", e.message);
  }
  const envVersionId = planned.envVersionId;

  try {
    toPolicy(spec, ports.networkContext(ctx));
  } catch (e) {
    if (!(e instanceof EnvNetworkError)) throw e;
    await recordFailed(envVersionId, "network_policy");
    return failure("network_policy", e.message);
  }

  const hit = await ports.store.getVersion(ctx.repoId, envVersionId);
  if (hit !== null) return { kind: "ready", envVersionId, imageDigest: hit.builtImageDigest };

  const build = await ports.store.startBuild(envVersionId, ctx.budget);
  const reservation = await ports.reserve(ctx, build.id);
  if (!reservation.ok) {
    await ports.store.finishBuild(build.id, { status: "failed", failingStep: "reserve", costUsd: 0 });
    return failure("reserve", `the build could not be started: ${reservation.reason}`);
  }

  // Until the builder reports, what it used is unknown: a throw says nothing about whether the sandbox ran or for how
  // long, so the whole reservation counts as spent. Only a reported cost lowers it.
  let costUsd = reservation.reservedUsd;
  try {
    const out = await ports.build(ctx, planned, { id: reservation.id });
    costUsd = out.costUsd;
    const logRef = out.logRef === undefined ? {} : { logRef: out.logRef };
    if (!out.ok) {
      await ports.store.finishBuild(build.id, { status: out.status, failingStep: out.step, costUsd, ...logRef });
      return failure(out.step, out.status === "killed" ? "the build was stopped at its cap" : "the build failed");
    }
    try {
      await ports.store.insertVersion(ctx.repoId, {
        envVersionId, builtImageDigest: out.builtImageDigest, baseImageDigest, canonicalSpec: canonicalize(spec), source: found.source,
      });
    } catch (e) {
      // Another run built the same version first: its row stands, and this run takes that one.
      if (!isUniqueViolation(e)) throw e;
    }
    await ports.store.finishBuild(build.id, { status: "succeeded", costUsd, ...logRef });
    const stored = await ports.store.getVersion(ctx.repoId, envVersionId);
    return { kind: "ready", envVersionId, imageDigest: (stored ?? out).builtImageDigest };
  } catch {
    // fx-swallow-ok: the failure is recorded on the build row and returned as an environment error; the raw error can carry customer build output, so it is not forwarded.
    // The builder or the store threw: the run must still not start, and the build row must not stay `running`.
    await ports.store.finishBuild(build.id, { status: "failed", failingStep: "build", costUsd }).catch(() => undefined);
    return failure("build", "the build did not complete");
  } finally {
    await ports.settle(reservation.id, costUsd);
  }
}
