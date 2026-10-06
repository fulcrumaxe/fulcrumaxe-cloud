import { describe, expect, it } from "vitest";
import { createVercelKeepAlive } from "../src/keepAlive.js";

/** PREVIEW-AGENT-LAUNCH: the keep-alive reads the platform's request-context slot; it is loud on Vercel and quiet elsewhere. */

const SLOT = Symbol.for("@vercel/request-context");

function harness(env: Record<string, string | undefined>, holder: object) {
  const warned: string[] = [];
  const reported: { stage: string }[] = [];
  const waited: Promise<unknown>[] = [];
  const keepAlive = createVercelKeepAlive((w) => void waited.push(w), holder, { env, warn: (l) => void warned.push(l), report: (_e, ctx) => void reported.push(ctx) });
  return { keepAlive, warned, reported, waited };
}

describe("createVercelKeepAlive", () => {
  it("hands the work to the invocation's waitUntil, quietly", () => {
    const holder = { [SLOT]: { get: () => ({ waitUntil: () => undefined }) } };
    const h = harness({ VERCEL: "1" }, holder);
    const work = Promise.resolve();
    h.keepAlive(work);
    expect(h.waited).toEqual([work]); // the library's waitUntil is what extends the invocation
    expect(h.warned).toEqual([]);
    expect(h.reported).toEqual([]);
  });

  it("on Vercel, a missing slot, context or waitUntil is reported with a fixed code, every time", () => {
    for (const holder of [{}, { [SLOT]: { get: () => undefined } }, { [SLOT]: { get: () => ({}) } }, { [SLOT]: {} }]) {
      const h = harness({ VERCEL: "1" }, holder);
      h.keepAlive(Promise.resolve());
      h.keepAlive(Promise.resolve());
      expect(h.warned).toEqual([JSON.stringify({ event: "run.keep_alive_unavailable" }), JSON.stringify({ event: "run.keep_alive_unavailable" })]);
      expect(h.reported).toEqual([{ stage: "run.keep_alive" }, { stage: "run.keep_alive" }]);
    }
  });

  it("off Vercel the same gaps are quiet: the work just runs on", () => {
    for (const holder of [{}, { [SLOT]: { get: () => ({}) } }]) {
      const h = harness({}, holder);
      expect(() => h.keepAlive(Promise.resolve())).not.toThrow();
      expect(h.warned).toEqual([]);
      expect(h.reported).toEqual([]);
    }
  });

  it("reads the context at call time, so one keep-alive serves every invocation", () => {
    let context: object | undefined = { waitUntil: () => undefined };
    const holder = { [SLOT]: { get: () => context } };
    const h = harness({ VERCEL: "1" }, holder);
    h.keepAlive(Promise.resolve());
    context = undefined; // the next invocation has none
    h.keepAlive(Promise.resolve());
    expect(h.waited).toHaveLength(1);
    expect(h.warned).toHaveLength(1);
  });
});
