import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { sanitizeString } from "../src/fields.js";
import { createLogger, isEventCode, type EventCode } from "../src/index.js";

// Free text cannot be told from a payload by shape, so the logger must not carry any. These tests use a
// payload with no secret shape (words, not tokens), so redaction cannot be what keeps it out.
let seed = 7;
const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const WORDS = Array.from({ length: 40 }, () => Array.from({ length: 7 }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join(""));
const PAYLOAD = Array.from({ length: 25 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ").slice(0, 200);
const ACCOUNT = "9b2f4c1e-0a53-4d7e-8f21-3c6a5b7d9e10";

function harness() {
  const lines: string[] = [];
  const log = createLogger({ service: "svc", write: (l) => lines.push(l), now: () => 1_000_000 });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** True when any 8-character window of the payload appears in the haystack. */
function leaksPayload(haystack: string): boolean {
  for (let i = 0; i + 8 <= PAYLOAD.length; i++) if (haystack.includes(PAYLOAD.slice(i, i + 8))) return true;
  return false;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

class FixedError extends Error {
  static readonly fixedMessage: string = "queue is paused";
}
class SubFixedError extends FixedError {}
class OwnFixedError extends FixedError {
  static readonly fixedMessage = "queue is draining";
}
class NotStringError extends Error {
  static readonly fixedMessage: unknown = true;
}

describe("OPS-T1b criterion 1: the event is a registered code at compile time", () => {
  it("a template literal and an unregistered string do not compile; a registered code does", () => {
    const { log } = harness();
    const y = String(PAYLOAD.length);
    const compileOnly = (): void => {
      // @ts-expect-error a built string is not an EventCode
      log.info(`x.${y}`);
      // @ts-expect-error not in the registry
      log.info("not.registered");
      log.info("telemetry.selftest");
    };
    expect(compileOnly).toBeTypeOf("function");
    const code: EventCode = "telemetry.selftest";
    expect(isEventCode(code)).toBe(true);
  });
});

describe("OPS-T1b criterion 2 (replaces T1 criterion 2's free-form event): the registry is checked at runtime", () => {
  it("an event that bypasses the types is not emitted; the line says telemetry.invalid_event", () => {
    const { log, lines, parsed } = harness();
    const bypass = log.info as (event: string) => void;
    bypass("not.registered");
    bypass(`run.${PAYLOAD}`);
    bypass("Has.Upper");
    bypass("one");
    expect(parsed().map((p) => p.event)).toEqual(Array(4).fill("telemetry.invalid_event"));
    expect(lines.join("\n")).not.toMatch(/not\.registered|Has\.Upper|one"/);
    expect(leaksPayload(lines.join("\n"))).toBe(false);
  });
});

describe("OPS-T1b criterion 3 (replaces T1 criterion 4's error_message): no error text reaches stdout", () => {
  it("the payload is immune to redaction, so only never emitting it keeps it out", () => {
    expect(sanitizeString(PAYLOAD)).toBe(PAYLOAD);
  });

  it("an Error whose message embeds the payload and a zod-like error whose issues carry it emit neither", () => {
    const { log, lines } = harness();
    const quoted = new Error("input: " + PAYLOAD, { cause: { received: PAYLOAD } });
    const zodLike = Object.assign(new Error("validation failed"), {
      name: "ZodError",
      issues: [{ code: "invalid_type", received: PAYLOAD, path: ["body"] }],
    });
    const pgLike = Object.assign(new Error(`Key (email)=(${PAYLOAD}) already exists.`), { code: "23505" });
    log.error("telemetry.selftest", { error: quoted });
    log.error("telemetry.selftest", { error: zodLike, route: "/api/v1/runs" });
    log.error("telemetry.selftest", { error: pgLike });
    log.warn("telemetry.selftest", { error: PAYLOAD, error_code: PAYLOAD, error_name: PAYLOAD, error_message: PAYLOAD });
    expect(lines).toHaveLength(4);
    expect(leaksPayload(lines.join("\n"))).toBe(false);
    expect(lines.join("\n")).not.toContain("error_message");
  });
});

describe("OPS-T1b criterion 4 (replaces T1 criterion 4): an Error is its class name and code", () => {
  it("an ApiError emits error_name and error_code, and no part of its message", () => {
    const { log, lines, parsed } = harness();
    log.error("telemetry.selftest", { error: new ApiError(422, "validation_failed", PAYLOAD) });
    expect(parsed()[0]).toMatchObject({ error_name: "ApiError", error_code: "validation_failed" });
    expect(parsed()[0]).not.toHaveProperty("error_message");
    expect(leaksPayload(lines[0]!)).toBe(false);
  });

  it("a class's own static fixedMessage literal is emitted, never the error's message", () => {
    const { log, lines, parsed } = harness();
    log.error("telemetry.selftest", { error: new FixedError(`bad ${PAYLOAD}`) });
    expect(parsed()[0]).toMatchObject({ error_name: "FixedError", error_message: "queue is paused" });
    expect(leaksPayload(lines[0]!)).toBe(false);
  });

  it("a subclass constructed with user input emits no user text and inherits no parent text", () => {
    const { log, lines, parsed } = harness();
    log.error("telemetry.selftest", { error: new SubFixedError(`bad ${PAYLOAD}`) });
    log.error("telemetry.selftest", { error: new OwnFixedError(`bad ${PAYLOAD}`) });
    expect(parsed()[0]).toMatchObject({ error_name: "SubFixedError" });
    expect(parsed()[0]).not.toHaveProperty("error_message");
    expect(parsed()[1]).toMatchObject({ error_name: "OwnFixedError", error_message: "queue is draining" });
    expect(leaksPayload(lines.join("\n"))).toBe(false);
  });

  it("a fixedMessage that is not a string emits no message", () => {
    const { log, lines, parsed } = harness();
    log.error("telemetry.selftest", { error: new NotStringError(`bad ${PAYLOAD}`) });
    expect(parsed()[0]).toMatchObject({ error_name: "NotStringError" });
    expect(parsed()[0]).not.toHaveProperty("error_message");
    expect(leaksPayload(lines[0]!)).toBe(false);
  });

  it("an error name or code that fails its pattern is dropped, and an explicit error_code wins", () => {
    const { log, parsed } = harness();
    class Bad extends Error {}
    Object.defineProperty(Bad, "name", { value: "has space" });
    log.error("telemetry.selftest", { error: Object.assign(new Bad("x"), { code: "NOT-A-CODE" }) });
    log.error("telemetry.selftest", { error: Object.assign(new Error("x"), { code: "from_error" }), error_code: "not_found" });
    expect(parsed()[0]).not.toHaveProperty("error_name");
    expect(parsed()[0]).not.toHaveProperty("error_code");
    expect(parsed()[1]).toMatchObject({ error_name: "Error", error_code: "not_found" });
  });

  it("error_code accepts only a code on the allowlist (our codes, SQLSTATE, Node ERR_*, errno, Stripe), and nothing else", () => {
    const { log, parsed } = harness();
    const codes = ["validation_failed", "23505", "42P01", "ERR_INVALID_IP_ADDRESS", "ECONNRESET", "card_declined", "octocat", "abc 23505", "2350", "235055", "23a05", "REPOS"];
    for (const code of codes) {
      log.error("telemetry.selftest", { error: Object.assign(new Error("x"), { code }) });
    }
    expect(parsed().map((p) => p.error_code)).toEqual([
      "validation_failed",
      "23505",
      "42P01",
      "ERR_INVALID_IP_ADDRESS",
      "ECONNRESET",
      "card_declined",
      ...Array(6).fill(undefined),
    ]);
  });

  it("a caller-supplied error_name or error_message is dropped", () => {
    const { log, parsed } = harness();
    log.error("telemetry.selftest", { error_name: "Spoofed", error_message: PAYLOAD });
    expect(parsed()[0]).not.toHaveProperty("error_name");
    expect(parsed()[0]).not.toHaveProperty("error_message");
  });

  it("a throwing code getter costs error_code only, not error_name", () => {
    const { log, parsed } = harness();
    const err = new ApiError(500, "x", "m");
    Object.defineProperty(err, "code", {
      get() {
        throw new Error("boom");
      },
    });
    expect(() => log.error("telemetry.selftest", { error: err })).not.toThrow();
    expect(parsed()[0]).toMatchObject({ error_name: "ApiError" });
    expect(parsed()[0]).not.toHaveProperty("error_code");
  });
});

describe("OPS-T1b criterion 5 (R2): fields are typed, and a bad value is absent", () => {
  it("route is a template with no query or fragment, and unknown segments become :id", () => {
    const { log, parsed } = harness();
    log.info("telemetry.selftest", { route: `/api/v1/runs/${ACCOUNT}/events?cursor=abc#x` });
    log.info("telemetry.selftest", { route: "/api/v1/runs/abc?code=secret" });
    log.info("telemetry.selftest", { route: "not-a-path" });
    expect(parsed()[0]!.route).toBe("/api/v1/runs/:id/events");
    expect(parsed()[1]!.route).toBe("/api/v1/runs/:id");
    expect(parsed()[2]).not.toHaveProperty("route");
  });

  it("an id that is not a UUID is absent, never coerced", () => {
    const { log, parsed } = harness();
    log.info("telemetry.selftest", {
      account_id: "someone@example.com",
      run_id: ACCOUNT,
      wf_run_id: "r1",
      request_id: PAYLOAD,
      trace_id: "0af7651916cd43dd8448eb211c80319c",
    });
    expect(parsed()[0]).toMatchObject({ run_id: ACCOUNT, trace_id: "0af7651916cd43dd8448eb211c80319c" });
    for (const key of ["account_id", "wf_run_id", "request_id"]) expect(parsed()[0]).not.toHaveProperty(key);
  });
});

describe("OPS-T1b criterion 6 (R4): the lint rule", () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL("../../..", import.meta.url)), ignore: false });
  const lint = async (name: string) =>
    (await eslint.lintFiles([fileURLToPath(new URL(`./lint-fixtures/${name}`, import.meta.url))]))[0]!.messages.filter(
      (m) => m.ruleId === "no-restricted-syntax",
    );

  it("a template with expressions, a + on a string, and JSON.stringify in a logger call are three errors", async () => {
    expect(await lint("forbidden.ts")).toHaveLength(3);
  }, 60_000);

  it("registered codes and typed fields are none", async () => {
    expect(await lint("allowed.ts")).toHaveLength(0);
  }, 60_000);
});
