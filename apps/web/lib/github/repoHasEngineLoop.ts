import type { GithubWebhookDbDeps } from "@fx/github";
import { ENGINE_LOOP_MARKER } from "@fx/core/src/plan/executeImport.js";
import { openPlanSource } from "./planSource";

/**
 * D#483 S4-d: whether the repository's default branch holds the engine loop's project file, read with the same read-only plan source
 * the import and the discovery use. The webhook asks it only for an outside author's issue that is about to become a proposal, because
 * the answer decides who owns the proposal (S3 rule E6). A failed read throws; the webhook then leaves the issue for the next discovery.
 */
const MARKER_MAX_BYTES = 1024 * 1024;

export const repoHasEngineLoop: NonNullable<GithubWebhookDbDeps["repoHasEngineLoop"]> = async (input) => {
  const source = openPlanSource(input);
  const head = await source.head();
  return (await source.file(ENGINE_LOOP_MARKER, head.sha, MARKER_MAX_BYTES)) !== null;
};
