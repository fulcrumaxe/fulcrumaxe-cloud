import { start } from "workflow/api";
import type { AdvanceStartArgs } from "@fx/worker";
import { workItemAdvanceWorkflow } from "../workflows/workItemAdvance";

/**
 * D#483 P1: the stage driver's workflow starter, the `startAdvance` port of the worker. Its argument is plain data
 * (ids only). Same shape as `createFollow` in ./hooks.ts: the dependency is injectable so a test needs no Workflow
 * service.
 */
export function createStartAdvance(deps: { start: (workflow: typeof workItemAdvanceWorkflow, args: [AdvanceStartArgs]) => Promise<unknown> } = { start }): (args: AdvanceStartArgs) => Promise<void> {
  return async (args) => {
    await deps.start(workItemAdvanceWorkflow, [args]);
  };
}
