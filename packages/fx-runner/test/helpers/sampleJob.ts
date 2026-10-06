import { createHash } from "node:crypto";
import type { Job } from "@fulcrumaxe/runner-protocol";
import { roleToolsDigest } from "../../src/job/roleTools.js";

export const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The fields of a job the checks read, with every digest matching its text. */
export function sampleJob(over: { role?: string; prompt?: string; card?: string } = {}): Pick<Job, "role" | "task" | "role_card" | "role_tools_sha256"> {
  const role = over.role ?? "executor";
  const prompt = over.prompt ?? "Implement the change.\n";
  const card = over.card ?? "You are the executor.\n";
  return {
    role,
    task: { kind: "implement", prompt, prompt_sha256: sha(prompt) },
    role_card: { text: card, sha256: sha(card) },
    role_tools_sha256: roleToolsDigest(role),
  } as Pick<Job, "role" | "task" | "role_card" | "role_tools_sha256">;
}
