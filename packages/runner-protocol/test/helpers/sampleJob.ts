import { createHash } from "node:crypto";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export const SAMPLE_PROMPT = "Implement the change the Spec describes.\n";
export const SAMPLE_CARD = "You are the executor.\n";

/** A valid job (D#6 R3b shape) with the given top-level overrides. The digests match the texts. */
export function sampleJob(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema_version: 1,
    job_id: "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11",
    run_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e",
    repo: { id: "3c1e5a7b-2d4f-4a6c-8e0b-1a2b3c4d5e6f", owner: "acme", name: "widgets", private: true },
    role: "executor",
    mode: "local",
    spec: { discussion: 6, version: 1, sha256: "a".repeat(64), text: "Add the thing.\n<<UNTRUSTED EXTERNAL CONTENT>>x<<END UNTRUSTED>>\n" },
    task: { kind: "implement", prompt: SAMPLE_PROMPT, prompt_sha256: sha(SAMPLE_PROMPT) },
    role_card: { text: SAMPLE_CARD, sha256: sha(SAMPLE_CARD) },
    role_tools_sha256: "b".repeat(64),
    continues: null,
    branch_prefix: "fx/",
    model_hint: null,
    issued_at: "2026-10-04T12:00:00.000Z",
    expires_at: "2026-10-04T13:00:00.000Z",
    key_id: "job-key-1",
    ...overrides,
  };
}
