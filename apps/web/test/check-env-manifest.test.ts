import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ENV_MANIFEST } from "../env-manifest";
import * as check from "../lib/env/check";
import { checkEnvManifest, EnvManifestError } from "../scripts/check-env-manifest.mjs";
import { completeEnv } from "./support/envFixtures";

type Options = { env?: Record<string, string | undefined>; log?: (line: string) => void; load?: unknown };
const run = checkEnvManifest as (options: Options) => Promise<{ status: string; report?: { disabled: unknown[] } }>;

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(WEB_DIR, "scripts", "check-env-manifest.mjs");

function load() {
  return Promise.resolve({ ENV_MANIFEST, evaluateEnv: check.evaluateEnv, isDeployKind: check.isDeployKind });
}

/** Runs the real script as a child process with a small explicit environment (the whole environment is never passed on). */
function runScript(extra: Record<string, string>) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra } as unknown as NodeJS.ProcessEnv;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT], { cwd: WEB_DIR, env, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("check-env-manifest (production build gate)", () => {
  it("does nothing, and loads nothing, when the flag is unset, blank or 0", async () => {
    const loader = vi.fn(load);
    for (const flag of [undefined, "", "0"]) {
      expect(await run({ env: { FX_ENFORCE_ENV_MANIFEST: flag }, load: loader })).toEqual({ status: "skipped" });
    }
    expect(loader).not.toHaveBeenCalled();
  });

  it("refuses an unrecognised flag value", async () => {
    await expect(run({ env: { FX_ENFORCE_ENV_MANIFEST: "yes" }, load })).rejects.toThrow(EnvManifestError);
  });

  it("passes a complete production environment and logs a summary without values", async () => {
    const log = vi.fn();
    const env = { ...completeEnv("production"), FX_ENFORCE_ENV_MANIFEST: "1" };
    const result = await run({ env, log, load });
    expect(result.status).toBe("checked");
    expect(log.mock.calls.join("\n")).toMatch(/production settings ok/);
    for (const value of Object.values(env)) if (value.length > 12) expect(log.mock.calls.join("\n")).not.toContain(value);
  });

  it("fails when a required setting is missing, naming it", async () => {
    const env = { ...completeEnv("production"), FX_ENFORCE_ENV_MANIFEST: "1" };
    delete (env as Record<string, string | undefined>).FX_CURSOR_KEY_V1;
    await expect(run({ env, load })).rejects.toThrow(/missing: FX_CURSOR_KEY_V1/);
  });

  it("fails when a required setting is invalid, naming it and the reason but not the value", async () => {
    const bad = "this-is-not-a-valid-base64-key-0123456789";
    const env = { ...completeEnv("production"), FX_ENFORCE_ENV_MANIFEST: "1", FX_WEBHOOK_KEK_V1: bad };
    const err = await run({ env, load }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(EnvManifestError);
    expect((err as Error).message).toMatch(/invalid: FX_WEBHOOK_KEK_V1 \(not_base64_32_bytes\)/);
    expect((err as Error).message).not.toContain(bad);
  });

  it("holds an unset kind to the production list, and honours FX_DEPLOY_KIND", async () => {
    const stagingOnly = { ...completeEnv("staging"), FX_ENFORCE_ENV_MANIFEST: "1" };
    delete (stagingOnly as Record<string, string | undefined>).FX_DEPLOY_KIND;
    expect((await run({ env: stagingOnly, load })).status).toBe("checked"); // staging and production require the same names today
    await expect(run({ env: { FX_ENFORCE_ENV_MANIFEST: "1" }, load })).rejects.toThrow(/for a production build/);
    await expect(run({ env: { FX_ENFORCE_ENV_MANIFEST: "1", FX_DEPLOY_KIND: "staging" }, load })).rejects.toThrow(/for a staging build/);
    expect((await run({ env: { FX_ENFORCE_ENV_MANIFEST: "1", FX_DEPLOY_KIND: "local" }, load })).status).toBe("checked");
    await expect(run({ env: { FX_ENFORCE_ENV_MANIFEST: "1", FX_DEPLOY_KIND: "prod" }, load })).rejects.toThrow(/FX_DEPLOY_KIND must be/);
  });

  it("warns about an invalid optional setting without failing", async () => {
    const log = vi.fn();
    const env = { ...completeEnv("production"), FX_ENFORCE_ENV_MANIFEST: "1", FX_SESSION_IDLE_SECONDS: "soon" };
    expect((await run({ env, log, load })).status).toBe("checked");
    expect(log.mock.calls.join("\n")).toMatch(/optional FX_SESSION_IDLE_SECONDS is set but invalid \(not_a_positive_integer\)/);
  });
});

describe("check-env-manifest as the build runs it (real child process, real type stripping)", () => {
  it("exits 0 and prints nothing when the flag is unset, whatever is missing", () => {
    const res = runScript({});
    expect(res).toEqual({ code: 0, out: "" });
  });

  it("goes red (exit 1) on a production build that lacks a required setting, and names it", () => {
    const env = completeEnv("production");
    delete env.FX_CURSOR_KEY_V1;
    const res = runScript({ ...env, FX_ENFORCE_ENV_MANIFEST: "1" });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/check-env-manifest: FAILED - .*missing: FX_CURSOR_KEY_V1/);
  });

  it("goes red on an invalid required setting without printing its value", () => {
    const secretish = "session-value-that-is-too-short";
    const res = runScript({ ...completeEnv("production"), FX_ENFORCE_ENV_MANIFEST: "1", FX_SESSION_SECRET: secretish });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/invalid: FX_SESSION_SECRET \(shorter_than_32_chars\)/);
    expect(res.out).not.toContain(secretish);
  });

  it("exits 0 for a complete production environment", () => {
    const res = runScript({ ...completeEnv("production"), FX_ENFORCE_ENV_MANIFEST: "1" });
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/production settings ok/);
  });

  it("never prints any value from a complete environment", () => {
    const env = completeEnv("production");
    const res = runScript({ ...env, FX_ENFORCE_ENV_MANIFEST: "1" });
    for (const [name, value] of Object.entries(env)) if (value.length > 12) expect(res.out, name).not.toContain(value);
  });
});

describe("apps/web build:prepare", () => {
  it("runs the gate after the workspace copy and before the migrations", () => {
    const pkg = JSON.parse(readFileSync(path.join(WEB_DIR, "package.json"), "utf8")) as { scripts: { "build:prepare": string } };
    const steps = pkg.scripts["build:prepare"].split("&&").map((s) => s.trim());
    const at = (needle: string) => steps.findIndex((s) => s.includes(needle));
    expect(at("copy-workspace.mjs")).toBeGreaterThanOrEqual(0);
    expect(at("check-env-manifest.mjs")).toBeGreaterThan(at("copy-workspace.mjs"));
    expect(at("migrate-on-build.mjs")).toBeGreaterThan(at("check-env-manifest.mjs"));
    expect(steps[at("check-env-manifest.mjs")]).toContain("--experimental-strip-types");
  });
});
