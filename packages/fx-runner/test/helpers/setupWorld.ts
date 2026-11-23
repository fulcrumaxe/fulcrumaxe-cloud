import { createHash } from "node:crypto";
import { SetupProgressBody, type MachineJobOf, type PlanFile } from "@fulcrumaxe/runner-protocol";
import { createStepReporter, type StepReporter } from "../../src/daemon/machineJobs.js";
import type { RunnerClient } from "../../src/daemon/client.js";
import type { EngineResponse, EngineTransport } from "../../src/setup/engineArchive.js";
import { DRAFT_ID, jobOf, planBytes, samplePlan } from "./machineJobFixture.js";

/** A transport that serves `bytes` for any address the host check let through. It stands in for the network only; the host check is the code's own. */
export const serveBytes = (bytes: Buffer): EngineTransport => async () => ({ status: 200, contentLength: bytes.length, body: (async function* () { yield bytes; })(), close() {} }) satisfies EngineResponse;

/** What the cloud shows a runner for one setup: the signed job's own fields, the plan route and the progress route, strict on every body. */
export function fakeCloud(options: { engine: Buffer; baseSha: string; issuedAt?: string; kind?: "existing" | "new" }): { job: MachineJobOf<"project_setup">; plan: PlanFile; client: Pick<RunnerClient, "machineJobClaim" | "setupPlan" | "setupProgress">; progress: SetupProgressBody[]; reporter: StepReporter; signal: AbortSignal } {
  const plan = samplePlan({ setup: { ...samplePlan().setup, kind: options.kind ?? "existing" } });
  const sum = planBytes(plan);
  const job = jobOf({ ...(options.issuedAt === undefined ? {} : { issued_at: options.issuedAt, expires_at: new Date(Date.parse(options.issuedAt) + 10 * 60_000).toISOString() }) }, {
    base_sha: options.baseSha,
    engine: { version: "1.2.3", commit_sha: "a".repeat(40), tarball_url: `https://codeload.github.com/acme/engine/tar.gz/${"a".repeat(40)}`, tarball_sha256: createHash("sha256").update(options.engine).digest("hex") },
    plan_ref: { draft_id: DRAFT_ID, version: 2, sha256: sum.sha256 },
  }) as MachineJobOf<"project_setup">;
  const progress: SetupProgressBody[] = [];
  const client: Pick<RunnerClient, "machineJobClaim" | "setupPlan" | "setupProgress"> = {
    async machineJobClaim() {
      return { kind: "none", retryAfter: 60 };
    },
    async setupPlan() {
      return { kind: "plan", text: sum.text };
    },
    async setupProgress(_id, body) {
      const parsed = SetupProgressBody.parse(body);
      if (progress.length > 0 && parsed.seq <= (progress[progress.length - 1] as SetupProgressBody).seq) return { kind: "refused", status: 409, code: "seq_not_increasing" };
      progress.push(parsed);
      return { kind: "recorded" };
    },
  };
  const ended = new AbortController();
  const reporter = createStepReporter({ client }, job, ended);
  return { job, plan, client, progress, reporter, signal: ended.signal };
}

/** `sub_step:state` for each report, with the failure code when there is one. */
export const compact = (progress: readonly SetupProgressBody[]): string[] => progress.map((p) => `${p.sub_step}:${p.state}${p.failure_code === undefined ? "" : `:${p.failure_code}`}${p.failure_reason === undefined ? "" : `/${p.failure_reason}`}`);
