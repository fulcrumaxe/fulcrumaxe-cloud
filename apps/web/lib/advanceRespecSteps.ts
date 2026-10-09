import type { AdvanceFacade, AdvanceRunStart } from "@fx/worker";
import { buildRespecPrompt } from "@fx/pipeline";
import type { StepWho } from "./advanceStageSteps";

/**
 * D#6 R4d-5b (C34 section 2.3): the bodies of the Re-spec steps (apps/web/workflows/workItemAdvance.ts holds the directives). Plain functions over the injected
 * worker, like the short-Spec steps beside them.
 *
 * The project-manager run is keyed `respec:<approval>` (the worker prefixes the work item: `advance:<item>:respec:<approval>`), so a replay of one press finds
 * its run and a new press starts a fresh one. The run's result stays in the run: the workflow gets back a status word, a fixed code and the new Spec version,
 * never the list or anything the model wrote.
 */
export type RespecStartWorker = Pick<AdvanceFacade, "advanceStartRun" | "advanceLoadSpecText">;
export type RespecPublishWorker = Pick<AdvanceFacade, "advanceRespec">;

/** Starts the file-list run on the Spec version the press named (`specVersion`). A newer version, or an erased one, is `spec_changed`: nothing is started. */
export async function startRespecBody(worker: RespecStartWorker | null, who: StepWho, specVersion: number | null, actionId: string): Promise<AdvanceRunStart> {
  if (!worker) return { ok: false, reason: "worker_unavailable" };
  if (specVersion === null) return { ok: false, reason: "no_spec" };
  const spec = await worker.advanceLoadSpecText(who, specVersion);
  if (spec === null) return { ok: false, reason: "spec_changed" };
  return worker.advanceStartRun({
    accountId: who.accountId,
    workItemId: who.workItemId,
    haltEpoch: who.haltEpoch,
    step: `respec:${actionId}`,
    role: "project-manager",
    prompt: buildRespecPrompt({ version: spec.version, spec: spec.body }),
    clone: true,
  });
}

export interface RespecPublished {
  /** published | refused */
  status: string;
  reason: string | null;
  version: number | null;
}

export async function publishRespecBody(worker: RespecPublishWorker | null, who: StepWho, runId: string, actionId: string, specVersion: number): Promise<RespecPublished> {
  if (!worker) return { status: "refused", reason: "worker_unavailable", version: null };
  return worker.advanceRespec(who, runId, actionId, specVersion);
}
