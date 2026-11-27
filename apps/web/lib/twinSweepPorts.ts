import { guardTwinVisibility, checkTwinPublish, checkTwinSeed, checkTwinSync, issueTwinPublish, issueTwinSync, openTwinSyncPr } from "@fx/runner-cloud";
import type { TwinWorkPorts } from "@fx/core/src/repos/twinSweep.js";
import { runnerDeps } from "./runnerRoutes";

/**
 * D#845 ON-27d4b: the steps of a twin's work as the sweep takes them, each the runner-cloud function of that name under the tick's own session (no person). The deps are read on each call. A seed is only checked: issuing one is a person's
 * (`twin_seed_issue` refuses a session with no user).
 */
export const twinSweepPorts: TwinWorkPorts = {
  guard: (p, id) => guardTwinVisibility(runnerDeps(), p, id),
  seed: { check: (p, id) => checkTwinSeed(runnerDeps(), p, id) },
  publish: { check: (p, id) => checkTwinPublish(runnerDeps(), p, id), issue: (p, id) => issueTwinPublish(runnerDeps(), p, id) },
  sync: { check: (p, id) => checkTwinSync(runnerDeps(), p, id), open: (p, id) => openTwinSyncPr(runnerDeps(), p, id), issue: (p, id, paths) => issueTwinSync(runnerDeps(), p, id, paths) },
};
