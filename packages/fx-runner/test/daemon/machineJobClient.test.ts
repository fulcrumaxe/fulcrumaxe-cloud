import { describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, MAX_PLAN_BYTES, MachineJobClaimMessage, REPO_TOKEN_PATH, REPO_TOKEN_STOP_PATH, RepoTokenMessage, SessionJobProgressBody, SetupProgressBody, machineJobProgressPath, setupPlanPath, setupProgressPath } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";
import { SETUP_ID, signedJob } from "../helpers/machineJobFixture.js";

/** D#845 ON-8c: the client calls for the machine-job claim route, the setup progress route and the plan route; strict on what is sent and on what is believed. */
interface Seen { method: string; url: string; body: string; headers: Record<string, string> }
function clientAnswering(status: number, body: unknown, raw?: string) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ method: String(init.method), url: String(url), body: String(init.body ?? ""), headers: init.headers as Record<string, string> });
    return new Response(raw ?? JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), seen };
}
const errorBody = (code: string): unknown => ({ error: { code, message: "x" } });
const body: SetupProgressBody = { job_id: "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f", seq: 0, sub_step: "engine_fetch", state: "started" };

describe("claim replies", () => {
  it("carry `machine_job` through, on an idle answer and on a claimed run, and never set it otherwise", async () => {
    expect(await clientAnswering(200, { retry_after: 30, machine_job: true }).client.claim()).toEqual({ kind: "idle", retryAfter: 30, machineJob: true });
    expect(await clientAnswering(200, { retry_after: 30 }).client.claim()).toEqual({ kind: "idle", retryAfter: 30 });
    expect(await clientAnswering(200, { retry_after: 30, machine_job: false }).client.claim()).toMatchObject({ kind: "error", code: "invalid_reply" });
  });
});

describe("machineJobClaim", () => {
  it("sends the empty strict message, signed, to the constant path and returns the signed job untouched", async () => {
    const signed = signedJob();
    const { client, seen } = clientAnswering(200, { signed_job: signed });
    expect(await client.machineJobClaim()).toEqual({ kind: "job", signedJob: signed });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${MACHINE_JOB_CLAIM_PATH}`);
    expect(MachineJobClaimMessage.parse(JSON.parse(seen[0]!.body))).toEqual({});
    expect(Object.keys(seen[0]!.headers).some((h) => h.toLowerCase() === "signature")).toBe(true);
  });

  it("retry_after is none; a reply the protocol does not describe is an invalid reply; other statuses are call errors", async () => {
    expect(await clientAnswering(200, { retry_after: 60 }).client.machineJobClaim()).toEqual({ kind: "none", retryAfter: 60 });
    expect(await clientAnswering(200, { signed_job: signedJob(), extra: 1 }).client.machineJobClaim()).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(200, { signed_job: { job: {}, key_id: "k", signature: "s" } }).client.machineJobClaim()).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(401, errorBody("unauthorized")).client.machineJobClaim()).toMatchObject({ kind: "error", status: 401, code: "unauthorized" });
  });
});

describe("setupProgress", () => {
  it("sends the strict body to the setup's path and tells recorded from the cloud's closed refusals", async () => {
    const ok = clientAnswering(200, { recorded: true });
    expect(await ok.client.setupProgress(SETUP_ID, body)).toEqual({ kind: "recorded" });
    expect(ok.seen[0]!.url).toBe(`https://cloud.example.test${setupProgressPath(SETUP_ID)}`);
    expect(SetupProgressBody.parse(JSON.parse(ok.seen[0]!.body))).toEqual(body);
    expect(await clientAnswering(409, errorBody("job_superseded")).client.setupProgress(SETUP_ID, body)).toEqual({ kind: "refused", status: 409, code: "job_superseded" });
    expect(await clientAnswering(409, errorBody("seq_not_increasing")).client.setupProgress(SETUP_ID, body)).toEqual({ kind: "refused", status: 409, code: "seq_not_increasing" });
    expect(await clientAnswering(404, errorBody("not_found")).client.setupProgress(SETUP_ID, body)).toEqual({ kind: "refused", status: 404, code: "not_found" });
    expect(await clientAnswering(200, { recorded: false }).client.setupProgress(SETUP_ID, body)).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(503, errorBody("not_configured")).client.setupProgress(SETUP_ID, body)).toMatchObject({ kind: "error", status: 503 });
  });

  it("a body the protocol would refuse, or an id that is not a uuid, is never sent", async () => {
    const c = clientAnswering(200, { recorded: true });
    for (const bad of [{ ...body, sub_step: "rm_rf" }, { ...body, state: "failed" }, { ...body, failure_reason: "free text here" }, { ...body, extra: 1 }]) {
      expect(await c.client.setupProgress(SETUP_ID, bad as never)).toMatchObject({ kind: "error", code: "invalid_message" });
    }
    expect(await c.client.setupProgress("../../etc", body)).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(c.seen).toHaveLength(0);
  });
});

describe("machineJobProgress (a session job's report, by its job id)", () => {
  const session: SessionJobProgressBody = { seq: 0, step: "admission", state: "started" };
  it("sends the strict body to the machine-job route and tells recorded from the cloud's closed refusals", async () => {
    const ok = clientAnswering(200, { recorded: true });
    expect(await ok.client.machineJobProgress(SETUP_ID, session)).toEqual({ kind: "recorded" });
    expect(ok.seen[0]!.url).toBe(`https://cloud.example.test${machineJobProgressPath(SETUP_ID)}`);
    expect(ok.seen[0]!.method).toBe("POST");
    expect(SessionJobProgressBody.parse(JSON.parse(ok.seen[0]!.body))).toEqual(session);
    expect(Object.keys(ok.seen[0]!.headers).some((h) => h.toLowerCase() === "signature")).toBe(true);
    expect(await clientAnswering(409, errorBody("job_not_active")).client.machineJobProgress(SETUP_ID, session)).toEqual({ kind: "refused", status: 409, code: "job_not_active" });
    expect(await clientAnswering(409, errorBody("seq_not_increasing")).client.machineJobProgress(SETUP_ID, session)).toEqual({ kind: "refused", status: 409, code: "seq_not_increasing" });
    expect(await clientAnswering(404, errorBody("not_found")).client.machineJobProgress(SETUP_ID, session)).toEqual({ kind: "refused", status: 404, code: "not_found" });
    expect(await clientAnswering(200, { recorded: false }).client.machineJobProgress(SETUP_ID, session)).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(401, errorBody("unauthorized")).client.machineJobProgress(SETUP_ID, session)).toMatchObject({ kind: "error", status: 401 });
  });

  it("a body the protocol would refuse, or an id that is not a uuid, is never sent", async () => {
    const c = clientAnswering(200, { recorded: true });
    for (const bad of [{ ...session, step: "rm_rf" }, { ...session, state: "failed" }, { ...session, failure_reason: "free text here" }, { ...session, start_mode: "created" }, { ...session, extra: 1 }, { ...session, job_id: SETUP_ID }]) {
      expect(await c.client.machineJobProgress(SETUP_ID, bad as never)).toMatchObject({ kind: "error", code: "invalid_message" });
    }
    expect(await c.client.machineJobProgress("../../etc", session)).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(c.seen).toHaveLength(0);
  });
});

describe("setupPlan", () => {
  it("is a signed GET of the plan path for the version and returns the text exactly as read", async () => {
    const text = '{"v":1,"note":"é\\n"}';
    const { client, seen } = clientAnswering(200, undefined, text);
    expect(await client.setupPlan(SETUP_ID, 3)).toEqual({ kind: "plan", text });
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`https://cloud.example.test${setupPlanPath(SETUP_ID, 3)}`);
    expect(Object.keys(seen[0]!.headers).some((h) => h.toLowerCase() === "signature")).toBe(true);
  });

  it("reads a body up to the protocol limit and refuses one over it", async () => {
    const atLimit = "x".repeat(MAX_PLAN_BYTES);
    expect(await clientAnswering(200, undefined, atLimit).client.setupPlan(SETUP_ID, 1)).toEqual({ kind: "plan", text: atLimit });
    expect(await clientAnswering(200, undefined, atLimit + "y").client.setupPlan(SETUP_ID, 1)).toEqual({ kind: "too_large" });
  });

  it("404 is missing; other statuses are call errors; a bad id or version never goes out", async () => {
    expect(await clientAnswering(404, errorBody("not_found")).client.setupPlan(SETUP_ID, 1)).toEqual({ kind: "missing" });
    expect(await clientAnswering(500, errorBody("internal")).client.setupPlan(SETUP_ID, 1)).toMatchObject({ kind: "error", status: 500 });
    const c = clientAnswering(200, undefined, "{}");
    expect(await c.client.setupPlan("nope", 1)).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(await c.client.setupPlan(SETUP_ID, 0)).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(c.seen).toHaveLength(0);
  });
});

/** D#845 ON-18: the repo-scoped token of a running session. */
describe("engineRepoToken", () => {
  const SESSION = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
  it("sends the strict message, signed, to the engine route, and returns the token and its expiry", async () => {
    const { client, seen } = clientAnswering(200, { token: "ghs_sentinel_x", expires_at: "2026-11-27T20:00:00.000Z" });
    expect(await client.engineRepoToken(77, SESSION)).toEqual({ kind: "token", token: "ghs_sentinel_x", expiresAt: "2026-11-27T20:00:00.000Z" });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${REPO_TOKEN_PATH}`);
    expect(RepoTokenMessage.parse(JSON.parse(seen[0]!.body))).toEqual({ repo_gh_id: 77, session_id: SESSION });
    expect(Object.keys(seen[0]!.headers).some((h) => h.toLowerCase() === "signature")).toBe(true);
  });
  it("tells the cloud's closed refusals (404, 409, 502) from a call error, and keeps only the code", async () => {
    for (const status of [404, 409, 502] as const) expect(await clientAnswering(status, errorBody("session_not_running")).client.engineRepoToken(77, SESSION)).toEqual({ kind: "refused", status, code: "session_not_running" });
    expect(await clientAnswering(503, errorBody("upstream_unavailable")).client.engineRepoToken(77, SESSION)).toMatchObject({ kind: "error", status: 503 });
    expect(await clientAnswering(401, errorBody("unauthorized")).client.engineRepoToken(77, SESSION)).toMatchObject({ kind: "error", status: 401 });
  });
  it("a reply the protocol does not describe is an invalid reply, and a bad id or session never leaves the machine", async () => {
    expect(await clientAnswering(200, { token: "t", expires_at: "2026-11-27T20:00:00.000Z", extra: 1 }).client.engineRepoToken(77, SESSION)).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(200, { token: "", expires_at: "2026-11-27T20:00:00.000Z" }).client.engineRepoToken(77, SESSION)).toMatchObject({ kind: "error", code: "invalid_reply" });
    const refused = clientAnswering(200, {});
    expect(await refused.client.engineRepoToken(0, SESSION)).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(await refused.client.engineRepoToken(77, "not-a-uuid")).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(refused.seen).toEqual([]);
  });
});

/** D#845 ON-18 (Ruling 126.2): the report of the session stop made for `token_refresh_failed`. */
describe("engineRepoTokenStop", () => {
  const SESSION = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
  it("sends the strict message, signed, to the stop-report route, and returns what the cloud recorded", async () => {
    const { client, seen } = clientAnswering(200, { result: "recorded" });
    expect(await client.engineRepoTokenStop(77, SESSION)).toEqual({ kind: "reported", result: "recorded" });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${REPO_TOKEN_STOP_PATH}`);
    expect(RepoTokenMessage.parse(JSON.parse(seen[0]!.body))).toEqual({ repo_gh_id: 77, session_id: SESSION });
    expect(Object.keys(seen[0]!.headers).some((h) => h.toLowerCase() === "signature")).toBe(true);
    expect(await clientAnswering(200, { result: "already" }).client.engineRepoTokenStop(77, SESSION)).toEqual({ kind: "reported", result: "already" });
  });
  it("tells the closed refusals from a call error and keeps only the code (a 404 with no code is a cloud without the route)", async () => {
    for (const status of [404, 409] as const) expect(await clientAnswering(status, errorBody("session_not_running")).client.engineRepoTokenStop(77, SESSION)).toEqual({ kind: "refused", status, code: "session_not_running" });
    expect(await clientAnswering(404, undefined, "<html>not found</html>").client.engineRepoTokenStop(77, SESSION)).toEqual({ kind: "refused", status: 404 });
    expect(await clientAnswering(503, errorBody("not_configured")).client.engineRepoTokenStop(77, SESSION)).toMatchObject({ kind: "error", status: 503 });
  });
  it("a reply the protocol does not describe is an invalid reply, and a bad id or session never leaves the machine", async () => {
    expect(await clientAnswering(200, { result: "done" }).client.engineRepoTokenStop(77, SESSION)).toMatchObject({ kind: "error", code: "invalid_reply" });
    const refused = clientAnswering(200, {});
    expect(await refused.client.engineRepoTokenStop(0, SESSION)).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(refused.seen).toEqual([]);
  });
});
