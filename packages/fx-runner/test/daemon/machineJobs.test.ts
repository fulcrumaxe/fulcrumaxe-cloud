import { describe, expect, it } from "vitest";
import { SESSION_JOB_STEP_ORDER, SETUP_RUNNER_STEPS, SessionJobProgressBody, SetupProgressBody, type MachineJob } from "@fulcrumaxe/runner-protocol";
import type { MachineJobClaimResult, SetupProgressResult } from "../../src/daemon/client.js";
import { createMachineJobDispatcher, createSessionReporter, createStepReporter, effectiveEngine, type MachineJobEvent, type MachineJobHandlers } from "../../src/daemon/machineJobs.js";
import { JOB_KEYRING, OTHER_JOB_KEYRING, RUNNER_ID, SETUP_ID, jobOf, signedJob } from "../helpers/machineJobFixture.js";

/** D#845 ON-8c criteria: a one-at-a-time dispatcher on signed jobs; a kind with no handler is kind_unsupported; steps are reported in order and the last runner step `ok` ends the job. */
let engine: "os_sandbox" | "microvm" = "microvm";
function rig(claims: MachineJobClaimResult[], answers: Array<SetupProgressResult | "throw"> = []) {
  const progress: SetupProgressBody[] = [];
  const session: Array<SessionJobProgressBody & { job_id: string }> = [];
  const events: MachineJobEvent[] = [];
  let claimCalls = 0;
  const client = {
    async machineJobClaim(): Promise<MachineJobClaimResult> {
      return claims[claimCalls++] ?? { kind: "none", retryAfter: 60 };
    },
    async setupProgress(setupId: string, body: SetupProgressBody): Promise<SetupProgressResult> {
      expect(setupId).toBe(SETUP_ID);
      progress.push(body);
      const answer = answers.shift();
      if (answer === "throw") throw new Error("boom");
      return answer ?? { kind: "recorded" };
    },
    async machineJobProgress(jobId: string, body: SessionJobProgressBody): Promise<SetupProgressResult> {
      session.push({ ...body, job_id: jobId });
      const answer = answers.shift();
      if (answer === "throw") throw new Error("boom");
      return answer ?? { kind: "recorded" };
    },
  };
  const make = (handlers: MachineJobHandlers = {}, now: () => Date = () => new Date()) => createMachineJobDispatcher({ client, keyring: JOB_KEYRING, runnerId: RUNNER_ID, now, handlers, sandboxEngine: () => engine, log: (e) => events.push(e) });
  return { make, progress, session, events, claimCalls: () => claimCalls, client };
}

describe("the dispatcher", () => {
  it("a kind with no handler is reported failed / kind_unsupported, once, and the job is over", async () => {
    const r = rig([{ kind: "job", signedJob: signedJob() }]);
    expect(await r.make().run()).toBe("handled");
    expect(r.progress).toHaveLength(1);
    expect(r.progress[0]).toMatchObject({ seq: 0, sub_step: SETUP_RUNNER_STEPS[0], state: "failed", failure_code: "kind_unsupported" });
    expect(SetupProgressBody.safeParse(r.progress[0]).success).toBe(true);
    expect(r.events).toEqual([{ event: "unsupported", kind: "project_setup" }, { event: "ended", kind: "project_setup" }]);
  });

  it("every other kind with no handler is unsupported too; a session kind is reported on the machine-job route by its job id, on `admission`, and never on a setup", async () => {
    const withSetup = jobOf({ kind: "engine_update" }, {});
    const update = { ...withSetup, args: { engine: (withSetup.args as { engine: unknown }).engine, branch: "fx/engine-update-1.2.4" } } as MachineJob;
    const stop = { ...jobOf({ kind: "engine_session_stop", setup_id: undefined }), args: { reason: "person", operate_epoch: 0 } } as MachineJob;
    const r = rig([{ kind: "job", signedJob: signedJob(update) }, { kind: "job", signedJob: signedJob(stop) }]);
    const d = r.make();
    await d.run();
    await d.run();
    expect(r.progress.map((p) => p.failure_code)).toEqual(["kind_unsupported"]);
    expect(r.session).toEqual([{ job_id: stop.job_id, seq: 0, step: "admission", state: "failed", failure_code: "kind_unsupported" }]);
    const wire = Object.fromEntries(Object.entries(r.session[0] as object).filter(([key]) => key !== "job_id"));
    expect(SessionJobProgressBody.safeParse(wire).success).toBe(true);
    expect(r.events.filter((e) => e.event === "unsupported").map((e) => (e as { kind: string }).kind)).toEqual(["engine_update", "engine_session_stop"]);
  });

  it("a session job refused for its engine reports `admission` failed / engine_unsupported on the machine-job route", async () => {
    engine = "os_sandbox";
    const start = { ...jobOf({ kind: "engine_session_start", requires_engine: "microvm" }), args: { at_sha: "a".repeat(40), resume: false, operate_epoch: 1 } } as MachineJob;
    const r = rig([{ kind: "job", signedJob: signedJob(start) }]);
    let ran = false;
    await r.make({ engine_session_start: async () => void (ran = true) }).run();
    engine = "microvm";
    expect(ran).toBe(false);
    expect(r.progress).toEqual([]);
    expect(r.session).toMatchObject([{ step: "admission", state: "failed", failure_code: "engine_unsupported", failure_reason: "engine_mismatch" }]);
  });

  it("hands a verified job to the handler of its kind, with a reporter and a signal, and nothing else", async () => {
    const r = rig([{ kind: "job", signedJob: signedJob() }]);
    let seen: unknown;
    await r.make({
      project_setup: async (context) => {
        seen = { keys: Object.keys(context).sort(), kind: context.job.kind };
        await context.reporter.report({ sub_step: "engine_fetch", state: "started" });
      },
    }).run();
    expect(seen).toEqual({ keys: ["job", "reporter", "signal"], kind: "project_setup" });
    expect(r.progress).toHaveLength(1);
  });

  it("works one job at a time: a second run while one is in hand takes nothing and never even claims", async () => {
    const r = rig([{ kind: "job", signedJob: signedJob() }, { kind: "job", signedJob: signedJob() }]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const d = r.make({ project_setup: async () => void (await held) });
    const first = d.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(d.setupsRunning()).toBe(1);
    expect(await d.run()).toBe("none");
    expect(r.claimCalls()).toBe(1);
    release();
    expect(await first).toBe("handled");
    expect(d.setupsRunning()).toBe(0);
    // and it takes the next one once the first is over
    expect(await d.run()).toBe("handled");
    expect(r.claimCalls()).toBe(2);
  });

  it("nothing waiting, or the cloud unreachable, is none", async () => {
    expect(await rig([{ kind: "none", retryAfter: 60 }]).make().run()).toBe("none");
    expect(await rig([{ kind: "error", status: 0 }]).make().run()).toBe("none");
  });

  it("a handler that throws is logged as a closed event, never reported, and the next job can be taken", async () => {
    const r = rig([{ kind: "job", signedJob: signedJob() }, { kind: "job", signedJob: signedJob() }]);
    const d = r.make({ project_setup: async () => { throw new Error("secret path /home/x"); } });
    expect(await d.run()).toBe("handled");
    expect(r.progress).toHaveLength(0);
    expect(JSON.stringify(r.events)).not.toContain("secret");
    expect(r.events[0]).toEqual({ event: "handler_error", kind: "project_setup" });
    expect(await d.run()).toBe("handled");
  });

  it("stops taking jobs once the daemon is stopping", async () => {
    const stop = new AbortController();
    stop.abort();
    const r = rig([{ kind: "job", signedJob: signedJob() }]);
    const d = createMachineJobDispatcher({ client: r.client, keyring: JOB_KEYRING, runnerId: RUNNER_ID, now: () => new Date(), handlers: {}, sandboxEngine: () => "microvm", signal: stop.signal });
    expect(await d.run()).toBe("none");
    expect(r.claimCalls()).toBe(0);
  });
});

describe("the engine a job requires (Ruling 46)", () => {
  it("an os_sandbox runner given a microVM-only job reports a closed code and runs nothing, even with a handler for the kind; a microVM runner, or an `any` job, runs", async () => {
    const need = (requires_engine: string) => signedJob(jobOf({ requires_engine }));
    for (const [have, requires, runs] of [["os_sandbox", "microvm", false], ["microvm", "microvm", true], ["os_sandbox", "any", true]] as const) {
      engine = have;
      const r = rig([{ kind: "job", signedJob: need(requires) }]);
      let ran = false;
      await r.make({ project_setup: async () => void (ran = true) }).run();
      expect(ran, `${have}/${requires}`).toBe(runs);
      if (!runs) {
        expect(r.progress).toHaveLength(1);
        expect(r.progress[0]).toMatchObject({ state: "failed", failure_code: "engine_unsupported", failure_reason: "engine_mismatch" });
        expect(r.events[0]).toEqual({ event: "engine_mismatch", kind: "project_setup" });
      }
    }
    engine = "microvm";
  });
});

describe("the engine a run really has", () => {
  it("is microvm only when the run's chosen engine AND the setting both say so", () => {
    expect(effectiveEngine("microvm", "microvm")).toBe("microvm");
    expect(effectiveEngine("microvm", "os_sandbox")).toBe("os_sandbox");
    expect(effectiveEngine("microvm", undefined)).toBe("os_sandbox");
    expect(effectiveEngine("microvm", "invalid")).toBe("os_sandbox");
    expect(effectiveEngine("os_sandbox", "microvm")).toBe("os_sandbox");
  });
});

describe("a job is verified with the runner's keyring before anything is read from it", () => {
  const dropped = async (signed: unknown, over: { keyring?: typeof JOB_KEYRING; runnerId?: string; now?: () => Date } = {}) => {
    const r = rig([{ kind: "job", signedJob: signed as never }]);
    let ran = false;
    const d = createMachineJobDispatcher({ client: r.client, keyring: over.keyring ?? JOB_KEYRING, runnerId: over.runnerId ?? RUNNER_ID, now: over.now ?? (() => new Date()), handlers: { project_setup: async () => void (ran = true) }, sandboxEngine: () => "microvm", log: (e) => r.events.push(e) });
    expect(await d.run()).toBe("handled");
    return { ran, progress: r.progress, events: r.events };
  };

  it("another key, another runner, a changed byte and an expired job are each dropped: no handler, no report", async () => {
    for (const result of [
      await dropped(signedJob(), { keyring: OTHER_JOB_KEYRING }),
      await dropped(signedJob(), { runnerId: "11111111-1111-4111-8111-111111111111" }),
      await dropped({ ...signedJob(), job: { ...signedJob().job, repo_gh_id: 78 } }),
      await dropped(signedJob(), { now: () => new Date(Date.now() + 3_600_000) }),
      await dropped({ job: signedJob().job }),
    ]) {
      expect(result.ran).toBe(false);
      expect(result.progress).toEqual([]);
      expect(result.events[0]).toMatchObject({ event: "dropped" });
    }
  });

  it("the drop event carries only the closed code", async () => {
    const { events } = await dropped(signedJob(), { keyring: OTHER_JOB_KEYRING });
    expect(events).toEqual([{ event: "dropped", code: "bad_signature" }]);
  });
});

describe("the step reporter", () => {
  function reporterRig(answers: Array<SetupProgressResult | "throw"> = []) {
    const r = rig([], answers);
    const ended = new AbortController();
    return { ...r, ended, reporter: createStepReporter({ client: r.client }, jobOf(), ended) };
  }

  it("numbers every report from 0, in order, and builds only protocol-valid bodies", async () => {
    const r = reporterRig();
    await r.reporter.report({ sub_step: "engine_fetch", state: "started" });
    await r.reporter.report({ sub_step: "engine_fetch", state: "ok" });
    await r.reporter.report({ sub_step: "plan_fetch", state: "started" });
    await r.reporter.report({ sub_step: "plan_fetch", state: "failed", failure_code: "plan_checksum", failure_reason: "mismatch" });
    expect(r.progress.map((p) => [p.seq, p.sub_step, p.state])).toEqual([[0, "engine_fetch", "started"], [1, "engine_fetch", "ok"], [2, "plan_fetch", "started"], [3, "plan_fetch", "failed"]]);
    for (const body of r.progress) expect(SetupProgressBody.safeParse(body).success).toBe(true);
  });

  it("the runner's own steps never go back; coldstart steps between them are free", async () => {
    const r = reporterRig();
    await r.reporter.report({ sub_step: "workspace_in", state: "ok" });
    await r.reporter.report({ sub_step: "preflight", state: "ok" });
    await r.reporter.report({ sub_step: "bootstrap", state: "ok" });
    await expect(r.reporter.report({ sub_step: "engine_fetch", state: "started" })).rejects.toThrow("step_order");
    expect(r.progress.map((p) => p.sub_step)).toEqual(["workspace_in", "preflight", "bootstrap"]);
  });

  it("the job ends on its last runner step ok: nothing more is sent and the signal aborts", async () => {
    const r = reporterRig();
    const last = SETUP_RUNNER_STEPS[SETUP_RUNNER_STEPS.length - 1]!;
    await r.reporter.report({ sub_step: last, state: "started" });
    expect(r.reporter.closed).toBe(false);
    expect(await r.reporter.report({ sub_step: last, state: "ok" })).toBe("recorded");
    expect(r.reporter.closed).toBe(true);
    expect(r.ended.signal.aborted).toBe(true);
    expect(await r.reporter.report({ sub_step: last, state: "ok" })).toBe("closed");
    expect(r.progress).toHaveLength(2);
  });

  it("a failed step ends the job too", async () => {
    const r = reporterRig();
    await r.reporter.report({ sub_step: "bootstrap", state: "failed", failure_code: "bootstrap_failed" });
    expect(r.reporter.closed).toBe(true);
    expect(await r.reporter.report({ sub_step: "finalize", state: "started" })).toBe("closed");
    expect(r.progress).toHaveLength(1);
  });

  it("a refusal from the cloud (superseded, not running, 404) closes the job and aborts the handler's signal", async () => {
    for (const answer of [{ kind: "refused", status: 409, code: "job_superseded" }, { kind: "refused", status: 409, code: "job_not_active" }, { kind: "refused", status: 404 }] as const) {
      const r = reporterRig([answer]);
      expect(await r.reporter.report({ sub_step: "engine_fetch", state: "started" })).toBe("closed");
      expect(r.ended.signal.aborted).toBe(true);
      expect(await r.reporter.report({ sub_step: "engine_fetch", state: "ok" })).toBe("closed");
      expect(r.progress).toHaveLength(1);
    }
  });

  it("a report that got no answer is tried again with the same number; a second try the cloud says is not above the last means the first got through", async () => {
    const r = reporterRig([{ kind: "error", status: 0 }, { kind: "refused", status: 409, code: "seq_not_increasing" }]);
    expect(await r.reporter.report({ sub_step: "engine_fetch", state: "started" })).toBe("recorded");
    expect(r.progress.map((p) => p.seq)).toEqual([0, 0]);
    // the next report moves on
    await r.reporter.report({ sub_step: "engine_fetch", state: "ok" });
    expect(r.progress.map((p) => p.seq)).toEqual([0, 0, 1]);
    expect(r.reporter.closed).toBe(false);
  });

  it("a first try the cloud calls out of order is a refusal, not a duplicate", async () => {
    const r = reporterRig([{ kind: "refused", status: 409, code: "seq_not_increasing" }]);
    expect(await r.reporter.report({ sub_step: "engine_fetch", state: "started" })).toBe("closed");
  });

  it("three tries with no answer is lost, and the job goes on", async () => {
    const r = reporterRig([{ kind: "error", status: 503 }, { kind: "error", status: 503 }, { kind: "error", status: 503 }]);
    expect(await r.reporter.report({ sub_step: "engine_fetch", state: "started" })).toBe("lost");
    expect(r.reporter.closed).toBe(false);
    expect(r.progress).toHaveLength(3);
  });

  it("a reason that is not a closed word is never sent", async () => {
    const r = reporterRig();
    await expect(r.reporter.report({ sub_step: "bootstrap", state: "failed", failure_code: "bootstrap_failed", failure_reason: "/home/x: no such file" })).rejects.toThrow("failure_reason");
    expect(r.progress).toEqual([]);
  });
});

describe("the session reporter", () => {
  type Kind = "engine_session_start" | "engine_session_stop" | "engine_session_delete";
  const sessionJob = (kind: Kind) =>
    ({ ...jobOf({ kind, setup_id: undefined }), args: kind === "engine_session_start" ? { at_sha: "a".repeat(40), resume: true, operate_epoch: 3 } : kind === "engine_session_stop" ? { reason: "person", operate_epoch: 3 } : { operate_epoch: 3 } }) as never;
  function sessionRig(kind: Kind, answers: Array<SetupProgressResult | "throw"> = []) {
    const r = rig([], answers);
    const ended = new AbortController();
    return { ...r, ended, reporter: createSessionReporter({ client: r.client }, sessionJob(kind), ended) };
  }
  const wire = (body: SessionJobProgressBody & { job_id: string }) => {
    return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "job_id"));
  };

  it("numbers every report from 0 under the job's own id, builds only protocol-valid bodies, and never calls the setup route", async () => {
    const r = sessionRig("engine_session_stop");
    await r.reporter.report({ step: "admission", state: "started" });
    await r.reporter.report({ step: "admission", state: "ok" });
    await r.reporter.report({ step: "session_stop", state: "skipped" });
    expect(r.session.map((p) => [p.seq, p.step, p.state])).toEqual([[0, "admission", "started"], [1, "admission", "ok"], [2, "session_stop", "skipped"]]);
    expect(new Set(r.session.map((p) => p.job_id)).size).toBe(1);
    for (const body of r.session) expect(SessionJobProgressBody.safeParse(wire(body)).success).toBe(true);
    expect(r.progress).toEqual([]);
  });

  it("a step may be skipped but never gone back to, and a step outside the kind's own list throws step_order", async () => {
    const r = sessionRig("engine_session_start");
    await r.reporter.report({ step: "session_create", state: "ok" });
    await r.reporter.report({ step: "session_boot", state: "ok" }); // seed skipped
    await expect(r.reporter.report({ step: "seed", state: "started" })).rejects.toThrow("step_order");
    await expect(r.reporter.report({ step: "snapshot", state: "started" })).rejects.toThrow("step_order");
    expect(r.session.map((p) => p.step)).toEqual(["session_create", "session_boot"]);
    for (const kind of ["engine_session_start", "engine_session_stop", "engine_session_delete"] as const) {
      const k = sessionRig(kind);
      for (const step of SESSION_JOB_STEP_ORDER[kind]) if (step !== "done") await k.reporter.report({ step, state: "ok" });
      expect(k.reporter.closed, kind).toBe(false);
    }
  });

  it("a start ends on `done` ok, which carries its start mode and nothing else does; the job's signal aborts and nothing more is sent", async () => {
    const r = sessionRig("engine_session_start");
    await expect(r.reporter.report({ step: "done", state: "ok" })).rejects.toThrow("start_mode");
    await expect(r.reporter.report({ step: "session_boot", state: "ok", start_mode: "fresh" })).rejects.toThrow("start_mode");
    expect(await r.reporter.report({ step: "done", state: "ok", start_mode: "fresh" })).toBe("recorded");
    expect(r.session.at(-1)).toMatchObject({ step: "done", state: "ok", start_mode: "fresh" });
    expect(r.reporter.closed).toBe(true);
    expect(r.ended.signal.aborted).toBe(true);
    expect(await r.reporter.report({ step: "done", state: "ok", start_mode: "fresh" })).toBe("closed");
    const stop = sessionRig("engine_session_stop");
    await expect(stop.reporter.report({ step: "done", state: "ok", start_mode: "created" })).rejects.toThrow("start_mode");
  });

  it("a failed report ends the job; a refusal from the cloud closes it; the retry rule is the setup reporter's", async () => {
    const failed = sessionRig("engine_session_delete");
    await failed.reporter.report({ step: "session_delete", state: "failed", failure_code: "vm_teardown_incomplete" });
    expect(failed.reporter.closed).toBe(true);
    expect(await failed.reporter.report({ step: "done", state: "ok" })).toBe("closed");
    const refused = sessionRig("engine_session_stop", [{ kind: "refused", status: 409, code: "job_not_active" }]);
    expect(await refused.reporter.report({ step: "admission", state: "started" })).toBe("closed");
    expect(refused.ended.signal.aborted).toBe(true);
    const retried = sessionRig("engine_session_stop", [{ kind: "error", status: 0 }, { kind: "refused", status: 409, code: "seq_not_increasing" }]);
    expect(await retried.reporter.report({ step: "admission", state: "started" })).toBe("recorded");
    expect(retried.session.map((p) => p.seq)).toEqual([0, 0]);
    const lost = sessionRig("engine_session_stop", [{ kind: "error", status: 503 }, { kind: "error", status: 503 }, { kind: "error", status: 503 }]);
    expect(await lost.reporter.report({ step: "admission", state: "started" })).toBe("lost");
    expect(lost.reporter.closed).toBe(false);
  });

  it("a reason that is not a closed word is never sent", async () => {
    const r = sessionRig("engine_session_start");
    await expect(r.reporter.report({ step: "seed", state: "failed", failure_code: "vm_workspace_failed", failure_reason: "/srv/fixture-a: no" })).rejects.toThrow("failure_reason");
    expect(r.session).toEqual([]);
  });
});
