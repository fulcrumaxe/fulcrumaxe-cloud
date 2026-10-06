import { describe, expect, it, vi } from "vitest";
import { configureErrorReporter, createErrorReporter, reportError, type ErrorClass, type ErrorSink } from "../src/index.js";

// A message and a name a real failure would carry: neither may reach the line or the sink.
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const MESSAGE = `token ${TOKEN} for octo/repo`;

function harness(extra: { sink?: ErrorSink; service?: string } = {}) {
  const lines: string[] = [];
  const reporter = createErrorReporter({ service: extra.service ?? "web", write: (l) => lines.push(l), sink: extra.sink, now: () => 1_000_000 });
  return { reporter, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function recordingSink() {
  const events: ErrorClass[] = [];
  const sink: ErrorSink = { record: (e) => void events.push(e) };
  return { sink, events };
}

describe("reportError: the stdout line", () => {
  it("emits one line with the stage, a route template, the error name and a code, and none of the message", () => {
    const { reporter, lines, parsed } = harness();
    reporter.reportError(new Error(MESSAGE), { stage: "sync", route: "/api/github/webhook" });
    expect(lines).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({
      level: "error",
      service: "web",
      event: "error.reported",
      stage: "sync",
      route: "/api/github/webhook",
      error_name: "Error",
      error_code: "other",
    });
    for (const fragment of ["ghp_", "octo", "token", "for "]) expect(lines[0]).not.toContain(fragment);
    // "repo" is a word inside the event code (error.reported), so the check is for the word on its own.
    expect(lines[0]).not.toMatch(/\brepo\b/);
  });

  it("keeps ERR_*, errno, SQLSTATE and our own codes from the error, and a code given by the caller wins", () => {
    const { reporter, parsed } = harness();
    for (const code of ["ERR_INVALID_IP_ADDRESS", "ECONNRESET", "23505", "validation_failed"]) {
      reporter.reportError(Object.assign(new Error("x"), { code }), { stage: "sync", route: "/api/v1/runs" });
    }
    reporter.reportError(Object.assign(new Error("x"), { code: "ECONNRESET" }), { stage: "sync", route: "/", code: "not_found" });
    expect(parsed().map((p) => p.error_code)).toEqual(["ERR_INVALID_IP_ADDRESS", "ECONNRESET", "23505", "validation_failed", "not_found"]);
  });

  it("stores a code that is not on the allowlist as other, and never echoes it (code and reason fields alike)", () => {
    const { reporter, lines, parsed } = harness();
    reporter.reportError(Object.assign(new Error("x"), { code: "octocat" }), { stage: "sync", route: "/api/v1/runs" });
    reporter.reportError(Object.assign(new Error("x"), { reason: "my-repo" }), { stage: "sync", route: "/api/v1/runs" });
    reporter.reportError(new Error("x"), { stage: "sync", route: "/api/v1/runs", code: "octocat" });
    expect(parsed().map((p) => p.error_code)).toEqual(["other", "other", "other"]);
    for (const l of lines) {
      expect(l).not.toContain("octocat");
      expect(l).not.toContain("my-repo");
    }
  });

  it("replaces a stage outside its pattern and a service outside its pattern, never echoing either", () => {
    const { sink, events } = recordingSink();
    const { reporter, lines } = harness({ sink, service: "Octo Repo!" });
    reporter.reportError(new Error("x"), { stage: "octo/repo", route: "/api/v1/runs" });
    reporter.reportError(new Error("x"), { stage: "Sync", route: "/api/v1/runs" });
    expect(events.map((e) => [e.service, e.stage])).toEqual([["app", "unknown"], ["app", "unknown"]]);
    for (const l of lines) {
      expect(l).not.toContain("octo/repo");
      expect(l).not.toContain("Sync");
      expect(l).not.toContain("Octo");
    }
  });

  it("reduces the route to its template and uses / when it is not a path", () => {
    const { sink, events } = recordingSink();
    const { reporter } = harness({ sink });
    reporter.reportError(new Error("x"), { stage: "s", route: "/api/v1/runs/9b2f4c1e-0a53-4d7e-8f21-3c6a5b7d9e10/events?cursor=abc#frag" });
    reporter.reportError(new Error("x"), { stage: "s", route: "octo/repo" });
    reporter.reportError(new Error("x"), { stage: "s" });
    expect(events.map((e) => e.route)).toEqual(["/api/v1/runs/:id/events", "/", "/"]);
  });
});

describe("reportError: the sink", () => {
  it("hands the sink one class with four coded labels and nothing else", () => {
    const { sink, events } = recordingSink();
    const { reporter } = harness({ sink });
    reporter.reportError(Object.assign(new Error(MESSAGE), { code: "23505" }), { stage: "sync", route: "/api/v1/runs" });
    expect(events).toEqual([{ service: "web", route: "/api/v1/runs", stage: "sync", code: "23505" }]);
  });

  it("returns normally when the sink throws, rejects, or reports its own failure through the reporter", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const calls = { sync: 0, reentrant: 0 };
      const throwing: ErrorSink = {
        record: () => {
          calls.sync++;
          throw new Error("sink down");
        },
      };
      const rejecting = { record: () => Promise.reject(new Error("sink down")) } as unknown as ErrorSink;
      let again: (() => void) | undefined;
      const reentrant: ErrorSink = {
        record: () => {
          calls.reentrant++;
          again?.();
        },
      };
      for (const sink of [throwing, rejecting, reentrant]) {
        const { reporter, lines } = harness({ sink });
        again = () => reporter.reportError(new Error("sink failed"), { stage: "sink" });
        expect(() => reporter.reportError(new Error("x"), { stage: "s" })).not.toThrow();
        expect(lines.length).toBeGreaterThanOrEqual(1);
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(calls).toEqual({ sync: 1, reentrant: 1 });
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("survives an error whose code getter throws, and a non-Error throw", () => {
    const { sink, events } = recordingSink();
    const { reporter, lines } = harness({ sink });
    const hostile = new Error("x");
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("boom");
      },
    });
    for (const value of [hostile, "a string with octo/repo", null, undefined, 42, {}]) {
      expect(() => reporter.reportError(value, { stage: "s" })).not.toThrow();
    }
    expect(events).toHaveLength(6);
    expect(events.every((e) => e.code === "other")).toBe(true);
    expect(lines.join("\n")).not.toContain("octo");
  });
});

describe("the process-wide reporter", () => {
  it("writes to the configured sink and line target, and the default writes to stdout only", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      reportError(new Error("x"), { stage: "s", route: "/api/v1/runs" });
      expect(spy).toHaveBeenCalledTimes(1);
      const { sink, events } = recordingSink();
      const lines: string[] = [];
      configureErrorReporter({ service: "web", sink, write: (l) => lines.push(l) });
      reportError(new Error("x"), { stage: "s", route: "/api/v1/runs" });
      expect(events).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      configureErrorReporter({ service: "app" });
      spy.mockRestore();
    }
  });
});
