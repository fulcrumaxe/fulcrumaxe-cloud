import { createPrivateKey, createHash, type KeyObject } from "node:crypto";
import type { Job } from "../../src/job.js";
import { sampleJob } from "./sampleJob.js";

/**
 * D#6 R4d-4a (C33) [G2]: three non-review jobs and a fixed Ed25519 test key. Ed25519 signatures are deterministic, so the canonical
 * JSON and the signature of each job are pinned in `test/golden/`, made from the code before `review` existed.
 */
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A test-only key: a fixed 32-byte seed in a PKCS#8 wrapper. It signs nothing real. */
export const GOLDEN_KEY: KeyObject = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
  format: "der",
  type: "pkcs8",
});

const ADVISE_PROMPT = "Give your view of the proposal.\n";
const ADVISE_CARD = "You are an advisor.\n";

export const GOLDEN_JOBS: Record<"executor" | "advise" | "docs-writer", Job> = {
  executor: sampleJob() as Job,
  advise: sampleJob({ role: "project-manager", task: { kind: "advise", prompt: ADVISE_PROMPT, prompt_sha256: sha(ADVISE_PROMPT) }, role_card: { text: ADVISE_CARD, sha256: sha(ADVISE_CARD) } }) as Job,
  "docs-writer": sampleJob({ role: "docs-writer", task: { kind: "advise", prompt: ADVISE_PROMPT, prompt_sha256: sha(ADVISE_PROMPT) }, role_card: { text: ADVISE_CARD, sha256: sha(ADVISE_CARD) } }) as Job,
};
