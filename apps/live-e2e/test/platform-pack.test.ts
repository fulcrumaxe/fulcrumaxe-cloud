// The shipped platform and auth-negative packs after T1c: what they declare, how plan shows it, and that the
// probe list stays tied to the app's own cron list and to the built workflow routes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { loadPacks } from "../src/manifest.js";
import { BYPASS_ENV } from "../src/needs.js";
import type { Plan } from "../src/plan.js";
import { buildInvocations } from "../src/run.js";
import { listStagingOnlyTests, stagingOnlyTitles } from "../src/staging-only.js";
import { loadTarget } from "../src/targets.js";
import { makeIo, PACKAGE_ROOT, scratchRoot, TARGET_ENV } from "./helpers.js";

const packs = loadPacks(join(PACKAGE_ROOT, "packs"));
const platform = packs.find((p) => p.id === "platform");
if (platform === undefined) throw new Error("platform pack missing");

async function planFor(target: string): Promise<{ plan: Plan; out: string[] }> {
  const scratch = scratchRoot([]);
  const { io, out } = makeIo(PACKAGE_ROOT, { [BYPASS_ENV]: "present" });
  io.cwd = scratch;
  expect(await main(["plan", "--target", target, "--tier", "smoke"], io)).toBe(0);
  return { plan: JSON.parse(readFileSync(join(scratch, "plan.json"), "utf8")) as Plan, out };
}

describe("plan on production", () => {
  it("lists both packs as prod-safe with their probe counts, none destructive", async () => {
    const { plan } = await planFor("production");
    expect(plan.selected.map((s) => ({ id: s.id, prod_safe: s.prod_safe, probes: s.probes }))).toEqual([
      { id: "auth-negative", prod_safe: true, probes: 0 },
      { id: "platform", prod_safe: true, probes: platform.probes.length },
    ]);
    expect(platform.probes.length).toBeGreaterThan(0);
    for (const p of packs) expect(p.destructive, p.id).toBe(false);
    expect(plan.refused).toEqual([]);
  });

  it("shows the staging-only tests as skipped, not run; staging skips none", async () => {
    const { plan, out } = await planFor("production");
    expect(plan.tests_skipped).toEqual(
      [
        "a valid CSP report is accepted",
        "an oversize CSP report is refused",
        "a cross-origin write that carries a session cookie is refused",
      ].map((test) => ({ pack: "platform", test, reason: "staging-only" })),
    );
    expect(out.some((l) => l.includes("a valid CSP report is accepted") && l.includes("skipped"))).toBe(true);
    expect((await planFor("staging")).plan.tests_skipped).toEqual([]);
  });

  it("the runner keeps tagged tests off production and leaves staging alone", () => {
    const plan = { selected: [{ id: "platform" }] } as Parameters<typeof buildInvocations>[0];
    const opts = { root: PACKAGE_ROOT, env: TARGET_ENV, outDir: "/out", cli: "/pw/cli.js" };
    const onProduction = buildInvocations(plan, packs, loadTarget(join(PACKAGE_ROOT, "targets"), "production", TARGET_ENV), opts);
    const onStaging = buildInvocations(plan, packs, loadTarget(join(PACKAGE_ROOT, "targets"), "staging", TARGET_ENV), opts);
    expect(onProduction[0]?.args).toEqual(expect.arrayContaining(["--grep-invert", "@staging-only"]));
    expect(onStaging[0]?.args).not.toContain("--grep-invert");
  });
});

describe("staging-only tests", () => {
  it("finds tagged titles and ignores the rest", () => {
    const text = 'test("a plain test", async () => {});\ntest("writes a thing @staging-only", async () => {});\ntest.skip(true, "x @staging-only");\n';
    expect(stagingOnlyTitles(text)).toEqual(["writes a thing"]);
  });

  it("the shipped specs tag exactly the tests that write", () => {
    expect(listStagingOnlyTests(join(PACKAGE_ROOT, "packs")).map((t) => `${t.pack}: ${t.test}`)).toEqual([
      "platform: a valid CSP report is accepted",
      "platform: an oversize CSP report is refused",
      "platform: a cross-origin write that carries a session cookie is refused",
    ]);
  });

  it("every tagged test skips itself unless the target is staging", () => {
    const spec = readFileSync(join(PACKAGE_ROOT, "packs", "platform", "platform.spec.ts"), "utf8");
    const tagged = spec.split("\n").filter((l) => l.includes('@staging-only", async'));
    expect(tagged).toHaveLength(3);
    expect(spec.match(/test\.skip\(target\.name !== "staging"/g)).toHaveLength(3);
  });
});

describe("the declared probes", () => {
  const declared = new Set(platform.probes.map((p) => `${p.method} ${p.path}`));

  it("cover every cron the app schedules", () => {
    const vercel = JSON.parse(readFileSync(join(PACKAGE_ROOT, "..", "web", "vercel.json"), "utf8")) as { crons: { path: string }[] };
    expect(vercel.crons.length).toBeGreaterThan(0);
    for (const cron of vercel.crons) expect(declared.has(`GET ${cron.path}`), cron.path).toBe(true);
  });

  it("include the kick routes and the gh-proxy route", () => {
    for (const key of ["POST /api/internal/run-actions/kick", "POST /api/cron/api-sweep", "GET /api/gh-proxy/probe/probe", "POST /api/csp-report", "POST /api/rum", "PATCH /api/v1/budgets"]) {
      expect(declared.has(key), key).toBe(true);
    }
  });
});
