import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { BYPASS_ENV, STRIPE_RESTRICTED_KEY_ENV } from "../src/needs.js";
import type { Plan } from "../src/plan.js";
import { makeIo, makePack, PACKAGE_ROOT, scratchRoot, TARGET_ENV } from "./helpers.js";

const readPlan = (root: string): Plan => JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;

describe("plan: the shipped packs, no secrets in env", () => {
  it("plan --target staging --tier smoke exits 0 and lists platform and auth-negative as SKIPPED-NEED bypass, nothing above smoke", async () => {
    const { io, out } = makeIo(PACKAGE_ROOT);
    // Written next to the other scratch output, not into the package.
    const scratch = scratchRoot([]);
    io.cwd = scratch;
    const code = await main(["plan", "--target", "staging", "--tier", "smoke"], io);
    expect(code).toBe(0);
    expect(out).toEqual(expect.arrayContaining(["platform: SKIPPED-NEED bypass", "auth-negative: SKIPPED-NEED bypass"]));
    const plan = readPlan(scratch);
    expect(plan.skipped).toEqual([
      { id: "auth-negative", need: "bypass" },
      { id: "platform", need: "bypass" },
    ]);
    expect(plan.selected).toEqual([]);
    expect(plan.refused).toEqual([]);
    expect(plan.packs.every((p) => ["platform", "auth-negative"].includes(p.id))).toBe(true);
    expect(plan.target).toBe("staging");
    expect(plan.tier).toBe("smoke");
  });

  it("with the bypass secret present the same packs are RUN, with their device projects and a zero estimate", async () => {
    const scratch = scratchRoot([]);
    const { io } = makeIo(PACKAGE_ROOT, { [BYPASS_ENV]: "present" });
    io.cwd = scratch;
    expect(await main(["plan", "--target", "staging", "--tier", "smoke"], io)).toBe(0);
    const plan = readPlan(scratch);
    expect(plan.selected.map((s) => s.id)).toEqual(["auth-negative", "platform"]);
    expect(plan.selected[0]?.projects).toEqual(["desktop", "phone", "tablet"]);
    expect(plan.estimated_cost_usd).toBe(0);
    expect(plan.skipped).toEqual([]);
  });

  it("the shipped packs also plan on production (prod-safe, smoke)", async () => {
    const scratch = scratchRoot([]);
    const { io } = makeIo(PACKAGE_ROOT, { [BYPASS_ENV]: "present" });
    io.cwd = scratch;
    expect(await main(["plan", "--target", "production", "--tier", "smoke"], io)).toBe(0);
    expect(readPlan(scratch).selected.map((s) => s.id)).toEqual(["auth-negative", "platform"]);
  });
});

describe("plan: needs outcomes", () => {
  const stripePack = makePack({ id: "billing-ish", tier: "standard", needs: ["stripe-test"], targets: ["staging"] });

  it("a pack needing stripe-test with the value absent is SKIPPED-NEED stripe-test, exit 0", async () => {
    const root = scratchRoot([stripePack]);
    const { io, out } = makeIo(root);
    expect(await main(["plan", "--target", "staging", "--pack", "billing-ish"], io)).toBe(0);
    expect(out).toContain("billing-ish: SKIPPED-NEED stripe-test");
  });

  it("a live key does not satisfy it; a restricted test key does", async () => {
    const root = scratchRoot([stripePack]);
    const live = makeIo(root, { [BYPASS_ENV]: "x", [STRIPE_RESTRICTED_KEY_ENV]: "rk_live_zzz" });
    expect(await main(["plan", "--target", "staging", "--pack", "billing-ish"], live.io)).toBe(0);
    expect(live.out).toContain("billing-ish: SKIPPED-NEED stripe-test");
    const test = makeIo(root, { [STRIPE_RESTRICTED_KEY_ENV]: "rk_test_zzz" });
    expect(await main(["plan", "--target", "staging", "--pack", "billing-ish"], test.io)).toBe(0);
    expect(test.out).toContain("billing-ish: RUN");
  });

  it("a pack needing an unknown need fails the manifest load, naming the pack and the need (exit 2)", async () => {
    const root = scratchRoot([makePack({ id: "mystery", needs: ["flux-capacitor"] })]);
    const { io, err } = makeIo(root);
    expect(await main(["plan", "--target", "staging", "--tier", "smoke"], io)).toBe(2);
    expect(err.join("\n")).toContain("pack mystery");
    expect(err.join("\n")).toContain("flux-capacitor");
  });

  it("host-capacity unmet skips the pack (green, listed)", async () => {
    const root = scratchRoot([makePack({ id: "heavy", needs: ["host-capacity"] })]);
    const { io, out } = makeIo(root, {}, { loadavg1: () => 30, memAvailableBytes: () => 64 * 1024 ** 3 });
    expect(await main(["plan", "--target", "staging", "--tier", "smoke"], io)).toBe(0);
    expect(out).toContain("heavy: SKIPPED-NEED host-capacity");
  });

  it("a named pack that is merely skipped for a need does not fail the command", async () => {
    const root = scratchRoot([stripePack]);
    const { io } = makeIo(root);
    expect(await main(["plan", "--target", "staging", "--pack", "billing-ish"], io)).toBe(0);
  });
});

describe("plan: starts no browser", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

  it("nothing under src/ imports a browser driver", () => {
    for (const f of files(join(PACKAGE_ROOT, "src")).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from\s+["'](@?playwright|playwright-core|@playwright\/test|puppeteer)/);
      expect(text, f).not.toMatch(/\bchromium\b/i);
    }
  });

  it("package.json declares no cross-package or browser dependency this slice does not use", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["tsx"]);
  });
});

describe("plan: the real executable", () => {
  it("bin/live-e2e.mjs runs `plan` through tsx and writes plan.json (no secrets in env)", () => {
    const scratch = scratchRoot([]);
    // A minimal environment on purpose: no bypass secret, nothing inherited that could satisfy a need.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", ...TARGET_ENV };
    const stdout = execFileSync(process.execPath, [join(PACKAGE_ROOT, "bin", "live-e2e.mjs"), "plan", "--target", "staging", "--tier", "smoke", "--out", join(scratch, "plan.json")], { env, encoding: "utf8" });
    expect(stdout).toContain("platform: SKIPPED-NEED bypass");
    expect(readPlan(scratch).skipped.map((s) => s.id)).toEqual(["auth-negative", "platform"]);
  }, 30_000);
});
