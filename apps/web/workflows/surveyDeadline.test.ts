import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const sleeps: Date[] = [];
vi.mock("workflow", () => ({ sleep: async (d: Date) => void sleeps.push(d) }));
const looks: Array<{ final: true } | { final: false; wakeAt: string }> = [];
const seen: unknown[] = [];
vi.mock("../lib/worker", () => ({ getWorker: async () => ({ endSurveyAtDeadline: async (a: unknown) => (seen.push(a), looks.shift()!) }) }));

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = { accountId: "a", setupId: "s", runId: "r" };

/** D#845 ON-10b2: the deadline Workflow looks through the worker facade, sleeps until the time it is told, stops when a look is final, and is bounded. */
describe("the survey deadline workflow", () => {
  it("looks, sleeps until each wakeAt, and returns when a look is final", async () => {
    sleeps.length = 0;
    seen.length = 0;
    looks.push({ final: false, wakeAt: "2026-11-23T12:00:00.000Z" }, { final: false, wakeAt: "2026-11-23T12:05:00.000Z" }, { final: true });
    const { surveyDeadlineWorkflow } = await import("./surveyDeadline");
    expect(await surveyDeadlineWorkflow(ARGS)).toBe("final");
    expect(sleeps.map((d) => d.toISOString())).toEqual(["2026-11-23T12:00:00.000Z", "2026-11-23T12:05:00.000Z"]);
    expect(seen).toEqual([ARGS, ARGS, ARGS]);
  });

  it("is bounded at 6 looks for a run that never changes", async () => {
    sleeps.length = 0;
    seen.length = 0;
    for (let i = 0; i < 20; i++) looks.push({ final: false, wakeAt: "2026-11-23T12:00:00.000Z" });
    const { surveyDeadlineWorkflow } = await import("./surveyDeadline");
    expect(await surveyDeadlineWorkflow(ARGS)).toBe("gave_up");
    expect(seen).toHaveLength(6);
    looks.length = 0;
  });

  it("its step fails (to be retried) while no worker is configured", async () => {
    vi.resetModules();
    vi.doMock("../lib/worker", () => ({ getWorker: async () => null }));
    const { surveyDeadlineStep } = await import("./surveyDeadline");
    await expect(surveyDeadlineStep(ARGS)).rejects.toThrow("no worker configured");
    vi.doUnmock("../lib/worker");
  });

  it("the file reaches the database only through the worker facade: no pool, pg or SQL import", () => {
    const source = readFileSync(join(HERE, "surveyDeadline.ts"), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../lib/worker", "workflow"]);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/Pool\b|from "pg"|SELECT |INSERT |UPDATE /);
  });
});
