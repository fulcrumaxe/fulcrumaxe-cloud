/**
 * D#845 ON-8c: everything a `project_setup` job needs on the host before a sandbox exists, in the order the cloud shows it: the engine archive (`engine_fetch`), then the plan file (`plan_fetch`), then
 * the rendered plan files and the host's part of the answers. Each step is reported started, then ok or failed with a closed code. Nothing here makes a sandbox: a caller (the microVM handler, ON-8d) boots
 * one only from a `ready` result, so a tampered archive or plan never reaches a guest. On a refusal the job is already reported failed and the result says so.
 */
import type { MachineJobOf, PlanFile } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "../daemon/client.js";
import type { StepReporter } from "../daemon/machineJobs.js";
import { EngineArchiveRefused, engineFile, fetchEngineArchive, type EngineTransport, type FetchedEngine } from "./engineArchive.js";
import { fetchAndCheckPlan } from "./planCheck.js";
import { epicHeadings, hostAnswers, renderPlanFiles, type HostAnswers, type RenderedFile } from "./render.js";

export interface PrepareDeps {
  client: Pick<RunnerClient, "setupPlan">;
  reporter: StepReporter;
  transport?: EngineTransport;
  signal?: AbortSignal;
}

export type Prepared = { ready: true; engine: FetchedEngine; plan: PlanFile; files: RenderedFile[]; host: HostAnswers } | { ready: false };

/** Where the engine keeps the epic template its plan files copy their headings from. */
export const EPIC_TEMPLATE_PATH = "scripts/coldstart-templates/epic/epic.md";

export async function prepareProjectSetup(deps: PrepareDeps, job: MachineJobOf<"project_setup">): Promise<Prepared> {
  const { reporter } = deps;
  await reporter.report({ sub_step: "engine_fetch", state: "started" });
  let engine: FetchedEngine;
  let headings: string[];
  try {
    engine = await fetchEngineArchive(job.args.engine, { ...(deps.transport === undefined ? {} : { transport: deps.transport }), ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
    const template = engineFile(engine.entries, EPIC_TEMPLATE_PATH);
    headings = template === undefined ? [] : epicHeadings(template.toString("utf8"));
    if (headings.length === 0) throw new EngineArchiveRefused("engine_archive_refused", "epic_template");
  } catch (error) {
    // fx-swallow-ok: not swallowed, reported to the cloud as a closed code and reason; any other error is one `request` failure
    const refused = error instanceof EngineArchiveRefused ? error : new EngineArchiveRefused("engine_fetch_failed", "request");
    await reporter.report({ sub_step: "engine_fetch", state: "failed", failure_code: refused.code, failure_reason: refused.reason });
    return { ready: false };
  }
  await reporter.report({ sub_step: "engine_fetch", state: "ok" });
  await reporter.report({ sub_step: "plan_fetch", state: "started" });
  const checked = await fetchAndCheckPlan(deps.client, job);
  if (!checked.ok) {
    await reporter.report({ sub_step: "plan_fetch", state: "failed", failure_code: checked.code, failure_reason: checked.reason });
    return { ready: false };
  }
  await reporter.report({ sub_step: "plan_fetch", state: "ok" });
  return { ready: true, engine, plan: checked.plan, files: renderPlanFiles(checked.plan, headings), host: hostAnswers(checked.plan) };
}
