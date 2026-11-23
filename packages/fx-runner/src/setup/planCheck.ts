/**
 * D#845 ON-8c: the plan file of a `project_setup` job, read from the cloud and checked against the job's own `plan_ref`. The job is signed, so its `plan_ref.sha256` is the cloud's word
 * for the exact bytes; the route's reply is hashed as bytes first, and only bytes that match are parsed, strictly, with `PlanFile`. A reply that parses but names another draft or
 * version than the job does is refused too. Every refusal is a closed code and one closed reason word.
 */
import { createHash } from "node:crypto";
import { PlanFile, type MachineJobOf } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "../daemon/client.js";

export type PlanCode = "plan_fetch_failed" | "plan_checksum" | "plan_invalid";
export type PlanCheck = { ok: true; plan: PlanFile; sha256: string } | { ok: false; code: PlanCode; reason: string };

const refuse = (code: PlanCode, reason: string): PlanCheck => ({ ok: false, code, reason });

export async function fetchAndCheckPlan(client: Pick<RunnerClient, "setupPlan">, job: MachineJobOf<"project_setup">): Promise<PlanCheck> {
  if (job.setup_id === undefined) return refuse("plan_fetch_failed", "no_setup");
  const got = await client.setupPlan(job.setup_id, job.args.plan_ref.version);
  if (got.kind === "missing") return refuse("plan_fetch_failed", "not_found");
  if (got.kind === "too_large") return refuse("plan_fetch_failed", "too_large");
  if (got.kind !== "plan") return refuse("plan_fetch_failed", "request");
  const sha256 = createHash("sha256").update(Buffer.from(got.text, "utf8")).digest("hex");
  if (sha256 !== job.args.plan_ref.sha256) return refuse("plan_checksum", "mismatch");
  let doc: unknown;
  try {
    doc = JSON.parse(got.text);
  } catch {
    // fx-swallow-ok: the parser's message can quote the body; the refusal names only that it was not JSON
    return refuse("plan_invalid", "json");
  }
  const parsed = PlanFile.safeParse(doc);
  if (!parsed.success) return refuse("plan_invalid", "shape");
  if (parsed.data.draft_id !== job.args.plan_ref.draft_id || parsed.data.version !== job.args.plan_ref.version) return refuse("plan_invalid", "mismatch");
  return { ok: true, plan: parsed.data, sha256 };
}
