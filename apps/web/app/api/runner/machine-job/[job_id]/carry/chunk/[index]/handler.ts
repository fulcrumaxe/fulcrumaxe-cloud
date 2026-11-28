import type { NextRequest } from "next/server";
import { CARRY_CHUNK_BODY_BYTES, stateCarryChunkPutRun, stateCarryChunkTakeRun } from "@fx/runner-cloud";
import { handleRunnerRequest, runnerDeps } from "../../../../../../../../lib/runnerRoutes";

/**
 * D#845 MC-9b2: /api/runner/machine-job/:job_id/carry/chunk/:index. PUT is the old machine's upload (raw bytes, the one runner route with a 4 MiB cap), GET is the new machine's single take (an empty body,
 * the chunk back as `application/octet-stream`). Both are the runner door: a signature, no session. The decisions are in packages/runner-cloud (stateCarry.ts).
 */
export const stateCarryChunkPutHandler = (req: NextRequest, jobId: string, index: string) =>
  handleRunnerRequest(req, (deps, request) => stateCarryChunkPutRun(deps, request, jobId, index), runnerDeps, undefined, CARRY_CHUNK_BODY_BYTES);
export const stateCarryChunkTakeHandler = (req: NextRequest, jobId: string, index: string) => handleRunnerRequest(req, (deps, request) => stateCarryChunkTakeRun(deps, request, jobId, index));
