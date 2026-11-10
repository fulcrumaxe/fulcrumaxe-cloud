import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROWSER_CAPABILITY_FOR_METHOD,
  BROWSER_CHROME_CAPABILITY,
  BROWSER_METHODS,
  BROWSER_PLAYWRIGHT_CAPABILITY,
  DEPLOY_VERIFIER_DENIED_BROWSER_TOOLS,
  DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS,
  DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS,
  DEPLOY_VERIFIER_ROLE,
  DEPLOY_VERIFIER_RUNNER_TOOLS,
  FXVERIFY_TOOL_PREFIX,
  deployVerifierToolsFor,
  isBrowserMethod,
  isMcpToolName,
} from "../src/deployVerifier.js";
import { JobSchema, RUNNER_CAPABILITIES, SignedJobSchema, sha256Text, type Job } from "../src/job.js";
import { JobSignatureError, canonicalJson, signJob, verifyJob } from "../src/jobSignature.js";
import { BROWSER_METHOD_JOB_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION, HelloMessage, SCOPE_JOB_MIN_PROTOCOL } from "../src/messages.js";
import { sampleJob } from "./helpers/sampleJob.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const NOW = new Date("2026-10-04T12:30:00Z");
const SHA = "a".repeat(40);
const digestOf = (tools: readonly string[]): string => sha256Text(canonicalJson([...tools].sort()));
const verifierJob = (over: Record<string, unknown> = {}): Job => sampleJob({ role: DEPLOY_VERIFIER_ROLE, review: { head_sha: SHA }, ...over }) as Job;
const signedParses = (job: unknown): boolean => SignedJobSchema.safeParse({ job, signature: "A".repeat(86) }).success;

describe("the deploy verifier's two browser methods (D#749 V2c-1)", () => {
  it("name two methods, each with its own capability, and the new capability is a hello capability that an old hello without it still parses beside", () => {
    expect([...BROWSER_METHODS]).toEqual(["chrome_runner", "playwright_runner"]);
    expect(BROWSER_CAPABILITY_FOR_METHOD).toEqual({ chrome_runner: BROWSER_CHROME_CAPABILITY, playwright_runner: BROWSER_PLAYWRIGHT_CAPABILITY });
    expect(BROWSER_PLAYWRIGHT_CAPABILITY).toBe("browser_playwright_v1");
    expect(RUNNER_CAPABILITIES).toContain(BROWSER_PLAYWRIGHT_CAPABILITY);
    const hello = { protocol_version: 1, binary_version: "0.1.0", model_auth_present: true, isolation: "container" };
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["browser_playwright_v1", "browser_chrome_v1"] }).success).toBe(true);
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["browser_playwright_v1", "browser_playwright_v1"] }).success).toBe(false);
    expect(HelloMessage.safeParse({ ...hello, capabilities: ["browser_playwright_v2"] }).success).toBe(false);
    for (const good of BROWSER_METHODS) expect(isBrowserMethod(good)).toBe(true);
    for (const bad of ["chrome", "playwright_sandbox", "", "constructor", null, undefined, 3]) expect(isBrowserMethod(bad), String(bad)).toBe(false);
  });

  // D#749 V3c: a runner below this version parses a job strictly and would refuse the `browser_method` key, so the key's job is gated at it (the issuer records it; the claim honours it).
  it("the key's protocol floor is 16, one above the last gate, and the current version is at least it", () => {
    expect(BROWSER_METHOD_JOB_MIN_PROTOCOL).toBe(16);
    expect(BROWSER_METHOD_JOB_MIN_PROTOCOL).toBe(SCOPE_JOB_MIN_PROTOCOL + 1);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BROWSER_METHOD_JOB_MIN_PROTOCOL);
  });

  it("hold different tool lists: the Chrome list is unchanged and the Playwright list is the three read tools plus the twelve fxverify tools", () => {
    expect(deployVerifierToolsFor()).toBe(DEPLOY_VERIFIER_RUNNER_TOOLS);
    expect(deployVerifierToolsFor("chrome_runner")).toBe(DEPLOY_VERIFIER_RUNNER_TOOLS);
    expect(deployVerifierToolsFor("playwright_runner")).toBe(DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS);
    expect(DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS.map((tool) => tool.slice(FXVERIFY_TOOL_PREFIX.length))).toEqual(["begin_journey", "open", "snapshot", "click", "type", "select", "press", "reload", "wait_text", "read_number", "console", "submit_answer"]);
    expect([...DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS]).toEqual(["Read", "Glob", "Grep", ...DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS]);
    expect(Object.isFrozen(DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS)).toBe(true);
    // Neither list holds a tool of the other, a denied Chrome tool, or anything that writes, runs a command or reaches the web.
    expect(DEPLOY_VERIFIER_RUNNER_TOOLS.filter((tool) => tool.startsWith(FXVERIFY_TOOL_PREFIX))).toEqual([]);
    expect(DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS.filter((tool) => tool.startsWith("mcp__claude-in-chrome__"))).toEqual([]);
    for (const denied of DEPLOY_VERIFIER_DENIED_BROWSER_TOOLS) expect(DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS).not.toContain(denied);
    for (const tool of DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS) expect(tool).not.toMatch(/Bash|Edit|Write|Web|curl/);
    expect(DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS.filter((tool) => !isMcpToolName(tool))).toEqual(["Read", "Glob", "Grep"]);
  });

  it("move the signed tool digest: the two methods digest differently, and each digest covers its own list", () => {
    const chrome = digestOf(deployVerifierToolsFor("chrome_runner"));
    const playwright = digestOf(deployVerifierToolsFor("playwright_runner"));
    expect(chrome).not.toBe(playwright);
    expect(digestOf(DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS)).toBe(playwright);
    // One tool more or less in a list is another digest: the digest is of the list, not of its method's name.
    expect(digestOf([...DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS, "Bash"])).not.toBe(playwright);
    expect(digestOf(DEPLOY_VERIFIER_PLAYWRIGHT_RUNNER_TOOLS.slice(1))).not.toBe(playwright);
  });
});

describe("the job's browser_method", () => {
  it("is on a deploy-verifier job and on no other, and only one of the two methods", () => {
    expect(signedParses(verifierJob({ browser_method: "playwright_runner" }))).toBe(true);
    expect(signedParses(verifierJob({ browser_method: "chrome_runner" }))).toBe(true);
    // The role needs it; every other role refuses it; a made-up or non-string method does not parse at all.
    expect(signedParses(verifierJob())).toBe(false);
    expect(signedParses(sampleJob({ browser_method: "playwright_runner" }))).toBe(false);
    expect(signedParses(sampleJob())).toBe(true);
    for (const bad of ["playwright_sandbox", "chrome", "", null, 1]) expect(JobSchema.safeParse(verifierJob({ browser_method: bad })).success, String(bad)).toBe(false);
  });

  it("is covered by the signature: a runner that changes the method (or the cloud's reply carrying a changed one) fails verification", () => {
    const signed = signJob(verifierJob({ browser_method: "chrome_runner" }), privateKey);
    expect(verifyJob(signed, keyring, { now: NOW }).browser_method).toBe("chrome_runner");
    const forged = { ...signed, job: { ...signed.job, browser_method: "playwright_runner" } };
    let code: string | undefined;
    try {
      verifyJob(forged, keyring, { now: NOW });
    } catch (error) {
      code = error instanceof JobSignatureError ? error.code : "other";
    }
    expect(code).toBe("bad_signature");
    // Dropping the key is a change too.
    const { browser_method: _dropped, ...without } = signed.job;
    expect(() => verifyJob({ ...signed, job: without }, keyring, { now: NOW })).toThrow(JobSignatureError);
  });

  it("is absent from the canonical JSON of every job that is not a deploy verifier's, so their signed bytes are unchanged", () => {
    expect(canonicalJson(sampleJob())).not.toContain("browser_method");
  });
});
