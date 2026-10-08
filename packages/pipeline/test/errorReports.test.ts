import { describe, expect, it, onTestFinished } from "vitest";
import { configureErrorReporter, type ErrorClass } from "@fx/telemetry";
import { classifyWorkItem } from "../src/plan/classifier.js";
import { handleKick, signKick, sweepRunActions, type RunActionsWorker } from "../src/runActions/index.js";

/** The caught errors in the pipeline's kick, sweep and classify paths reach the error reporter as classes. */
const ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "kick-test-secret";
const SECRET_TEXT = "ghs_SecretTokenInAnErrorMessage";

function capture() {
  const lines: string[] = [];
  const classes: ErrorClass[] = [];
  configureErrorReporter({
    service: "test",
    write: (line) => void lines.push(line),
    sink: { record: (event) => void classes.push(event) },
  });
  onTestFinished(() => configureErrorReporter({ service: "app" }));
  return { classes, everything: () => `${lines.join("\n")}\n${JSON.stringify(classes)}` };
}

describe("pipeline caught errors are reported as classes", () => {
  it("a kick whose workflow start throws still answers 202 and reports run_actions.kick", async () => {
    const seen = capture();
    const body = `{"actionId":"${ID}"}`;
    const now = 1_700_000_000;
    const status = await handleKick(`t=${now},sig=${signKick(SECRET, now, body)}`, body, {
      secret: SECRET,
      nowSeconds: () => now,
      configured: () => true,
      startWorkflow: async () => {
        throw new Error(SECRET_TEXT);
      },
    });
    expect(status).toBe(202);
    expect(seen.classes).toMatchObject([{ service: "test", stage: "run_actions.kick" }]);
    expect(seen.everything()).not.toContain(SECRET_TEXT);
  });

  it("a sweep reports each id that would not start, and still starts the rest", async () => {
    const seen = capture();
    const started: string[] = [];
    const worker = {
      listDueRunActions: async () => ["a", "b", "c"],
      purgeRunActions: async () => 0,
    } as unknown as RunActionsWorker;
    const result = await sweepRunActions({
      worker,
      startWorkflow: async (id) => {
        if (id === "b") throw new Error(SECRET_TEXT);
        started.push(id);
      },
      log: () => {},
    });
    expect(started).toEqual(["a", "c"]);
    expect(result).toMatchObject({ listed: 3, started: 2 });
    expect(seen.classes.map((c) => c.stage)).toEqual(["run_actions.sweep"]);
    expect(seen.everything()).not.toContain(SECRET_TEXT);
  });

  it("a classifier that throws is { ok: false } and is reported as plan.classify", async () => {
    const seen = capture();
    const result = await classifyWorkItem(
      {
        complete: async () => {
          throw new Error(SECRET_TEXT);
        },
      },
      { title: "t", body: "b" },
    );
    expect(result).toEqual({ ok: false, reason: "classifier call failed" });
    expect(seen.classes.map((c) => c.stage)).toEqual(["plan.classify"]);
    expect(seen.everything()).not.toContain(SECRET_TEXT);
  });
});
