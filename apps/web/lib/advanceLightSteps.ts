import type { AdvanceFacade, AdvanceRunStart } from "@fx/worker";
import { buildLightSpecPrompt, isLightCategory, pauseOnDenial, siteStep } from "@fx/pipeline";
import type { StepWho } from "./advanceStageSteps";

/**
 * D#483 P3: the bodies of the short-Spec steps for small, bug and doc items (no panel). Plain functions over the injected
 * worker, like the other step bodies; the workflow (apps/web/workflows/workItemAdvance.ts) holds the directives.
 *
 * The PM run is keyed `light-spec:<approval>`: a replay of one approval finds its run, and a new approval (after the
 * issue was edited) starts a fresh one. A later ask after a spending-limit denial is `light-spec:<approval>:s<n>`. The PM's result stays in the run: the workflow gets back a status word, a fixed
 * code and the Spec version, never the PM's text. For a request judged not feasible, the PM's explanation is the run's
 * `summary`, which the card shows.
 */
export type LightStartWorker = Pick<AdvanceFacade, "advanceStartRun">;
export type LightPublishWorker = Pick<AdvanceFacade, "advanceLightSpec">;

export async function startLightSpecBody(worker: LightStartWorker | null, who: StepWho, input: { category: string; title: string; body: string }, actionId: string, attempt = 0): Promise<AdvanceRunStart> {
  if (!worker) return { ok: false, reason: "worker_unavailable" };
  if (!isLightCategory(input.category)) return { ok: false, reason: "invalid_input" };
  // D#483 S5-k1c: a spending-limit denial is a named pause; each later ask is a new attempt with its own key.
  return pauseOnDenial(
    await worker.advanceStartRun({
      accountId: who.accountId,
      workItemId: who.workItemId,
      haltEpoch: who.haltEpoch,
      step: siteStep("light_spec", actionId, attempt),
      role: "project-manager",
      prompt: buildLightSpecPrompt({ category: input.category, title: input.title, body: input.body }),
      clone: true,
    }),
  );
}

export interface LightPublished {
  /** published | not_feasible | refused */
  status: string;
  reason: string | null;
  version: number | null;
}

export async function publishLightSpecBody(worker: LightPublishWorker | null, who: StepWho, runId: string, actionId: string): Promise<LightPublished> {
  if (!worker) return { status: "refused", reason: "worker_unavailable", version: null };
  return worker.advanceLightSpec(who, runId, actionId);
}
