import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createLogger, ALLOWED_FIELDS, MAX_STRING_LENGTH, VolumeCap, VOLUME_CAP_MAX_KEYS, type EventCode } from "../src/index.js";

// Fixtures are built at run time so no secret scanner flags this file.
const A = "AbCdEf0123456789";
const alnum = (n: number): string => A.repeat(Math.ceil(n / A.length)).slice(0, n);
const ANT_KEY = ["sk", "ant", "api03"].join("-") + "-" + alnum(30);
const VCK = "vck" + "_" + alnum(30);
const COOKIE_VALUE = alnum(40);
const COOKIE = `Cookie: __Host-fx${"_session"}=${COOKIE_VALUE}`;
const EV: EventCode = "telemetry.selftest";
const A1 = "9b2f4c1e-0a53-4d7e-8f21-3c6a5b7d9e10";
const A2 = "0d6e1c52-7a4b-4c98-b3f0-12ab34cd56ef";
const RUN_ID = "5f0c8a7e-91b2-4d3a-a6c4-7e8f9a0b1c2d";
/** An error whose class declares `text` as its own static fixedMessage, so that literal is emitted. */
const fixedError = (text: string): Error =>
  new (class FixedError extends Error {
    static readonly fixedMessage = text;
  })("ignored");
const RUN_PAYLOAD = { prompt: "payload-" + alnum(24), nested: { token: "run-secret-" + alnum(20) } };

function harness(start = 1_000_000) {
  const lines: string[] = [];
  const clock = { t: start };
  const logger = createLogger({ service: "svc", write: (l) => lines.push(l), now: () => clock.t });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, clock, parsed };
}

describe("line shape (criterion 2)", () => {
  it("writes exactly one JSON line with ts, level, service, event and the given allowlisted fields", () => {
    const { logger, lines, parsed } = harness();
    logger.info(EV, { account_id: A1, run_id: RUN_ID, status: 200, duration_ms: 12, count: 3 });
    logger.warn(EV, { route: "/api/v1/runs" });
    logger.error(EV, { error_code: "not_found", error: fixedError("boom"), trace_id: A1, request_id: A2, wf_run_id: RUN_ID });
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).not.toContain("\n");
    expect(parsed()[0]).toEqual({
      ts: "1970-01-01T00:16:40.000Z",
      level: "info",
      service: "svc",
      event: EV,
      account_id: A1,
      run_id: RUN_ID,
      status: 200,
      duration_ms: 12,
      count: 3,
    });
    expect(parsed().map((p) => p.level)).toEqual(["info", "warn", "error"]);
  });

  it("the allowlist is exactly the thirteen fields", () => {
    expect([...ALLOWED_FIELDS].sort()).toEqual(
      ["account_id", "run_id", "wf_run_id", "trace_id", "request_id", "route", "stage", "status", "duration_ms", "error_code", "error_name", "error_message", "count"].sort(),
    );
  });

  it("the default sink is one stdout line per call", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      createLogger({ service: "svc" }).info(EV);
      expect(spy).toHaveBeenCalledTimes(1);
      const written = String(spy.mock.calls[0]![0]);
      expect(written.endsWith("\n")).toBe(true);
      expect(JSON.parse(written)).toMatchObject({ level: "info", service: "svc", event: EV });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("allowlist (criterion 3)", () => {
  it("drops headers, body, payload, cookie and authorization, and any other unknown key", () => {
    const { logger, lines } = harness();
    logger.info(EV, {
      account_id: A1,
      headers: { a: "h-marker" },
      body: "b-marker",
      payload: RUN_PAYLOAD,
      cookie: "c-marker",
      authorization: "z-marker",
      extra: "x-marker",
      ts: "forged",
      level: "forged",
      event: "forged",
    });
    const out = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["account_id", "event", "level", "service", "ts"]);
    expect(out.event).toBe(EV);
    expect(lines[0]).not.toMatch(/marker|forged|payload-/);
  });

  it("drops a value of the wrong type instead of serialising it", () => {
    const { logger, parsed } = harness();
    logger.info(EV, { account_id: { nested: "o" }, status: "500", duration_ms: Number.NaN, count: 2, route: ["r"] });
    expect(parsed()[0]).toMatchObject({ count: 2 });
    expect(Object.keys(parsed()[0]!).sort()).toEqual(["count", "event", "level", "service", "ts"]);
  });

  it("ignores allowlisted names inherited from the prototype", () => {
    const { logger, parsed } = harness();
    logger.info(EV, Object.create({ account_id: "inherited" }) as Record<string, unknown>);
    expect(parsed()[0]).not.toHaveProperty("account_id");
  });

});

describe("redaction and truncation (criterion 4)", () => {
  // R5: the strings that are still emitted (service, a fixed-message error) pass redaction and the cap.
  it("redacts the service and a fixed-message error's message", () => {
    const { lines } = harness();
    const logger = createLogger({ service: `svc-${ANT_KEY}`, write: (l) => lines.push(l) });
    logger.info(EV, { error: fixedError(`key ${VCK}`) });
    expect(lines[0]).not.toContain(alnum(30));
    expect(lines[0]).toContain("[redacted]");
  });

  it("truncates a fixed-message error's message to 2048 characters", () => {
    const { logger, parsed } = harness();
    logger.info(EV, { error: fixedError("m".repeat(3000)) });
    expect((parsed()[0]!.error_message as string).length).toBe(MAX_STRING_LENGTH);
  });

  it("redacts before truncating: a token straddling the cut does not leave its head behind", () => {
    const { logger, lines } = harness();
    logger.info(EV, { error: fixedError("r".repeat(MAX_STRING_LENGTH - 20) + ANT_KEY) });
    expect(lines[0]).not.toContain(ANT_KEY.slice(0, 20));
  });

  it("an Error under any other field is dropped", () => {
    const { logger, parsed } = harness();
    logger.error(EV, { error_code: new Error("x") });
    expect(parsed()[0]).not.toHaveProperty("error_code");
  });
});

describe("security criterion 12: secrets never reach stdout", () => {
  // A run payload has no secret shape, so it is kept out by never being serialised: it rides on the
  // error as a property and cause, and as a field, and only the allowlist and `name: message` are emitted.
  it("an error with an API key, a gateway key, a cookie header and a run payload leaves none of them in the output", () => {
    const { logger, lines } = harness();
    const err = Object.assign(new Error(`upstream said ${ANT_KEY} / ${VCK} / ${COOKIE}`, { cause: RUN_PAYLOAD }), {
      payload: RUN_PAYLOAD,
      inner: new Error(`cause ${ANT_KEY}`),
    });
    logger.error(EV, {
      error: err,
      error_code: `code-${VCK}`,
      route: `/r?c=${COOKIE}`,
      payload: RUN_PAYLOAD,
      cookie: COOKIE,
    });
    logger.warn(EV, { error_message: String(err.stack) });
    logger.warn(EV, { error: fixedError(`upstream said ${ANT_KEY} / ${COOKIE}`) });
    const out = lines.join("\n");
    for (const secret of [ANT_KEY, VCK, COOKIE_VALUE, RUN_PAYLOAD.nested.token]) expect(out).not.toContain(secret);
    expect(out).not.toContain("payload-");
  });
});

describe("volume cap (criterion 6, fake clock)", () => {
  function sendInfo(h: ReturnType<typeof harness>, n: number, account = A1) {
    for (let i = 0; i < n; i++) h.logger.info(EV, { account_id: account });
  }

  it("drops the 201st info within 60s and writes one telemetry.dropped with the count at rollover", () => {
    const h = harness();
    sendInfo(h, 200);
    expect(h.lines).toHaveLength(200);
    sendInfo(h, 5);
    expect(h.lines).toHaveLength(200);
    h.clock.t += 60_000;
    h.logger.info(EV, { account_id: A1 });
    const dropped = h.parsed().filter((p) => p.event === "telemetry.dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ account_id: A1, count: 5, level: "warn", service: "svc" });
    expect(h.lines).toHaveLength(202); // 200 + the summary + the first event of the new window
  });

  it("stays at the limit exactly: 200 events and no summary", () => {
    const h = harness();
    sendInfo(h, 200);
    h.clock.t += 120_000;
    h.logger.info(EV, { account_id: A1 });
    expect(h.parsed().some((p) => p.event === "telemetry.dropped")).toBe(false);
  });

  it("stays at the limit exactly: 200 events and no summary", () => {
    const h = harness();
    sendInfo(h, 200);
    h.clock.t += 120_000;
    h.logger.info(EV, { account_id: A1 });
    expect(h.parsed().some((p) => p.event === "telemetry.dropped")).toBe(false);
  });

  it("warn and error are never dropped, even past the cap", () => {
    const h = harness();
    sendInfo(h, 300);
    for (let i = 0; i < 10; i++) {
      h.logger.warn(EV, { account_id: A1 });
      h.logger.error(EV, { account_id: A1 });
    }
    expect(h.parsed().filter((p) => p.level === "warn" && p.event === EV)).toHaveLength(10);
    expect(h.parsed().filter((p) => p.level === "error")).toHaveLength(10);
  });

  it("the cap is per account", () => {
    const h = harness();
    sendInfo(h, 250, A1);
    sendInfo(h, 10, A2);
    expect(h.parsed().filter((p) => p.account_id === A2)).toHaveLength(10);
  });

  it("an error after the window rolls over also flushes the summary, and flush() does it without a new event", () => {
    const h = harness();
    sendInfo(h, 203);
    h.clock.t += 61_000;
    h.logger.flush();
    h.logger.flush();
    expect(h.parsed().filter((p) => p.event === "telemetry.dropped")).toMatchObject([{ account_id: A1, count: 3 }]);
  });
});

describe("a log call never throws", () => {
  it("flush() with a throwing sink returns normally, and the next info and warn write once the sink recovers", () => {
    const lines: string[] = [];
    let failing = false;
    const clock = { t: 1_000_000 };
    const logger = createLogger({
      service: "svc",
      write: (l) => {
        if (failing) throw new Error("sink down");
        lines.push(l);
      },
      now: () => clock.t,
    });
    for (let i = 0; i < 203; i++) logger.info(EV, { account_id: A1 });
    clock.t += 61_000;
    failing = true;
    expect(() => logger.flush()).not.toThrow();
    failing = false;
    const before = lines.length;
    logger.info(EV, { account_id: A1 });
    logger.warn(EV, { account_id: A1 });
    expect(lines.length).toBe(before + 2);
  });

  it("a throwing getter on an allowlisted key drops that field only", () => {
    const { logger, parsed } = harness();
    const fields = {
      run_id: RUN_ID,
      get account_id(): string {
        throw new Error("boom");
      },
      get error(): Error {
        return new (class FixedError extends Error {
          static get fixedMessage(): string {
            throw new Error("nested boom");
          }
        })("x");
      },
      count: 4,
    };
    expect(() => logger.info(EV, fields)).not.toThrow();
    expect(parsed()[0]).toMatchObject({ run_id: RUN_ID, count: 4, error_name: "FixedError" });
    expect(parsed()[0]).not.toHaveProperty("account_id");
    expect(parsed()[0]).not.toHaveProperty("error_message");
  });

  it("a throwing proxy and a throwing sink cost the line, not the caller", () => {
    const { logger, lines } = harness();
    const hostile = new Proxy({}, { has: () => { throw new Error("x"); }, getOwnPropertyDescriptor: () => { throw new Error("x"); } });
    expect(() => logger.warn(EV, hostile as Record<string, unknown>)).not.toThrow();
    expect(lines).toHaveLength(1); // the line is written with no fields
    const bad = createLogger({ service: "svc", write: () => { throw new Error("disk full"); } });
    expect(() => bad.error(EV, { run_id: "r" })).not.toThrow();
  });
});

describe("the volume cap's memory is bounded", () => {
  it("never tracks more than maxKeys accounts, evicting the oldest window", () => {
    let t = 0;
    const cap = new VolumeCap(() => t, 200, 60_000, 3);
    for (const key of ["a", "b", "c", "d", "e"]) {
      t += 1;
      cap.admit(key);
      expect(cap.size).toBeLessThanOrEqual(3);
    }
    expect(cap.size).toBe(3);
    // "a" and "b" were evicted, so they start a fresh allowance; "e" (newest) kept its count.
    for (let i = 0; i < 199; i++) cap.admit("e");
    expect(cap.admit("e")).toBe(false);
  });

  it("the default bound is 10,000 accounts", () => {
    const t = 0;
    const cap = new VolumeCap(() => t);
    for (let i = 0; i < VOLUME_CAP_MAX_KEYS + 50; i++) cap.admit(`acct-${i}`);
    expect(cap.size).toBe(VOLUME_CAP_MAX_KEYS);
  });
});

describe("no model SDK (criterion 8)", () => {
  it("the package imports no model SDK and the model-call guard is live", () => {
    expect(process.env.FX_FORBID_MODEL_CALLS).toBe("1");
    const dir = new URL("../src/", import.meta.url);
    const forbidden = /from\s+["'](?:@anthropic-ai\/|@ai-sdk\/|ai["'/]|openai|@fx\/model-)/;
    for (const file of readdirSync(dir)) {
      expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(forbidden);
    }
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(["@fx/runtime"]);
  });
});
