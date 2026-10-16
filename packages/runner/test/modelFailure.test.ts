import { describe, expect, it } from "vitest";
import { detectModelFailure } from "../src/modelFailure.js";
import type { NormalizedEvent } from "../src/types.js";
import { CREDITS_EXHAUSTED_ANSWERS, NOT_CREDITS_ANSWERS, eventTextFor } from "../../model-connection/test/helpers/creditsAnswers.js";

function errorEvent(text: string): NormalizedEvent {
  return { runId: "r", role: "executor", seq: 1, type: "error", ts: "now", isError: true, text };
}

describe("detectModelFailure (D#2 H09b2, H09.5)", () => {
  it("returns undefined for a non-error event", () => {
    expect(detectModelFailure({ runId: "r", role: "executor", seq: 1, type: "assistant", ts: "now", text: "401" })).toBeUndefined();
  });

  it("returns undefined for an error event with no recognizable code", () => {
    expect(detectModelFailure(errorEvent("connection reset"))).toBeUndefined();
  });

  it("detects 401", () => {
    expect(detectModelFailure(errorEvent("model returned 401 unauthorized"))).toBe(401);
  });

  it("detects 403", () => {
    expect(detectModelFailure(errorEvent("403 forbidden"))).toBe(403);
  });

  it("detects a 402 as out-of-credit, by the HTTP answer or the wording", () => {
    expect(detectModelFailure(errorEvent("API Error: 402 payment required"))).toBe("credits_exhausted");
    expect(detectModelFailure(errorEvent("API Error: 402 {}"))).toBe("credits_exhausted");
    expect(detectModelFailure(errorEvent("gateway returned 402"))).toBe("credits_exhausted");
  });

  it("detects quota_for_entity_exceeded as out-of-credit on a 402", () => {
    expect(detectModelFailure(errorEvent("API Error: 402 QUOTA_FOR_ENTITY_EXCEEDED"))).toBe("credits_exhausted");
  });

  it("a provider's exact structured error body with no status in front is out-of-credit (Anthropic and OpenAI shapes)", () => {
    for (const a of CREDITS_EXHAUSTED_ANSWERS.filter((x) => x.provider !== "ai_gateway")) expect(detectModelFailure(errorEvent(JSON.stringify(a.body)))).toBe("credits_exhausted");
  });

  // A false pause is worse than a missed one: a quote of a phrase on the wrong status, or with no status, is never credits.
  const PHRASES = ["payment required", "quota_for_entity_exceeded", "insufficient_quota", "Your credit balance is too low to access the Anthropic API"];
  it.each(PHRASES)("a 5xx that quotes %s is not credits", (phrase) => {
    expect(detectModelFailure(errorEvent(`API Error: 500 upstream returned: ${phrase}`))).not.toBe("credits_exhausted");
    expect(detectModelFailure(errorEvent(`HTTP 503 ${phrase}`))).not.toBe("credits_exhausted");
  });
  it.each(PHRASES)("a status-less quote of %s is not credits", (phrase) => {
    expect(detectModelFailure(errorEvent(phrase))).toBeUndefined();
    expect(detectModelFailure(errorEvent(`the tool said: ${phrase}`))).toBeUndefined();
    expect(detectModelFailure(errorEvent(JSON.stringify({ error: { message: phrase } })))).toBeUndefined();
  });
  it("the wording on the wrong status is not credits (429 with the Anthropic wording, 400 with insufficient_quota)", () => {
    expect(detectModelFailure(errorEvent("API Error: 429 credit balance is too low"))).not.toBe("credits_exhausted");
    expect(detectModelFailure(errorEvent("API Error: 400 insufficient_quota"))).not.toBe("credits_exhausted");
  });

  it("a bare 402 in an error log (a line number, a count) is not an empty balance", () => {
    expect(detectModelFailure(errorEvent("test failed at src/parse.ts:402 unexpected token"))).toBeUndefined();
    expect(detectModelFailure(errorEvent("402 files changed"))).toBeUndefined();
  });

  // D#483 S5-k2: one fixture per provider answer, the same ones the model-connection and model-call tests use.
  it.each(CREDITS_EXHAUSTED_ANSWERS)("S5-k2: $name is out-of-credit, never an ordinary failure and never a rejected key", (a) => {
    expect(detectModelFailure(errorEvent(eventTextFor(a)))).toBe("credits_exhausted");
  });

  it.each(NOT_CREDITS_ANSWERS)("S5-k2: $name is not read as out-of-credit", (a) => {
    expect(detectModelFailure(errorEvent(eventTextFor(a)))).not.toBe("credits_exhausted");
  });

  it("S5-k2: an out-of-credit answer whose text also carries 401 or 403 is still out-of-credit (checked first)", () => {
    expect(detectModelFailure(errorEvent("API Error: 429 after 401 and 403 retries: insufficient_quota"))).toBe("credits_exhausted");
  });

  it("never throws on a missing text field", () => {
    expect(detectModelFailure({ runId: "r", role: "executor", seq: 1, type: "error", ts: "now", isError: true })).toBeUndefined();
  });
});
