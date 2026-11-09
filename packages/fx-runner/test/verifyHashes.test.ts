import { describe, expect, it, vi } from "vitest";

// A refusal must leave nothing on the machine: no process and no directory. These stand in for both, and every
// refusal below asserts they were never called.
const spawned = vi.hoisted(() => vi.fn());
const made = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawned, spawnSync: spawned, exec: spawned, execFile: spawned, execFileSync: spawned, fork: spawned }));
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()), mkdirSync: made, mkdtempSync: made, writeFileSync: made }));
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()), mkdir: made, mkdtemp: made, writeFile: made }));

import { JobHashRefused, assertJobHashes, jobHashRefusals } from "../src/job/verifyHashes.js";
import { roleToolsDigest as cloudDigest } from "@fx/runner";
import { roleToolsDigest } from "../src/job/roleTools.js";
import { sampleJob, sha } from "./helpers/sampleJob.js";

describe("job hash checks", () => {
  it("accepts a consistent job, for every kind of role", () => {
    for (const role of ["executor", "code-reviewer", "project-manager"]) expect(jobHashRefusals(sampleJob({ role })), role).toEqual([]);
  });

  it("refuses a task prompt that does not match its digest", () => {
    const job = sampleJob();
    job.task.prompt = `${job.task.prompt}extra`;
    expect(jobHashRefusals(job)).toEqual(["task_prompt_hash_mismatch"]);
  });

  it("refuses a role card that does not match its digest", () => {
    const job = sampleJob();
    job.role_card.text = "You are something else.\n";
    expect(jobHashRefusals(job)).toEqual(["role_card_hash_mismatch"]);
  });

  it("refuses a tool digest that differs from this runner's own entry for the role", () => {
    expect(jobHashRefusals({ ...sampleJob(), role_tools_sha256: "0".repeat(64) })).toEqual(["role_tools_mismatch"]);
    // the digest of another role's list is still wrong for this role
    expect(jobHashRefusals({ ...sampleJob({ role: "executor" }), role_tools_sha256: sampleJob({ role: "code-reviewer" }).role_tools_sha256 })).toEqual(["role_tools_mismatch"]);
    // a digest of the cloud's list with a web tool added is not this runner's list
    expect(jobHashRefusals({ ...sampleJob(), role_tools_sha256: sha('["WebFetch"]') })).toEqual(["role_tools_mismatch"]);
  });

  it("refuses an unknown role first, whatever else matches", () => {
    expect(jobHashRefusals({ ...sampleJob(), role: "ghost" as never })).toEqual(["unknown_role"]);
  });

  it("reports every mismatch at once", () => {
    const job = { ...sampleJob(), role_tools_sha256: "1".repeat(64) };
    job.task = { ...job.task, prompt_sha256: "2".repeat(64) };
    job.role_card = { ...job.role_card, sha256: "3".repeat(64) };
    expect(jobHashRefusals(job)).toEqual(["task_prompt_hash_mismatch", "role_card_hash_mismatch", "role_tools_mismatch"]);
  });

  it("assertJobHashes throws with the reasons", () => {
    expect(() => assertJobHashes(sampleJob())).not.toThrow();
    const bad = { ...sampleJob(), role_tools_sha256: "0".repeat(64) };
    expect(() => assertJobHashes(bad)).toThrow(JobHashRefused);
    try {
      assertJobHashes(bad);
    } catch (error) {
      expect((error as JobHashRefused).reasons).toEqual(["role_tools_mismatch"]);
    }
  });

  // D#749 V2c-1: the tool digest of a deploy verifier job is of the list of the browser method the job was signed with.
  it("checks a deploy verifier job against the list of its signed browser method, and refuses a digest of the other method's list or a job whose method was changed", () => {
    const withMethod = (method: "chrome_runner" | "playwright_runner", digestOfMethod: "chrome_runner" | "playwright_runner") => ({
      ...sampleJob({ role: "deploy-verifier" }),
      browser_method: method,
      role_tools_sha256: roleToolsDigest("deploy-verifier", digestOfMethod),
    });
    expect(jobHashRefusals(withMethod("chrome_runner", "chrome_runner"))).toEqual([]);
    expect(jobHashRefusals(withMethod("playwright_runner", "playwright_runner"))).toEqual([]);
    expect(jobHashRefusals(withMethod("playwright_runner", "chrome_runner"))).toEqual(["role_tools_mismatch"]);
    expect(jobHashRefusals(withMethod("chrome_runner", "playwright_runner"))).toEqual(["role_tools_mismatch"]);
    // The cloud's own digest of each method's list is the runner's.
    for (const method of ["chrome_runner", "playwright_runner"] as const) expect(roleToolsDigest("deploy-verifier", method)).toBe(cloudDigest("deploy-verifier", method));
    expect(roleToolsDigest("deploy-verifier", "playwright_runner")).not.toBe(roleToolsDigest("deploy-verifier", "chrome_runner"));
    // A job without a method is checked against the Chrome list, as before the second method existed.
    expect(jobHashRefusals(sampleJob({ role: "deploy-verifier" }))).toEqual([]);
    // A method on a job of another role changes nothing: the role's own list still decides.
    expect(jobHashRefusals({ ...sampleJob({ role: "executor" }), browser_method: "playwright_runner" })).toEqual([]);
  });

  it("starts no process and creates no directory on any refusal", () => {
    const job = sampleJob();
    for (const bad of [
      { ...job, task: { ...job.task, prompt: "changed" } },
      { ...job, role_card: { ...job.role_card, text: "changed" } },
      { ...job, role_tools_sha256: "0".repeat(64) },
      { ...job, role: "ghost" as never },
    ]) {
      expect(jobHashRefusals(bad).length).toBeGreaterThan(0);
      expect(() => assertJobHashes(bad)).toThrow(JobHashRefused);
    }
    expect(spawned).not.toHaveBeenCalled();
    expect(made).not.toHaveBeenCalled();
  });
});
