import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { TARGET_ENV_NAME } from "../src/limits.js";
import { loadPacks } from "../src/manifest.js";
import { BYPASS_ENV, STRIPE_RESTRICTED_KEY_ENV } from "../src/needs.js";
import { buildInvocations, childEnv, playwrightCli, spawnExecutor, type Executor, type Invocation } from "../src/run.js";
import { loadTarget } from "../src/targets.js";
import type { Results } from "../src/report.js";
import { makeIo, PACKAGE_ROOT, scratchRoot, TARGET_ENV, tmpDir } from "./helpers.js";

const SECRET = `t1b${randomBytes(12).toString("hex")}`;
const STRIPE = `rk_test_${randomBytes(12).toString("hex")}`;
const UNRELATED = `unrelated${randomBytes(12).toString("hex")}`;
const packs = loadPacks(join(PACKAGE_ROOT, "packs"));
const staging = loadTarget(join(PACKAGE_ROOT, "targets"), "staging", TARGET_ENV);
const platform = packs.find((p) => p.id === "platform");

describe("the child's environment is a named list", () => {
  const parent = { ...TARGET_ENV, PATH: "/bin", HOME: "/h", PLAYWRIGHT_BROWSERS_PATH: "/b", [BYPASS_ENV]: SECRET, [STRIPE_RESTRICTED_KEY_ENV]: STRIPE, SOME_OTHER_TOKEN: UNRELATED };

  it("carries host basics, the target addresses and the secrets the pack's needs name, nothing else", () => {
    if (!platform) throw new Error("platform pack missing");
    const env = childEnv(platform, staging, parent, "/out");
    expect(env).toEqual({
      [TARGET_ENV_NAME]: "staging",
      LIVE_E2E_OUTPUT_DIR: "/out",
      PATH: "/bin",
      HOME: "/h",
      PLAYWRIGHT_BROWSERS_PATH: "/b",
      LIVE_E2E_STAGING_ORIGIN: TARGET_ENV.LIVE_E2E_STAGING_ORIGIN,
      LIVE_E2E_STAGING_PROJECT_ID: TARGET_ENV.LIVE_E2E_STAGING_PROJECT_ID,
      [BYPASS_ENV]: SECRET,
    });
    expect(Object.values(env)).not.toContain(UNRELATED);
    expect(Object.values(env)).not.toContain(STRIPE);
  });

  it("a pack that does not need bypass does not get it", () => {
    if (!platform) throw new Error("platform pack missing");
    expect(childEnv({ ...platform, needs: [] }, staging, parent, "/out")).not.toHaveProperty(BYPASS_ENV);
  });
});

describe("invocations", () => {
  it("one per selected pack, one --project per device, the pack's retries, no secret in the arguments", () => {
    const plan = { selected: [{ id: "platform" }, { id: "auth-negative" }] } as Parameters<typeof buildInvocations>[0];
    const invs = buildInvocations(plan, packs, staging, { root: PACKAGE_ROOT, env: { ...TARGET_ENV, [BYPASS_ENV]: SECRET }, outDir: "/out", cli: "/pw/cli.js" });
    expect(invs.map((i) => i.packId)).toEqual(["platform", "auth-negative"]);
    const first = invs[0] as Invocation;
    expect(first.args).toEqual(["/pw/cli.js", "test", "--config", join(PACKAGE_ROOT, "playwright.config.ts"), "/packs/platform/", "--project", "desktop", "--project", "phone", "--project", "tablet", "--retries", "0"]);
    expect(first.devices).toEqual(["desktop", "phone", "tablet"]);
    expect(JSON.stringify(invs.map((i) => i.args))).not.toContain(SECRET);
  });

  it("playwright's CLI resolves to a file", () => {
    expect(existsSync(playwrightCli())).toBe(true);
  });
});

describe("spawnExecutor", () => {
  it("returns the exit code and both streams, and hands the child only what it was given", async () => {
    process.env.T1B_PARENT_ONLY = UNRELATED;
    try {
      const inv: Invocation = {
        packId: "x",
        command: process.execPath,
        args: ["-e", "console.log('out', process.env.T1B_PARENT_ONLY === undefined, process.env.GIVEN); console.error('err'); process.exit(3)"],
        env: { GIVEN: "yes" },
        devices: [],
      };
      const res = await spawnExecutor(tmpDir())(inv);
      expect(res.code).toBe(3);
      expect(res.output).toContain("out true yes");
      expect(res.output).toContain("err");
    } finally {
      delete process.env.T1B_PARENT_ONLY;
    }
  });

  it("a command that cannot start is a failure, not a throw", async () => {
    const res = await spawnExecutor(tmpDir())({ packId: "x", command: "/nonexistent/t1b", args: [], env: {}, devices: [] });
    expect(res.code).not.toBe(0);
  });
});

describe("live-e2e run", () => {
  const readResults = (dir: string) => JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as Results;

  it("writes plan.json before anything runs, then results, summary and a scrubbed log per pack", async () => {
    const dir = tmpDir();
    const { io, out } = makeIo(PACKAGE_ROOT, { [BYPASS_ENV]: SECRET });
    io.cwd = dir;
    const seen: string[] = [];
    const exec: Executor = async (inv) => {
      seen.push(inv.packId);
      expect(existsSync(join(dir, "plan.json"))).toBe(true);
      return { code: 0, output: `ran ${inv.packId} with ${SECRET}\n` };
    };
    io.exec = exec;
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], io)).toBe(0);
    expect(seen).toEqual(["auth-negative", "platform"]);
    const results = readResults(dir);
    expect(results.packs.map((p) => [p.id, p.outcome])).toEqual([["auth-negative", "PASS"], ["platform", "PASS"]]);
    expect(results.packs[0]?.devices).toEqual(["desktop", "phone", "tablet"]);
    expect(existsSync(join(dir, "summary.md"))).toBe(true);
    const log = readFileSync(join(dir, "logs", "platform.log"), "utf8");
    expect(log).toContain("ran platform");
    expect(log).not.toContain(SECRET);
    expect(out.join("\n")).not.toContain(SECRET);
    for (const f of ["results.json", "summary.md"]) expect(readFileSync(join(dir, f), "utf8")).not.toContain(SECRET);
  });

  it("a failing pack is FAIL and the exit code is 1", async () => {
    const dir = tmpDir();
    const { io } = makeIo(PACKAGE_ROOT, { [BYPASS_ENV]: SECRET });
    io.cwd = dir;
    io.exec = async (inv) => ({ code: inv.packId === "platform" ? 1 : 0, output: "" });
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], io)).toBe(1);
    expect(readResults(dir).packs.map((p) => [p.id, p.outcome])).toEqual([["auth-negative", "PASS"], ["platform", "FAIL"]]);
  });

  it("with no bypass secret nothing runs: both packs are SKIPPED-NEED bypass and the run is green", async () => {
    const dir = tmpDir();
    const { io } = makeIo(PACKAGE_ROOT);
    io.cwd = dir;
    io.exec = async () => {
      throw new Error("must not run");
    };
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], io)).toBe(0);
    expect(readResults(dir).packs.map((p) => [p.id, p.outcome, p.need])).toEqual([
      ["auth-negative", "SKIPPED-NEED", "bypass"],
      ["platform", "SKIPPED-NEED", "bypass"],
    ]);
  });

  it("a named refusal still refuses on run (a destructive pack on production runs nothing)", async () => {
    const root = scratchRoot([{ ...(platform as NonNullable<typeof platform>), id: "wipe", destructive: true, targets: ["staging", "production"] }]);
    const { io } = makeIo(root, { [BYPASS_ENV]: SECRET });
    io.cwd = tmpDir();
    io.exec = async () => {
      throw new Error("must not run");
    };
    expect(await main(["run", "--target", "production", "--pack", "wipe"], io)).toBe(1);
  });
});

describe("the Playwright specs load under the real config", () => {
  it("--list shows both packs on all three device projects (no browser is started)", () => {
    const res = spawnSync(process.execPath, [playwrightCli(), "test", "--config", join(PACKAGE_ROOT, "playwright.config.ts"), "--list"], {
      cwd: PACKAGE_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...TARGET_ENV, [TARGET_ENV_NAME]: "staging" },
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    for (const project of ["desktop", "phone", "tablet"]) {
      expect(res.stdout).toContain(`[${project}] › platform/platform.spec.ts`);
      expect(res.stdout).toContain(`[${project}] › auth-negative/auth-negative.spec.ts`);
    }
  });
});
