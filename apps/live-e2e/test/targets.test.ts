import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTarget, parseTarget, targetGuard, TargetError } from "../src/targets.js";
import { makePack, makeTarget, PACKAGE_ROOT, scratchRoot, makeIo, tmpDir, TARGET_ENV } from "./helpers.js";
import { main } from "../src/cli.js";

const TARGETS = join(PACKAGE_ROOT, "targets");

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a throw");
}

describe("targets: the shipped files", () => {
  it("load, carry the matching name, and keep staging and production apart", () => {
    const staging = loadTarget(TARGETS, "staging", TARGET_ENV);
    const production = loadTarget(TARGETS, "production", TARGET_ENV);
    expect(staging.name).toBe("staging");
    expect(production.name).toBe("production");
    expect(staging.origin).not.toBe(production.origin);
    expect(staging.project_id).not.toBe(production.project_id);
    // Only names of env values are committed, never values.
    for (const t of [staging, production]) for (const e of t.env) expect(e).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("the env names a target lists include what the env-only needs read", () => {
    expect(loadTarget(TARGETS, "staging", TARGET_ENV).env).toEqual(expect.arrayContaining(["VERCEL_AUTOMATION_BYPASS_SECRET", "LIVE_E2E_STRIPE_RESTRICTED_KEY"]));
  });
});

describe("targets: deployment values come from the environment", () => {
  it("resolves origin and project id from the named variables when they are set", () => {
    const t = loadTarget(TARGETS, "staging", TARGET_ENV);
    expect(t.origin).toBe("https://staging.example.test");
    expect(t.project_id).toBe("prj_Staging1");
  });

  it("fails closed, naming the variable, when one is unset or empty; there is no default host", () => {
    expect(messageOf(() => loadTarget(TARGETS, "staging", {}))).toContain("LIVE_E2E_STAGING_ORIGIN");
    expect(messageOf(() => loadTarget(TARGETS, "staging", {}))).toContain("LIVE_E2E_STAGING_PROJECT_ID");
    const noProject = { ...TARGET_ENV, LIVE_E2E_STAGING_PROJECT_ID: undefined };
    expect(messageOf(() => loadTarget(TARGETS, "staging", noProject))).toContain("LIVE_E2E_STAGING_PROJECT_ID");
    expect(messageOf(() => loadTarget(TARGETS, "staging", { ...TARGET_ENV, LIVE_E2E_STAGING_ORIGIN: "  " }))).toContain("LIVE_E2E_STAGING_ORIGIN");
  });

  it("the plan command exits 2 naming the variable when the staging origin is unset", async () => {
    const root = scratchRoot([]);
    const { io, err } = makeIo(root, { LIVE_E2E_STAGING_ORIGIN: undefined });
    expect(await main(["plan", "--target", "staging", "--tier", "smoke"], io)).toBe(2);
    expect(err.join("\n")).toContain("LIVE_E2E_STAGING_ORIGIN");
  });

  it("no committed file under targets/ carries a literal host or project id", () => {
    for (const f of ["staging.json", "production.json"]) {
      const text = readFileSync(join(TARGETS, f), "utf8");
      expect(text, f).not.toMatch(/https?:\/\//);
      expect(text, f).not.toMatch(/prj_/);
    }
  });
});

describe("targets: strict schema (no destructive switch of any kind)", () => {
  const good = (): Record<string, unknown> => JSON.parse(readFileSync(join(TARGETS, "production.json"), "utf8")) as Record<string, unknown>;

  it("names the key when production.json gains allow_destructive, and with the key removed it loads again", () => {
    const dir = tmpDir();
    cpSync(TARGETS, dir, { recursive: true });
    writeFileSync(join(dir, "production.json"), JSON.stringify({ ...good(), allow_destructive: true }));
    expect(messageOf(() => loadTarget(dir, "production", TARGET_ENV))).toContain('unknown key "allow_destructive"');
    writeFileSync(join(dir, "production.json"), JSON.stringify(good()));
    expect(loadTarget(dir, "production", TARGET_ENV).name).toBe("production");
  });

  it("rejects any unknown key, nested or not", () => {
    expect(messageOf(() => parseTarget({ ...good(), anything: 1 }, "production", TARGET_ENV))).toContain('unknown key "anything"');
    expect(messageOf(() => parseTarget({ ...good(), budget_usd: { default: 0, max: 0, force: true } }, "production", TARGET_ENV))).toContain('unknown key "budget_usd.force"');
  });

  it("rejects missing keys, a name that does not match the file, a non-exact or non-https origin, values in env", () => {
    const noOrigin = good();
    delete noOrigin.origin_env;
    expect(messageOf(() => parseTarget(noOrigin, "production", TARGET_ENV))).toContain('missing key "origin_env"');
    expect(messageOf(() => parseTarget(good(), "staging", TARGET_ENV))).toContain('"name" must equal "staging"');
    for (const origin of ["http://x.example.test", "https://x.example.test/", "https://x.example.test/path", "x.example.test", "https://user@x.example.test"]) {
      const env = { ...TARGET_ENV, LIVE_E2E_PRODUCTION_ORIGIN: origin };
      expect(messageOf(() => parseTarget(good(), "production", env)), origin).toContain('"origin_env"');
    }
    expect(messageOf(() => parseTarget(good(), "production", { ...TARGET_ENV, LIVE_E2E_PRODUCTION_PROJECT_ID: "nope" }))).toContain('"project_id_env"');
    expect(messageOf(() => parseTarget({ ...good(), env: ["token=abc"] }, "production", TARGET_ENV))).toContain('"env"');
    expect(messageOf(() => parseTarget({ ...good(), budget_usd: { default: 9, max: 1 } }, "production", TARGET_ENV))).toContain("must not exceed");
  });

  it("rejects an unknown target name and a missing file", () => {
    expect(messageOf(() => loadTarget(TARGETS, "../staging"))).toContain("unknown target");
    expect(messageOf(() => loadTarget(TARGETS, "preview"))).toContain("unknown target");
    expect(() => loadTarget(tmpDir(), "staging")).toThrow(TargetError);
  });
});

describe("targets: layer 1 (target guard)", () => {
  const production = makeTarget({ name: "production" });
  const staging = makeTarget({ name: "staging" });

  it("refuses a destructive pack on production, even one that lists production", () => {
    expect(targetGuard(makePack({ id: "d", destructive: true, targets: ["staging", "production"] }), production)).toBe("destructive-on-production");
    expect(targetGuard(makePack({ id: "d", destructive: true, targets: ["staging"] }), production)).toBe("destructive-on-production");
  });

  it("refuses a non-destructive pack on production unless it lists production", () => {
    expect(targetGuard(makePack({ id: "s", targets: ["staging"] }), production)).toBe("not-listed-for-production");
    expect(targetGuard(makePack({ id: "s", targets: ["staging", "production"] }), production)).toBeNull();
  });

  it("lets a destructive pack through on staging when it lists staging, and refuses it when it does not", () => {
    expect(targetGuard(makePack({ id: "d", destructive: true, targets: ["staging"] }), staging)).toBeNull();
    expect(targetGuard(makePack({ id: "d", targets: ["production"] }), staging)).toBe("not-listed-for-staging");
  });

  it("end to end: plan --target production --pack <destructive fixture> exits non-zero with REFUSED destructive-on-production", async () => {
    const root = scratchRoot([makePack({ id: "wipe", destructive: true, tier: "standard", targets: ["staging", "production"] })]);
    const { io, err, out } = makeIo(root);
    const code = await main(["plan", "--target", "production", "--pack", "wipe"], io);
    expect(code).not.toBe(0);
    expect(err.join("\n")).toContain("REFUSED destructive-on-production");
    expect(out.join("\n")).toContain("wipe: REFUSED destructive-on-production");
  });

  it("end to end: the same pack inside a --tier full selection, not named, is listed REFUSED and not run, with exit 0", async () => {
    const root = scratchRoot([
      makePack({ id: "wipe", destructive: true, tier: "standard", targets: ["staging", "production"] }),
      makePack({ id: "ping", tier: "smoke", targets: ["staging", "production"] }),
    ]);
    const { io, out } = makeIo(root);
    const code = await main(["plan", "--target", "production", "--tier", "full", "--out", "plan.json"], io);
    expect(code).toBe(0);
    expect(out).toContain("wipe: REFUSED destructive-on-production");
    const plan = JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as { selected: { id: string }[]; refused: { id: string }[] };
    expect(plan.selected.map((s) => s.id)).toEqual(["ping"]);
    expect(plan.refused.map((s) => s.id)).toEqual(["wipe"]);
  });

  it("with the key removed from production.json the refusal still holds (the guard is code, not config)", async () => {
    const root = scratchRoot([makePack({ id: "wipe", destructive: true, tier: "standard", targets: ["staging", "production"] })]);
    writeFileSync(join(root, "targets", "production.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(TARGETS, "production.json"), "utf8")) }));
    const { io, err } = makeIo(root);
    expect(await main(["plan", "--target", "production", "--pack", "wipe"], io)).toBe(1);
    expect(err.join("\n")).toContain("REFUSED destructive-on-production");
  });

  it("end to end: a production.json with allow_destructive makes plan fail at load (exit 2) naming the key", async () => {
    const root = scratchRoot([makePack({ id: "ping", targets: ["staging", "production"] })]);
    writeFileSync(join(root, "targets", "production.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(TARGETS, "production.json"), "utf8")), allow_destructive: true }));
    const { io, err } = makeIo(root);
    expect(await main(["plan", "--target", "production", "--tier", "smoke"], io)).toBe(2);
    expect(err.join("\n")).toContain("allow_destructive");
  });
});
