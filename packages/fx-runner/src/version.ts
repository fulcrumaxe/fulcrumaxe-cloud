// The version line `fx-runner --version` prints. The release build (scripts/build-sea.mjs) defines __FX_BUILD_EPOCH__ from SOURCE_DATE_EPOCH, so a
// release says the day it was built and two builds of one commit with one epoch say the same. A run from source has no epoch and says "from source".
import { CURRENT_PROTOCOL_VERSION } from "@fulcrumaxe/runner-protocol";
import pkg from "../package.json" with { type: "json" };

declare const __FX_BUILD_EPOCH__: string | undefined;

export const RUNNER_VERSION: string = pkg.version;

export function versionLine(): string {
  const epoch = typeof __FX_BUILD_EPOCH__ === "string" ? Number(__FX_BUILD_EPOCH__) : Number.NaN;
  const built = Number.isSafeInteger(epoch) && epoch >= 0 ? new Date(epoch * 1000).toISOString().slice(0, 10) : "from source";
  return `fx-runner ${RUNNER_VERSION} (${built})`;
}

/** The protocol version this build speaks on `hello` (the cloud accepts the current one and the one before it). */
export const RUNNER_PROTOCOL_VERSION: number = CURRENT_PROTOCOL_VERSION;

/**
 * D#483 S4-b2c: the capability-gated job kinds this build runs, sent on `hello` (`HelloMessage.capabilities`). The cloud offers the claim
 * verifier's job only to a runner whose latest hello listed `proposal_verifier`; the protocol version does not move for it. D#6 RUNNER-WAKE:
 * `wake_v1` asks for a wake grant on the hello and claim replies (daemon/wake.ts); an older cloud refuses it and the hello goes again without it. D#6 PUBLIC-MERGE: `plane_merge_v1` says this build can claim and execute a merge order (daemon/planeMerge.ts); the same fallback. D#6 CARD-OOM-CAUSE-WORDS: `memory_limit_v1` says the cloud may be sent the job's memory cap on a `resource_limit` end; the same fallback, and a hello that dropped it means the field is never sent. D#694 B7-1: `plane_merge_queue_v1` says this build can put a merge order's pull request into GitHub's merge queue; the same fallback. D#483 S4-f4: `discovery_analyst` says this build runs the docs-and-code analyst's confined read-only job; the cloud offers that job only to a runner whose latest hello listed it. D#519 MQ4-e2-a: `conflict_facts_v1` says this build may attach a conflict verdict to the merge report after a refused (405) merge call; the same fallback, and a hello that dropped it means the field is never sent. D#483 S5-j2c2: `ordered_facts_v1` (the newest) says this build computes the ordering fact of a merge order from its own objects and sends it on the verify message, and re-reads the default branch's tip after the go; the same fallback, and a hello that dropped it means nothing new is computed or sent.
 * D#598 P1g-3a-3: `tip_publish_v1` says this build may ask to publish the branch tip it fetched when a fix round added no commit; the same fallback, and a hello that dropped it means the request is never sent.
 * D#483 S5-j2e-RUNNER: `overlap_facts_v1` (the newest) says this build may send the overlap verdict of the private pair with a verify message whose ordering fact names an overlap; the same fallback, it needs `ordered_facts_v1` too, and a hello that dropped either means the field is never sent.
 * D#601 MEM-6: `mem_proposal_v1` says this build may offer a finished run's memory proposals to the person at a terminal and send the ones they say yes to; the same fallback, and a hello that dropped it means nothing is offered.

 * D#845 watch mode: `watch_mode_v1` says this build can keep on-demand events on the machine and send the slim status and the detail session; a cloud that lists `watch_mode` in its reply (only to a hello that declared this) turns it on. The same fallback: a cloud that refuses it drops it, and watch mode never starts.
 * D#845 ON-6c: `kvm_fact_v1` is not in this list: `fx-runner run` adds it only when the doctor made a plain present or absent KVM reading (like the browser capabilities). It says this build may send `facts.kvm`, but only on a hello after a reply that listed `kvm_fact`; the first hello never carries it. The same fallback: a cloud that refuses it drops it and the fact is never sent.
 * D#845 ON-10c: `survey_v1` (the newest) says this build runs the project survey: a read-only run of the project-surveyor role on a pinned commit, confined to the checkout, whose one answer is a project draft. It joins last, after the confined-read guard, the read-only workspace and the hostile-agent tests for the role; the same fallback, and a hello that dropped it means this runner is never offered a survey.
 * D#845 ON-10e1: `survey_public_v1` (the newest of all) says this build accepts a validly signed survey job whose repository is public (and no other public job): the survey's read-only, model-only confinement is the same. The same fallback; a hello that dropped it means this runner is never offered a public survey.
 * D#845 ON-8f2c: `project_setup_v1` (the newest of all) says this build takes `project_setup` and `engine_update` jobs (and the host-load block on its claim). It goes last, after the standard tier and every handler of those kinds; the same fallback, and a hello that dropped it means this runner is never offered a setup or an update.
 * D#842 EB-3c: `engine_bridge_v1` says this build can tail an engine's events file, upload it, pull signed engine commands and serve the decide socket for a repo the person enabled with `engine-bridge enable`; the same fallback, and a hello that dropped it means the bridge never starts.
 * D#845 MC-8b: `machine_login_v1` (the newest) says this build runs the Claude sign-in link's machine commands (daemon/claudeLogin.ts) on a managed server; the same fallback, and a cloud that refuses it sends none.
 * D#845 ON-27d4c: `twin_v1` (the newest of all, last) says this build takes the private twin's `twin_seed`, `twin_publish` and `twin_sync` jobs: all three handlers are registered in run.ts for every runner, so none is offered a job it cannot run. The same fallback; a hello that dropped it means this runner is never offered a twin job.
 */
export const RUNNER_BUILD_CAPABILITIES: Array<"proposal_verifier" | "wake_v1" | "plane_merge_v1" | "memory_limit_v1" | "plane_merge_queue_v1" | "discovery_analyst" | "conflict_facts_v1" | "ordered_facts_v1" | "tip_publish_v1" | "mem_proposal_v1" | "overlap_facts_v1" | "engine_bridge_v1" | "watch_mode_v1" | "machine_login_v1" | "survey_v1" | "survey_public_v1" | "project_setup_v1" | "twin_v1"> = ["proposal_verifier", "wake_v1", "plane_merge_v1", "memory_limit_v1", "plane_merge_queue_v1", "discovery_analyst", "conflict_facts_v1", "ordered_facts_v1", "tip_publish_v1", "mem_proposal_v1", "overlap_facts_v1", "engine_bridge_v1", "watch_mode_v1", "machine_login_v1", "survey_v1", "survey_public_v1", "project_setup_v1", "twin_v1"];
