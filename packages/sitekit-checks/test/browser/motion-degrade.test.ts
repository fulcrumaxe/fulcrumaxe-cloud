import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run as degrade } from "../../src/extra/degrade.js";
import { run as motion } from "../../src/extra/motion.js";
import type { CheckResult } from "../../src/types.js";
import { createPlaywrightDriver } from "./playwright-driver.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
const TEMPLATE = path.resolve(import.meta.dirname, "../../../sitekit-template");
const kinds = (r: CheckResult): string[] => [...new Set(r.findings.map((f) => f.kind))];
const fast = { settleMs: 300 };

describe("check-motion in real Chromium", () => {
  it("passes a page whose animation and transition a reduced-motion rule switches off", async () => {
    const result = await motion(path.join(FIXTURES, "check-motion/pass"), { driver: createPlaywrightDriver() });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails the same page without the rule, naming the element", async () => {
    const result = await motion(path.join(FIXTURES, "check-motion/fail/with-motion"), { driver: createPlaywrightDriver() });
    expect(result.ok).toBe(false);
    expect(kinds(result)).toEqual(["motion_not_reduced"]);
    expect(result.findings.map((f) => f.selector)).toEqual(["div.spin"]);
  });

  it("gives a page that forges 500+ audit entries one fixed finding, none of its text", async () => {
    const result = await motion(path.join(FIXTURES, "check-motion/fail/hostile"), { driver: createPlaywrightDriver() });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["browser_result_invalid"]);
    expect(JSON.stringify(result)).not.toContain("evil.example");
  });

  it("passes a static page as a real pass", async () => {
    const result = await motion(path.join(FIXTURES, "check-motion/static"), { driver: createPlaywrightDriver() });
    expect(result).toMatchObject({ ok: true, findings: [], summary: { pages: 1, not_reported: 0 } });
  });
});

describe("check-degrade in real Chromium", () => {
  const api = path.join(FIXTURES, "check-degrade/api-fill");

  it("fails a page whose <main> is filled from /api/x when /api/* is blocked", async () => {
    const result = await degrade(api, { driver: createPlaywrightDriver(), ...fast });
    expect(result.ok).toBe(false);
    expect(kinds(result)).toEqual(["degrade_no_useful_text"]);
  });

  it("passes the same page, served with a static /api/x, once blockPaths is []", async () => {
    const result = await degrade(api, { driver: createPlaywrightDriver(), blockPaths: [], ...fast });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["loading", "degrade_no_useful_text"],
    ["short", "degrade_no_useful_text"],
    ["no-main", "degrade_no_main"],
  ])("fails the %s fixture as %s", async (name, kind) => {
    const result = await degrade(path.join(FIXTURES, "check-degrade/fail", name), { driver: createPlaywrightDriver(), ...fast });
    expect(result.ok, name).toBe(false);
    expect(kinds(result), name).toEqual([kind]);
  });
});

describe("the K03 fixture build output", () => {
  let out: string | undefined;
  const build = async (): Promise<string> => {
    if (!out) {
      out = await fs.mkdtemp(path.join(os.tmpdir(), "fx-k03-"));
      execFileSync("pnpm", ["exec", "tsx", "scripts/build-fixture.ts", "test/fixtures/site.json", out], { cwd: TEMPLATE, stdio: "pipe" });
    }
    return out;
  };
  afterAll(async () => {
    if (out) await fs.rm(out, { recursive: true, force: true });
  });

  it("passes check-degrade", async () => {
    const result = await degrade(await build(), { driver: createPlaywrightDriver(), ...fast });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes check-motion (the design package's reduced-motion reset is in)", async () => {
    const result = await motion(await build(), { driver: createPlaywrightDriver() });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
