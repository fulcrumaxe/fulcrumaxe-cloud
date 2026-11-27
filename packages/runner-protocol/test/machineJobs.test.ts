import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENGINE_COMMAND_PURPOSE, signEngineCommand } from "../src/engineCommands.js";
import { JobSignatureError, canonicalJson } from "../src/jobSignature.js";
import { HelloMessage, MACHINE_ONBOARDING_MIN_PROTOCOL, MIN_SUPPORTED_PROTOCOL_VERSION } from "../src/messages.js";
import { COLDSTART_STEPS } from "../src/coldstartStatus.js";
import { PLANE_REFUSAL_CODES } from "../src/planePush/planePushRoute.js";
import { MACHINE_JOB_CAPABILITY, MACHINE_JOB_KINDS, MACHINE_JOB_MAX_LIFE_S, ENGINE_TARBALL_HOSTS, MachineJob, MachineJobClaimMessage, MachineJobClaimReply, MACHINE_JOB_FINAL_STEP, SETUP_FAILURE_CODES, SETUP_RUNNER_STEPS, SETUP_SUB_STEPS, SetupProgressBody, ENGINE_STOP_REASONS, SESSION_FAILURE_CODES, SESSION_JOB_KINDS, SESSION_JOB_STEPS, SESSION_JOB_STEP_ORDER, SESSION_START_MODES, SessionJobProgressBody, machineJobProgressPath, deviceFlowOffered, isEngineTarballUrl, loginCommandOffered, machineJobOffered, signMachineJob, taskKindOffered, verifyMachineJob, type MachineJob as Job, type RunnerOffer } from "../src/machineJobs.js";
import { DEVICE_REGISTER_CAPABILITY, ENGINE_SESSION_CAPABILITY, MACHINE_LOGIN_CAPABILITY, PROJECT_SETUP_CAPABILITY, REPO_TOKEN_REFRESH_CAPABILITY, RUNNER_CAPABILITIES, SURVEY_CAPABILITY, TASK_KINDS, TASK_KIND_CAPABILITY } from "../src/job.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const NOW = new Date("2026-11-18T15:00:00Z");
const RUNNER = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const ID = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const SHA = "a".repeat(40);
const HEX = "b".repeat(64);
const at = (s: number): string => new Date(NOW.getTime() + s * 1000).toISOString();
const ENGINE = { version: "1.2.3", commit_sha: SHA, tarball_url: "https://codeload.github.com/acme/engine/tar.gz/refs/tags/v1.2.3", tarball_sha256: HEX };
const base = { v: 1, job_id: ID, runner_id: RUNNER, repo_gh_id: 77, requires_engine: "any", issued_at: at(0), expires_at: at(600) };
const ARGS: Record<string, unknown> = {
  project_setup: { mode: "pr", base_sha: SHA, engine: ENGINE, plan_ref: { draft_id: ID, version: 2, sha256: HEX }, branch: "fx/engine-install-1.2.3" },
  engine_update: { engine: ENGINE, branch: "fx/engine-update-1.2.4" },
  engine_session_start: { at_sha: SHA, resume: false, operate_epoch: 1 },
  engine_session_stop: { reason: "person", operate_epoch: 0 },
  engine_session_delete: { operate_epoch: 0 },
  project_remove: { delete_sandbox: true, removal_pr: false },
  twin_seed: { twin_id: ID, public: { owner: "acme", name: "widgets", gh_id: 78, default_branch: "main", head_sha: SHA }, private: { owner: "acme", name: "widgets-private", gh_id: 77 } },
  twin_publish: { twin_id: ID, public: { owner: "acme", name: "widgets", gh_id: 78, tip: SHA }, private: { owner: "acme", name: "widgets-private", gh_id: 77, base: SHA, head: "c".repeat(40) }, branch: `fx/publish-${"c".repeat(12)}`, private_set: { overlay_globs: ["docs/private/**"], install_paths: [".github/workflows/engine.yml"], blob_globs: ["assets/**"], identifier_rules_path: ".autonomous-team/ids.json", plan_data_rules_path: null } },
};
const jobOf = (kind: string, over: Record<string, unknown> = {}): Job => ({ ...base, ...(kind === "twin_seed" || kind === "twin_publish" ? { setup_id: ID } : {}), kind, args: ARGS[kind], ...over }) as Job;
const failsWith = (run: () => unknown, code: string): void => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(JobSignatureError);
    expect((error as JobSignatureError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};
const ok = (value: unknown): boolean => MachineJob.safeParse(value).success;

describe("machine job schema", () => {
  it("parses every kind, and a kind is only ever given its own args", () => {
    for (const kind of MACHINE_JOB_KINDS) {
      expect(ok(jobOf(kind)), kind).toBe(true);
      for (const wrong of MACHINE_JOB_KINDS) if (wrong !== kind && JSON.stringify(ARGS[wrong]) !== JSON.stringify(ARGS[kind])) expect(ok(jobOf(kind, { args: ARGS[wrong] })), `${kind} with ${wrong} args`).toBe(false);
    }
    expect(ok(jobOf("project_setup", { setup_id: ID }))).toBe(true);
  });
  it("holds a twin seed to its one target: the private twin, through the twin's setup, on no engine", () => {
    const args = ARGS["twin_seed"] as { public: Record<string, unknown>; private: Record<string, unknown> };
    // the job names the PUBLIC repository as its own repository, or the twin's gh id is not the job's
    expect(ok(jobOf("twin_seed", { repo_gh_id: 78 }))).toBe(false);
    expect(ok(jobOf("twin_seed", { repo_gh_id: 99 }))).toBe(false);
    expect(ok(jobOf("twin_seed", { args: { ...args, public: { ...args.public, gh_id: 77 } } }))).toBe(false);
    expect(ok(jobOf("twin_seed", { setup_id: undefined }))).toBe(false);
    expect(ok(jobOf("twin_seed", { requires_engine: "microvm" }))).toBe(false);
    // the closed shapes: owner, name, branch and commit are held to GitHub's, nothing else is carried
    for (const bad of [{ owner: "-acme" }, { owner: "a/b" }, { name: ".." }, { name: "a b" }, { default_branch: "../main" }, { default_branch: "main.lock" }, { default_branch: "-x" }, { head_sha: "abc" }, { head_sha: SHA.toUpperCase() }, { token: "x" }]) expect(ok(jobOf("twin_seed", { args: { ...args, public: { ...args.public, ...bad } } })), JSON.stringify(bad)).toBe(false);
    expect(ok(jobOf("twin_seed", { args: { ...args, private: { ...args.private, owner: "a b" } } }))).toBe(false);
    expect(ok(jobOf("twin_seed", { args: { ...args, private: { ...args.private, default_branch: "main" } } }))).toBe(false);
    expect(ok(jobOf("twin_seed", { args: { ...args, repo: "acme/other" } }))).toBe(false);
    expect(ok(jobOf("twin_seed", { args: { ...args, public: { ...args.public, default_branch: "release/1.x" } } }))).toBe(true);
  });
  it("holds a twin publish to its one home: the private twin through its setup, going from its base to its head, on a branch named from the head", () => {
    const args = ARGS["twin_publish"] as { public: Record<string, unknown>; private: Record<string, unknown>; private_set: Record<string, unknown> };
    expect(ok(jobOf("twin_publish"))).toBe(true);
    // the job names the PUBLIC repository as its own, or the twin's gh id is not the job's, or the two repositories are one
    expect(ok(jobOf("twin_publish", { repo_gh_id: 78 }))).toBe(false);
    expect(ok(jobOf("twin_publish", { repo_gh_id: 99 }))).toBe(false);
    expect(ok(jobOf("twin_publish", { args: { ...args, public: { ...args.public, gh_id: 77 } } }))).toBe(false);
    expect(ok(jobOf("twin_publish", { setup_id: undefined }))).toBe(false);
    expect(ok(jobOf("twin_publish", { requires_engine: "microvm" }))).toBe(false);
    // a publish that goes nowhere, and a branch that is not the head's
    expect(ok(jobOf("twin_publish", { args: { ...args, private: { ...args.private, base: "c".repeat(40) } } }))).toBe(false);
    for (const branch of ["main", "fx/publish-" + "d".repeat(12), "fx/publish-" + "c".repeat(11), "fx/publish-" + "c".repeat(13), "../fx/publish-" + "c".repeat(12)]) expect(ok(jobOf("twin_publish", { args: { ...args, branch } })), branch).toBe(false);
    // the closed shapes: the public tip and the commits are full ids, the set's lists are bounded, and nothing else is carried
    for (const bad of [{ tip: "abc" }, { tip: SHA.toUpperCase() }, { owner: "a/b" }, { token: "x" }]) expect(ok(jobOf("twin_publish", { args: { ...args, public: { ...args.public, ...bad } } })), JSON.stringify(bad)).toBe(false);
    for (const bad of [{ overlay_globs: Array.from({ length: 101 }, (_, n) => `a${n}`) }, { install_paths: Array.from({ length: 5001 }, (_, n) => `a${n}`) }, { blob_globs: [""] }, { identifier_rules_path: "" }, { extra: 1 }]) expect(ok(jobOf("twin_publish", { args: { ...args, private_set: { ...args.private_set, ...bad } } })), JSON.stringify(bad).slice(0, 40)).toBe(false);
    expect(ok(jobOf("twin_publish", { args: { ...args, token: "x" } }))).toBe(false);
  });
  it("lists every refusal the push route can throw as a failure code a publish may report", () => {
    for (const code of PLANE_REFUSAL_CODES) expect(SETUP_FAILURE_CODES as readonly string[], code).toContain(code);
  });
  it("gives the seed its own steps and codes, and the seed's capability goes to no build yet", () => {
    expect(SETUP_RUNNER_STEPS.indexOf("twin_fetch")).toBeLessThan(SETUP_RUNNER_STEPS.indexOf("push"));
    expect(SETUP_RUNNER_STEPS[0]).toBe("engine_fetch");
    for (const code of ["twin_head_moved", "twin_too_large", "twin_not_empty", "twin_fetch_failed"]) expect(SETUP_FAILURE_CODES).toContain(code);
    expect(MACHINE_JOB_FINAL_STEP["twin_seed"]).toBeUndefined();
    expect(RUNNER_CAPABILITIES).toContain("twin_v1");
  });
  it("refuses an extra key at every depth", () => {
    expect(ok(jobOf("project_setup", { extra: 1 }))).toBe(false);
    for (const kind of MACHINE_JOB_KINDS) expect(ok(jobOf(kind, { args: { ...(ARGS[kind] as object), extra: 1 } })), `${kind} args`).toBe(false);
    const setup = ARGS["project_setup"] as Record<string, unknown>;
    expect(ok(jobOf("project_setup", { args: { ...setup, engine: { ...ENGINE, extra: 1 } } }))).toBe(false);
    expect(ok(jobOf("project_setup", { args: { ...setup, plan_ref: { draft_id: ID, version: 2, sha256: HEX, extra: 1 } } }))).toBe(false);
    expect(ok(jobOf("engine_update", { args: { engine: { ...ENGINE, extra: 1 }, branch: "fx/engine-update-1.2.4" } }))).toBe(false);
  });
  it("holds the install and update branches to their patterns", () => {
    const setup = ARGS["project_setup"] as Record<string, unknown>;
    for (const branch of ["fx/engine-install-1.2", "fx/engine-install-1.2.3/x", "fx/engine-install-1.2.3 ", "fx/engine-install-a.b.c", "fx/engine-update-1.2.3", "main", "fx/engine-install-" + "1".repeat(21), "fx/engine-install-1.2.3\n"]) expect(ok(jobOf("project_setup", { args: { ...setup, branch } })), branch).toBe(false);
    for (const branch of ["fx/engine-update-1.2", "fx/engine-install-1.2.4", "fx/engine-update-1.2.3/../x", "origin/fx/engine-update-1.2.4"]) expect(ok(jobOf("engine_update", { args: { engine: ENGINE, branch } })), branch).toBe(false);
  });
  it("refuses a tarball outside the allowed hosts, and every URL trick", () => {
    expect([...ENGINE_TARBALL_HOSTS]).toEqual(["codeload.github.com", "github.com"]);
    for (const url of ["https://codeload.github.com/acme/engine/tar.gz/v1", "https://github.com/acme/engine/archive/v1.tar.gz"]) expect(isEngineTarballUrl(url), url).toBe(true);
    for (const url of ["https://evil.example/acme/engine.tar.gz", "https://github.com.evil.example/a/b", "https://github.com@evil.example/a/b", "https://user:pw@github.com/a/b", "http://github.com/a/b", "https://github.com:8443/a/b", "https://github.com/a/b?x=1", "https://github.com/a/b#x", "https://github.com/a/../b", "https://GITHUB.COM/a/b", "https://api.github.com/a/b", "https://raw.githubusercontent.com/a/b", "ftp://github.com/a/b", "https://github.com", "https://github.com/a/b " , "https://github.com/" + "a".repeat(300), "javascript:alert(1)", "file:///etc/passwd"]) expect(isEngineTarballUrl(url), url).toBe(false);
    const setup = ARGS["project_setup"] as Record<string, unknown>;
    expect(ok(jobOf("project_setup", { args: { ...setup, engine: { ...ENGINE, tarball_url: "https://evil.example/x" } } }))).toBe(false);
  });
  it("holds ids, shas and the engine requirement to their shapes", () => {
    expect(ok(jobOf("engine_session_stop", { requires_engine: "microvm" }))).toBe(true);
    expect(ok(jobOf("engine_session_stop", { requires_engine: "any " }))).toBe(false);
    expect(ok(jobOf("engine_session_stop", { requires_engine: "os_sandbox" }))).toBe(false);
    expect(ok(jobOf("engine_session_stop", { repo_gh_id: 0 }))).toBe(false);
    expect(ok(jobOf("engine_session_stop", { job_id: "x" }))).toBe(false);
    expect(ok(jobOf("engine_session_start", { args: { at_sha: "A".repeat(40), resume: true, operate_epoch: 1 } }))).toBe(false);
    expect(ok(jobOf("engine_session_start", { args: { at_sha: SHA, resume: "yes", operate_epoch: 1 } }))).toBe(false);
    expect(ok(jobOf("engine_session_stop", { args: { reason: "crash", operate_epoch: 0 } }))).toBe(false);
    expect(ok(jobOf("engine_update", { args: { engine: { ...ENGINE, version: "1.2" }, branch: "fx/engine-update-1.2.4" } }))).toBe(false);
  });
  it("lives at most 30 minutes, and never a negative life", () => {
    expect(MACHINE_JOB_MAX_LIFE_S).toBe(1800);
    expect(ok(jobOf("project_remove", { expires_at: at(1800) }))).toBe(true);
    expect(ok(jobOf("project_remove", { expires_at: at(1801) }))).toBe(false);
    expect(ok(jobOf("project_remove", { expires_at: at(0) }))).toBe(false);
    expect(ok(jobOf("project_remove", { expires_at: at(-5) }))).toBe(false);
  });
});

describe("verifyMachineJob", () => {
  const signed = (job: Job = jobOf("project_remove")) => signMachineJob(job, "job-key-1", privateKey);
  it("returns the job it signed", () => {
    for (const kind of MACHINE_JOB_KINDS) expect(verifyMachineJob(signMachineJob(jobOf(kind), "job-key-1", privateKey), keyring, RUNNER, NOW)).toEqual(jobOf(kind));
  });
  it("rejects a flipped byte anywhere in the signed job as bad_signature", () => {
    const s = signed(jobOf("engine_session_start"));
    failsWith(() => verifyMachineJob({ ...s, job: { ...s.job, repo_gh_id: 78 } }, keyring, RUNNER, NOW), "bad_signature");
    failsWith(() => verifyMachineJob({ ...s, job: { ...s.job, args: { at_sha: "b".repeat(40), resume: false, operate_epoch: 1 } } }, keyring, RUNNER, NOW), "bad_signature");
    failsWith(() => verifyMachineJob({ ...s, job: { ...s.job, requires_engine: "microvm" } }, keyring, RUNNER, NOW), "bad_signature");
    const flipped = s.signature.slice(0, 5) + (s.signature[5] === "A" ? "B" : "A") + s.signature.slice(6);
    failsWith(() => verifyMachineJob({ ...s, signature: flipped }, keyring, RUNNER, NOW), "bad_signature");
  });
  it("rejects a job signed by another key, for another runner, expired, future-issued or too long", () => {
    failsWith(() => verifyMachineJob(signMachineJob(jobOf("project_remove"), "job-key-1", other.privateKey), keyring, RUNNER, NOW), "bad_signature");
    failsWith(() => verifyMachineJob(signed(), keyring, "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", NOW), "bad_signature");
    failsWith(() => verifyMachineJob(signed(), { "other-key": publicKey }, RUNNER, NOW), "unknown_key_id");
    failsWith(() => verifyMachineJob(signed(), keyring, RUNNER, new Date(NOW.getTime() + 601_000)), "expired");
    failsWith(() => verifyMachineJob(signed(jobOf("project_remove", { issued_at: at(200), expires_at: at(500) })), keyring, RUNNER, NOW), "expired");
    // A job signed with a life over 30 minutes by a holder of the key is still refused: the schema is part of the check.
    const long = jobOf("project_remove", { expires_at: at(1801) });
    const signature = sign(null, Buffer.from(canonicalJson(long), "utf8"), privateKey).toString("base64url");
    failsWith(() => verifyMachineJob({ job: long, key_id: "job-key-1", signature }, keyring, RUNNER, NOW), "malformed");
  });
  it("reports a missing or malformed signature and a non-object, and never throws anything else", () => {
    const s = signed();
    failsWith(() => verifyMachineJob({ job: s.job, key_id: s.key_id }, keyring, RUNNER, NOW), "missing_signature");
    failsWith(() => verifyMachineJob({ ...s, signature: "short" }, keyring, RUNNER, NOW), "malformed");
    failsWith(() => verifyMachineJob({ ...s, extra: 1 }, keyring, RUNNER, NOW), "malformed");
    for (const junk of [null, 5, "x", [], undefined]) failsWith(() => verifyMachineJob(junk, keyring, RUNNER, NOW), "malformed");
  });
  it("is not a command, a run job or a sandbox command: a signature over one never verifies as another", () => {
    const command = signEngineCommand({ v: 1, purpose: ENGINE_COMMAND_PURPOSE, command_id: ID, command_seq: 1, runner_id: RUNNER, repo_gh_id: 77, issued_by: ID, issued_at: at(0), expires_at: at(300), halt_epoch: 0, kind: "start_day", args: {} }, "job-key-1", privateKey);
    failsWith(() => verifyMachineJob(command, keyring, RUNNER, NOW), "malformed");
    failsWith(() => verifyMachineJob({ job: command.command, key_id: "job-key-1", signature: command.signature }, keyring, RUNNER, NOW), "malformed");
  });
});

describe("what a runner is offered", () => {
  const runner = (over: Partial<RunnerOffer> = {}): RunnerOffer => ({ protocol_version: MACHINE_ONBOARDING_MIN_PROTOCOL, capabilities: [...RUNNER_CAPABILITIES], sandbox_engine: "microvm", ...over });
  it("names six capabilities, all in the hello list, and ties each work family to one", () => {
    const six = [DEVICE_REGISTER_CAPABILITY, PROJECT_SETUP_CAPABILITY, SURVEY_CAPABILITY, ENGINE_SESSION_CAPABILITY, MACHINE_LOGIN_CAPABILITY, REPO_TOKEN_REFRESH_CAPABILITY];
    expect(six).toEqual(["device_register_v1", "project_setup_v1", "survey_v1", "engine_session_v1", "machine_login_v1", "repo_token_refresh_v1"]);
    for (const capability of six) expect(RUNNER_CAPABILITIES).toContain(capability);
    expect(MACHINE_JOB_CAPABILITY).toEqual({ project_setup: "project_setup_v1", engine_update: "project_setup_v1", project_remove: "project_setup_v1", engine_session_start: "engine_session_v1", engine_session_stop: "engine_session_v1", engine_session_delete: "engine_session_v1", twin_seed: "twin_v1", twin_publish: "twin_v1" });
    expect(TASK_KIND_CAPABILITY).toEqual({ survey: "survey_v1" });
  });
  it("offers each kind of work to a runner with its capability and to no other", () => {
    for (const kind of MACHINE_JOB_KINDS) {
      expect(machineJobOffered(kind, "any", runner()), kind).toBe(true);
      expect(machineJobOffered(kind, "any", runner({ capabilities: [] })), `${kind} without a capability`).toBe(false);
      expect(machineJobOffered(kind, "any", runner({ capabilities: RUNNER_CAPABILITIES.filter((c) => c !== MACHINE_JOB_CAPABILITY[kind]) })), `${kind} without its own`).toBe(false);
      expect(machineJobOffered(kind, "any", runner({ protocol_version: MACHINE_ONBOARDING_MIN_PROTOCOL - 1 })), `${kind} below the version`).toBe(false);
    }
    expect(taskKindOffered("survey", runner())).toBe(true);
    expect(taskKindOffered("survey", runner({ capabilities: [] }))).toBe(false);
    expect(taskKindOffered("survey", runner({ protocol_version: 21 }))).toBe(false);
    for (const kind of TASK_KINDS) if (kind !== "survey") expect(taskKindOffered(kind, runner({ capabilities: [], protocol_version: 1 })), kind).toBe(true);
    expect(loginCommandOffered(runner())).toBe(true);
    expect(loginCommandOffered(runner({ capabilities: [] }))).toBe(false);
    expect(loginCommandOffered(runner({ protocol_version: 21 }))).toBe(false);
    expect(deviceFlowOffered(runner())).toBe(true);
    expect(deviceFlowOffered(runner({ capabilities: RUNNER_CAPABILITIES.filter((c) => c !== DEVICE_REGISTER_CAPABILITY) }))).toBe(false);
  });
  it("never gives a microVM job to a runner that is not a microVM machine, or says nothing about it", () => {
    for (const kind of MACHINE_JOB_KINDS) {
      expect(machineJobOffered(kind, "microvm", runner({ sandbox_engine: "microvm" })), kind).toBe(true);
      expect(machineJobOffered(kind, "microvm", runner({ sandbox_engine: "os_sandbox" })), `${kind} os_sandbox`).toBe(false);
      expect(machineJobOffered(kind, "microvm", runner({ sandbox_engine: undefined })), `${kind} no facts`).toBe(false);
      expect(machineJobOffered(kind, "any", runner({ sandbox_engine: "os_sandbox" })), `${kind} any on os_sandbox`).toBe(true);
    }
  });
  it("leaves every earlier hello valid, with and without the new capabilities", () => {
    const hello = (protocol_version: number, capabilities?: string[]) => HelloMessage.safeParse({ protocol_version, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", ...(capabilities === undefined ? {} : { capabilities }) }).success;
    for (let version = MIN_SUPPORTED_PROTOCOL_VERSION; version <= MACHINE_ONBOARDING_MIN_PROTOCOL; version++) expect(hello(version), String(version)).toBe(true);
    expect(hello(MACHINE_ONBOARDING_MIN_PROTOCOL, [...RUNNER_CAPABILITIES])).toBe(true);
    expect(hello(21, ["engine_bridge_v1", "sandbox_commands_v1"])).toBe(true);
    expect(hello(22, ["machine_login_v2"])).toBe(false);
  });
});

describe("setup progress body", () => {
  const body = (over: Record<string, unknown> = {}) => ({ job_id: ID, seq: 3, sub_step: "deps", state: "started", ...over });
  const good = (value: unknown): boolean => SetupProgressBody.safeParse(value).success;
  it("takes the engine's four states and a coldstart failure code", () => {
    for (const state of ["started", "ok"]) expect(good(body({ state })), state).toBe(true);
    expect(good(body({ state: "failed", failure_code: "deps_failed" }))).toBe(true);
    expect(good(body({ state: "failed", failure_code: "missing_topic:vision_doc" }))).toBe(true);
    expect(good(body({ state: "skipped" }))).toBe(true);
    expect(good(body({ state: "skipped", failure_code: "cloud_owned" }))).toBe(true);
    expect(good(body({ state: "ok", bundle_bytes: 4096, sub_step: "bundle_out" }))).toBe(true);
  });
  it("takes every setup failure code, with a closed reason", () => {
    for (const failure_code of SETUP_FAILURE_CODES) expect(good(body({ state: "failed", failure_code })), failure_code).toBe(true);
    expect(good(body({ state: "failed", failure_code: "bundle_refused", failure_reason: "workflow" }))).toBe(true);
    expect(SETUP_FAILURE_CODES).toEqual(expect.arrayContaining(["engine_checksum", "engine_unsupported", "job_silent", "job_overran", "job_expired", "vm_boot_failed", "kind_unsupported"]));
  });
  it("names the job, and only a sub-step of the closed list that keeps the runner's names apart from the engine's", () => {
    expect(good({ seq: 3, sub_step: "deps", state: "started" })).toBe(false);
    expect(good(body({ job_id: "not-a-uuid" }))).toBe(false);
    for (const sub_step of SETUP_SUB_STEPS) expect(good(body({ sub_step })), sub_step).toBe(true);
    expect([...SETUP_SUB_STEPS].sort()).toEqual([...COLDSTART_STEPS, ...SETUP_RUNNER_STEPS].sort());
    expect([...COLDSTART_STEPS].filter((step) => (SETUP_RUNNER_STEPS as readonly string[]).includes(step))).toEqual([]);
    for (const sub_step of ["archive", "Deps", "a/b", "bundle ", "deps2", ""]) expect(good(body({ sub_step })), sub_step).toBe(false);
  });
  it("refuses a failed step with no code, a code on a started or ok step, a reason with no code or a topic, and anything outside the closed shape", () => {
    expect(good(body({ state: "failed" }))).toBe(false);
    expect(good(body({ state: "ok", failure_code: "deps_failed" }))).toBe(false);
    expect(good(body({ state: "started", failure_code: "interrupted" }))).toBe(false);
    expect(good(body({ state: "failed", failure_code: "disk_full" }))).toBe(false);
    expect(good(body({ state: "failed", failure_code: "missing_topic" }))).toBe(false);
    expect(good(body({ state: "failed", failure_code: "missing_topic:Bad Id" }))).toBe(false);
    expect(good(body({ state: "failed", failure_code: "deps_failed:x" }))).toBe(false);
    expect(good(body({ state: "failed", failure_code: "missing_topic:identity", failure_reason: "identity" }))).toBe(false);
    expect(good(body({ failure_reason: "workflow" }))).toBe(false);
    expect(good(body({ state: "failed", failure_code: "bundle_refused", failure_reason: "Work Flow" }))).toBe(false);
    expect(good(body({ state: "done" }))).toBe(false);
    expect(good(body({ seq: -1 }))).toBe(false);
    expect(good(body({ bundle_bytes: -1 }))).toBe(false);
    expect(good(body({ log: "text" }))).toBe(false);
  });
  it("ends a job on one step only: the last runner step, for project_setup, and no other kind has one", () => {
    expect(MACHINE_JOB_FINAL_STEP).toEqual({ project_setup: SETUP_RUNNER_STEPS[SETUP_RUNNER_STEPS.length - 1] });
  });
  it("has a closed claim reply: one signed job, or a retry hint, never both", () => {
    const signedJob = signMachineJob(jobOf("project_setup"), "job-key-1", privateKey);
    expect(MachineJobClaimReply.safeParse({ retry_after: 60 }).success).toBe(true);
    expect(MachineJobClaimReply.safeParse({ signed_job: signedJob }).success).toBe(true);
    expect(MachineJobClaimReply.safeParse({ retry_after: 60, signed_job: signedJob }).success).toBe(false);
    expect(MachineJobClaimReply.safeParse({ retry_after: 0 }).success).toBe(false);
    expect(MachineJobClaimMessage.safeParse({ extra: 1 }).success).toBe(false);
  });

  // D#845 ON-13a0: the session kinds' operate epoch, the stop reasons and the session job report.
  it("holds every session kind to its closed args: a missing or extra key is refused, a start never carries epoch 0, and the epoch is a safe integer", () => {
    expect(ok(jobOf("engine_session_start"))).toBe(true);
    expect(ok(jobOf("engine_session_start", { args: { at_sha: SHA, resume: false } }))).toBe(false);
    expect(ok(jobOf("engine_session_start", { args: { at_sha: SHA, resume: false, operate_epoch: 0 } }))).toBe(false);
    expect(ok(jobOf("engine_session_start", { args: { at_sha: SHA, resume: false, operate_epoch: 1.5 } }))).toBe(false);
    expect(ok(jobOf("engine_session_start", { args: { at_sha: SHA, resume: false, operate_epoch: Number.MAX_SAFE_INTEGER + 1 } }))).toBe(false);
    expect(ok(jobOf("engine_session_start", { args: { at_sha: SHA, resume: false, operate_epoch: 1, operate: true } }))).toBe(false);
    expect(ok(jobOf("engine_session_stop", { args: { reason: "person" } }))).toBe(false);
    expect(ok(jobOf("engine_session_stop", { args: { reason: "person", operate_epoch: -1 } }))).toBe(false);
    expect(ok(jobOf("engine_session_stop", { args: { reason: "person", operate_epoch: 0, extra: 1 } }))).toBe(false);
    expect(ok(jobOf("engine_session_delete", { args: {} }))).toBe(false);
    expect(ok(jobOf("engine_session_delete", { args: { operate_epoch: 7 } }))).toBe(true);
    expect(ok(jobOf("engine_session_delete", { args: { operate_epoch: 0, extra: 1 } }))).toBe(false);
  });
  it("pins the stop reasons, with the two new ones", () => {
    expect([...ENGINE_STOP_REASONS]).toEqual(["person", "halt", "move", "remove", "operate_off", "plan"]);
    for (const reason of ENGINE_STOP_REASONS) expect(ok(jobOf("engine_session_stop", { args: { reason, operate_epoch: 3 } })), reason).toBe(true);
    expect(ok(jobOf("engine_session_stop", { args: { reason: "park", operate_epoch: 3 } }))).toBe(false);
  });
  it("lists each session kind's steps in order, inside the closed step list, and the kinds are the three session kinds", () => {
    expect([...SESSION_JOB_KINDS]).toEqual(MACHINE_JOB_KINDS.filter((k) => k.startsWith("engine_session_")));
    expect(SESSION_JOB_STEP_ORDER).toEqual({
      engine_session_start: ["admission", "session_create", "seed", "session_boot", "credentials", "supervisor", "done"],
      engine_session_stop: ["admission", "session_stop", "snapshot", "done"],
      engine_session_delete: ["admission", "session_delete", "done"],
    });
    for (const kind of SESSION_JOB_KINDS) {
      for (const step of SESSION_JOB_STEP_ORDER[kind]) expect((SESSION_JOB_STEPS as readonly string[]).includes(step)).toBe(true);
      expect(SESSION_JOB_STEP_ORDER[kind].at(-1)).toBe("done");
    }
    expect([...SESSION_START_MODES]).toEqual(["created", "resumed", "fresh"]);
    expect(machineJobProgressPath(ID)).toBe(`/api/runner/machine-job/${ID}/progress`);
  });
  describe("SessionJobProgressBody", () => {
    const sgood = (value: unknown): boolean => SessionJobProgressBody.safeParse(value).success;
    const sbody = (over: Record<string, unknown> = {}) => ({ seq: 0, step: "admission", state: "started", ...over });
    it("takes a started, ok or skipped step of any session step, and a failed one with a runner code", () => {
      expect(sgood(sbody())).toBe(true);
      for (const step of SESSION_JOB_STEPS) for (const state of ["started", "ok", "skipped"]) expect(sgood(sbody({ step, state })), `${step} ${state}`).toBe(true);
      for (const failure_code of SESSION_FAILURE_CODES) expect(sgood(sbody({ state: "failed", failure_code })), failure_code).toBe(true);
      expect(sgood(sbody({ state: "failed", failure_code: "vm_memory_low", failure_reason: "low_memory" }))).toBe(true);
    });
    it("refuses a failed step with no code, a code on any other step, a reason with no code, and a code the runner may not send", () => {
      expect(sgood(sbody({ state: "failed" }))).toBe(false);
      for (const state of ["started", "ok", "skipped"]) expect(sgood(sbody({ state, failure_code: "vm_memory_low" })), state).toBe(false);
      expect(sgood(sbody({ failure_reason: "low_memory" }))).toBe(false);
      expect(sgood(sbody({ state: "failed", failure_code: "vm_memory_low", failure_reason: "Low Memory" }))).toBe(false);
      for (const failure_code of ["job_expired", "job_silent", "job_overran", "bootstrap_failed", "disk_full"]) expect(sgood(sbody({ state: "failed", failure_code })), failure_code).toBe(false);
      expect(sgood(sbody({ state: "done" }))).toBe(false);
    });
    it("takes a start mode on the done step's ok report only, from the closed list", () => {
      for (const start_mode of SESSION_START_MODES) expect(sgood(sbody({ step: "done", state: "ok", start_mode })), start_mode).toBe(true);
      expect(sgood(sbody({ step: "done", state: "ok", start_mode: "cold" }))).toBe(false);
      expect(sgood(sbody({ step: "done", state: "started", start_mode: "created" }))).toBe(false);
      expect(sgood(sbody({ step: "done", state: "failed", failure_code: "vm_memory_low", start_mode: "created" }))).toBe(false);
      expect(sgood(sbody({ step: "supervisor", state: "ok", start_mode: "created" }))).toBe(false);
    });
    it("is closed: an unknown step, a bad sequence, and an extra key are refused (the job id lives in the path, not the body)", () => {
      for (const step of ["engine_fetch", "Admission", "done ", "gh_labels"]) expect(sgood(sbody({ step })), step).toBe(false);
      expect(sgood(sbody({ seq: -1 }))).toBe(false);
      expect(sgood(sbody({ seq: 1.5 }))).toBe(false);
      expect(sgood(sbody({ job_id: ID }))).toBe(false);
      expect(sgood(sbody({ log: "text" }))).toBe(false);
      expect(sgood(sbody({ bundle_bytes: 1 }))).toBe(false);
      expect(sgood(null)).toBe(false);
    });
  });
});
