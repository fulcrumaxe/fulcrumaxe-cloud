import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_RUNNER_STEPS, SetupProgressBody, canonicalJson, setupPlanPath, setupProgressPath, type MachineJob, type PlanFile, MACHINE_JOB_CLAIM_PATH } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { createMachineJobDispatcher } from "../../src/daemon/machineJobs.js";
import { generateRunnerKey } from "../../src/keys.js";
import { prepareProjectSetup, type Prepared } from "../../src/setup/prepare.js";
import { DRAFT_ID, JOB_KEYRING, RUNNER_ID, SETUP_ID, jobOf, planBytes, samplePlan, signedJob } from "../helpers/machineJobFixture.js";
import { engineTgz } from "../helpers/tarBuilder.js";
import { redirectTo, sendBytes, startEngineHttps, type EngineHttps, type Route } from "../helpers/engineHttps.js";

/**
 * D#845 ON-8c, end to end on the real contract: the real signed client over a fake cloud that checks what the real routes check (the signature header, the strict body, `seq` above the last,
 * the plan route's path), a real Ed25519 signed job, the real engine fetch over local TLS, and a spy standing in for the sandbox create that only ever runs from a `ready` result.
 */
const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const COMMIT = "a".repeat(40);
const PATH_OK = `/acme/engine/tar.gz/${COMMIT}`;

let https: EngineHttps | undefined;
afterEach(async () => {
  await https?.close();
  https = undefined;
});

interface World {
  job: MachineJob;
  planText?: string;
  planStatus?: number;
  routes: Record<string, Route>;
}
async function runWorld(world: World): Promise<{ progress: SetupProgressBody[]; sandboxCreates: number; prepared: Prepared | undefined; unauthenticated: number }> {
  https = await startEngineHttps(world.routes);
  const progress: SetupProgressBody[] = [];
  let unauthenticated = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const headers = init.headers as Record<string, string>;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "signature")) unauthenticated++;
    const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
    if (u.pathname === MACHINE_JOB_CLAIM_PATH) return json(200, { signed_job: signedJob(world.job) });
    if (u.pathname + u.search === setupPlanPath(SETUP_ID, 2)) return new Response(world.planText ?? "", { status: world.planStatus ?? 200 });
    if (u.pathname === setupProgressPath(SETUP_ID)) {
      const body = SetupProgressBody.parse(JSON.parse(String(init.body)));
      if (progress.length > 0 && body.seq <= progress[progress.length - 1]!.seq) return json(409, { error: { code: "seq_not_increasing", message: "x" } });
      progress.push(body);
      return json(200, { recorded: true });
    }
    return json(404, { error: { code: "not_found", message: "x" } });
  }) as unknown as typeof fetch;
  const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn });
  let sandboxCreates = 0;
  let prepared: Prepared | undefined;
  const dispatcher = createMachineJobDispatcher({
    client,
    keyring: JOB_KEYRING,
    runnerId: RUNNER_ID,
    now: () => new Date(),
    sandboxEngine: () => "microvm",
    handlers: {
      project_setup: async ({ job, reporter, signal }) => {
        prepared = await prepareProjectSetup({ client, reporter, transport: https!.transport, signal }, job);
        // the microVM handler (ON-8d) boots a sandbox only from here
        if (prepared.ready) sandboxCreates++;
      },
    },
  });
  expect(await dispatcher.run()).toBe("handled");
  return { progress, sandboxCreates, prepared, unauthenticated };
}

const engine = engineTgz();
const goodWorld = (over: Partial<World> = {}, plan: PlanFile = samplePlan()): World => {
  const sum = planBytes(plan);
  return {
    job: jobOf({}, { engine: { version: "1.2.3", commit_sha: COMMIT, tarball_url: `https://codeload.github.com${PATH_OK}`, tarball_sha256: sha(engine) }, plan_ref: { draft_id: DRAFT_ID, version: 2, sha256: sum.sha256 } }),
    planText: sum.text,
    routes: { [`codeload.github.com${PATH_OK}`]: sendBytes(engine) },
    ...over,
  };
};
const last = (p: SetupProgressBody[]): SetupProgressBody => p[p.length - 1]!;

describe("a good job", () => {
  it("reports engine_fetch then plan_fetch, started then ok, in order, and is ready with the rendered files and answers", async () => {
    const got = await runWorld(goodWorld());
    expect(got.progress.map((p) => [p.seq, p.sub_step, p.state])).toEqual([[0, "engine_fetch", "started"], [1, "engine_fetch", "ok"], [2, "plan_fetch", "started"], [3, "plan_fetch", "ok"]]);
    expect(got.sandboxCreates).toBe(1);
    expect(got.unauthenticated).toBe(0);
    const prepared = got.prepared;
    expect(prepared?.ready).toBe(true);
    if (!prepared?.ready) return;
    expect(prepared.files.map((f) => f.path)).toEqual(["docs/PRD.md", ".autonomous-team/roadmap.json", "epics/01-A1.md", "epics/02-B-2.md"]);
    // the epic headings came from the engine's own template inside the archive that was just verified
    expect(prepared.files[2]!.content).toContain("## Architecture");
    expect(prepared.host.name).toBe("widgets-service");
    expect(prepared.plan.draft_id).toBe(DRAFT_ID);
  });

  it("goes through the real github.com to codeload.github.com redirect", async () => {
    const world = goodWorld();
    world.routes = { "github.com/acme/engine/archive/x.tar.gz": redirectTo(`https://codeload.github.com${PATH_OK}`), ...world.routes };
    (world.job.args as { engine: { tarball_url: string } }).engine.tarball_url = "https://github.com/acme/engine/archive/x.tar.gz";
    expect((await runWorld(world)).sandboxCreates).toBe(1);
  });
});

describe("refusals: each is reported failed with a closed code, ends the job, and no sandbox is created", () => {
  it("a tampered tarball is engine_checksum", async () => {
    const world = goodWorld({ routes: { [`codeload.github.com${PATH_OK}`]: sendBytes(engineTgz([{ name: "engine-abc/evil", body: "x" }])) } });
    const got = await runWorld(world);
    expect(got.sandboxCreates).toBe(0);
    expect(last(got.progress)).toMatchObject({ sub_step: "engine_fetch", state: "failed", failure_code: "engine_checksum", failure_reason: "mismatch" });
    expect(got.progress.some((p) => p.sub_step === "plan_fetch")).toBe(false);
  });

  it("a redirect to another host is engine_archive_refused, and the other host is never asked", async () => {
    const world = goodWorld({ routes: { [`codeload.github.com${PATH_OK}`]: redirectTo("https://evil.example.com/e.tgz"), "evil.example.com/e.tgz": sendBytes(engine) } });
    const got = await runWorld(world);
    expect(got.sandboxCreates).toBe(0);
    expect(last(got.progress)).toMatchObject({ sub_step: "engine_fetch", state: "failed", failure_code: "engine_archive_refused", failure_reason: "host" });
    expect(https!.seen.map((r) => r.host)).toEqual(["codeload.github.com"]);
  });

  it("an engine that has no epic template is engine_archive_refused", async () => {
    const bare = (await import("../helpers/tarBuilder.js")).tgzOf([{ name: "engine-abc/readme", body: "x" }]);
    const world = goodWorld({ routes: { [`codeload.github.com${PATH_OK}`]: sendBytes(bare) } });
    (world.job.args as { engine: { tarball_sha256: string } }).engine.tarball_sha256 = sha(bare);
    expect(last((await runWorld(world)).progress)).toMatchObject({ failure_code: "engine_archive_refused", failure_reason: "epic_template" });
  });

  it("one wrong plan byte is plan_checksum, after the engine step finished ok", async () => {
    const good = goodWorld();
    const got = await runWorld({ ...good, planText: good.planText!.replace("Widgets", "Widgetz") });
    expect(got.sandboxCreates).toBe(0);
    expect(got.progress.map((p) => [p.sub_step, p.state])).toEqual([["engine_fetch", "started"], ["engine_fetch", "ok"], ["plan_fetch", "started"], ["plan_fetch", "failed"]]);
    expect(last(got.progress)).toMatchObject({ failure_code: "plan_checksum", failure_reason: "mismatch" });
  });

  it("a plan that hashes right but is not a strict PlanFile is plan_invalid, never parsed loosely", async () => {
    const odd = canonicalJson({ ...samplePlan(), extra: true });
    const world = goodWorld({ planText: odd });
    (world.job.args as { plan_ref: { sha256: string } }).plan_ref.sha256 = sha(odd);
    expect(last((await runWorld(world)).progress)).toMatchObject({ failure_code: "plan_invalid", failure_reason: "shape" });
    const notJson = "not json";
    const w2 = goodWorld({ planText: notJson });
    (w2.job.args as { plan_ref: { sha256: string } }).plan_ref.sha256 = sha(notJson);
    expect(last((await runWorld(w2)).progress)).toMatchObject({ failure_code: "plan_invalid", failure_reason: "json" });
  });

  it("a plan for another draft or version than the job names is plan_invalid", async () => {
    const other = canonicalJson(samplePlan({ draft_id: "11111111-1111-4111-8111-111111111111" }));
    const world = goodWorld({ planText: other });
    (world.job.args as { plan_ref: { sha256: string } }).plan_ref.sha256 = sha(other);
    expect(last((await runWorld(world)).progress)).toMatchObject({ failure_code: "plan_invalid", failure_reason: "mismatch" });
  });

  it("a plan the route will not give, or gives too big, is plan_fetch_failed", async () => {
    expect(last((await runWorld({ ...goodWorld(), planStatus: 404 })).progress)).toMatchObject({ failure_code: "plan_fetch_failed", failure_reason: "not_found" });
    expect(last((await runWorld({ ...goodWorld(), planStatus: 500 })).progress)).toMatchObject({ failure_code: "plan_fetch_failed", failure_reason: "request" });
    expect(last((await runWorld({ ...goodWorld(), planText: "x".repeat(1024 * 1024 + 1) })).progress)).toMatchObject({ failure_code: "plan_fetch_failed", failure_reason: "too_large" });
  });

  it("every report body is a valid protocol body and the failed step is a runner step", async () => {
    const got = await runWorld(goodWorld({ planStatus: 404 }));
    for (const p of got.progress) expect(SetupProgressBody.safeParse(p).success).toBe(true);
    expect(SETUP_RUNNER_STEPS).toContain(last(got.progress).sub_step);
  });
});

describe("kind_unsupported, through the whole path", () => {
  it("a job whose kind has no handler is reported failed / kind_unsupported and nothing is fetched", async () => {
    https = await startEngineHttps({});
    const progress: SetupProgressBody[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === MACHINE_JOB_CLAIM_PATH) return new Response(JSON.stringify({ signed_job: signedJob() }), { status: 200 });
      progress.push(SetupProgressBody.parse(JSON.parse(String(init.body))));
      return new Response(JSON.stringify({ recorded: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn });
    await createMachineJobDispatcher({ client, keyring: JOB_KEYRING, runnerId: RUNNER_ID, now: () => new Date(), handlers: {}, sandboxEngine: () => "microvm" }).run();
    expect(progress).toEqual([{ job_id: expect.any(String), seq: 0, sub_step: "engine_fetch", state: "failed", failure_code: "kind_unsupported" }]);
    expect(https.seen).toEqual([]);
  });
});
