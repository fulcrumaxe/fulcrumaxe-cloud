// The real machine behind the production boot facts (src/vm/bootFacts.ts): the installed template manifest, read as the runner's own user (the file is 0644),
// and the clock. It lives here, not in src/, because src/ never reads the file system for a path of the machine or `process` (test/prompt.test.ts, test/cleanEnv.test.ts).
// Nothing here can change what the facts say: the digests come from the manifest `vm install` wrote and the signed listing, and there is no override.
import { createBootFactsSource } from "../src/vm/bootFacts.js";
import { LAYOUT } from "../src/vm/installPlan.js";
import { TEMPLATES } from "../src/vm/lock.js";
import { readInstalledManifest } from "./vm-read-manifest.mjs";

/**
 * The boot facts source for this machine, for the daemon's `boot` dependency and the doctor.
 * @param {{ tuf: { listTargets(): Promise<import("../src/vm/bootGate.js").TargetListing> }, nodeArch?: string, readManifest?: () => string | Promise<string>, now?: () => number, ttlMs?: number }} deps
 */
export function createHostBootFacts(deps) {
  return createBootFactsSource({
    tuf: deps.tuf,
    template: TEMPLATES[0],
    nodeArch: deps.nodeArch ?? process.arch,
    readManifest: deps.readManifest ?? (() => readInstalledManifest(LAYOUT.templateManifest)),
    now: deps.now ?? Date.now,
    ...(deps.ttlMs === undefined ? {} : { ttlMs: deps.ttlMs }),
  });
}
