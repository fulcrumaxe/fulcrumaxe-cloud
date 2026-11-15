// apps/workspace/test/site-review-preview.test.mjs
//
// D#3 K10: the logic half of the preview panel in the Site review app. The rules under test: every refusal the server can
// answer has its own fixed sentence ("Preview already used" among them), every state and every reason code has a sentence,
// the lock lines say "Setup payment required" whatever the server sent, the person is told the exact cap before anything
// starts, and no sentence ever carries "null", "undefined" or a code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiFailure } from "../apps/_lib/api.js";
import { REASONS, REFUSALS, canAsk, renderPath, confirmSentence, lockLine, reasonSentence, refusalSentence, stateSentence } from "../apps/site-review/site-review-plan.js";

const BAD = /\b(null|undefined|NaN|\[object)/;
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../apps/site-review/site-review-plan.js"), "utf8");
const routeSrc = readFileSync(join(here, "../../../packages/api/src/routes/sitePreview.ts"), "utf8");
const pipelineErrors = readFileSync(join(here, "../../../packages/sitekit-pipeline/src/preview/errors.ts"), "utf8");
const extractErrors = readFileSync(join(here, "../../../packages/sitekit-pipeline/src/extract/errors.ts"), "utf8");

describe("every refusal is named", () => {
  it("each error code the route can answer has a sentence of its own, and the second preview reads 'Preview already used'", () => {
    const codes = [...routeSrc.matchAll(/new ApiError\(\d+, "([a-z_]+)"/g)].map((m) => m[1]).filter((c) => c !== "validation_failed");
    for (const code of new Set(codes)) expect(Object.hasOwn(REFUSALS, code), code).toBe(true);
    expect(refusalSentence(new ApiFailure(409, "preview_used", "x"))).toBe("Preview already used");
    expect(REFUSALS.preview_used).toBe("Preview already used");
  });
  it("each refusal is a different sentence, with no code and no null or undefined in it", () => {
    const seen = new Set();
    for (const [code, text] of Object.entries(REFUSALS)) {
      expect(text, code).not.toMatch(BAD);
      expect(text).not.toContain(code);
      expect(text.length).toBeGreaterThan(10);
      seen.add(text);
    }
    expect(seen.size).toBe(Object.keys(REFUSALS).length - 1); // insufficient_role and session_required share one sentence
  });
  it("an unknown code, a 5xx, a prototype name and a missing error each get the generic sentence, never text from the server", () => {
    const generic = "That didn't go through. Try again.";
    for (const e of [new ApiFailure(409, "something_new", "SECRET detail"), new ApiFailure(500, "internal_error", "boom"), new ApiFailure(409, "constructor", "x"), new ApiFailure(422, "validation_failed", "bad"), null, undefined, {}]) {
      const s = refusalSentence(e);
      expect(s).toBe(generic);
      expect(s).not.toMatch(BAD);
    }
  });
  it("a 404 and a 403 are named, and a 429 says how long to wait", () => {
    expect(refusalSentence(new ApiFailure(404, "not_found", "x"))).toBe(REFUSALS.not_found);
    expect(refusalSentence(new ApiFailure(403, "insufficient_role", "x"))).toBe(REFUSALS.insufficient_role);
    expect(refusalSentence(new ApiFailure(403, "something_else", "x"))).toBe(REFUSALS.insufficient_role);
    expect(refusalSentence(new ApiFailure(429, "rate_limited", "x", undefined, 7))).toMatch(/^Too many tries\. /);
  });
});

describe("states and reasons", () => {
  it("every reason code the pipeline can store has a sentence (a cap that was not confirmed is refused before a row is touched, so it is a refusal, not a reason)", () => {
    const codes = [...extractErrors.matchAll(/\| "([a-z_]+)"/g), ...pipelineErrors.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const wanted = codes.filter((c) => !["site", "input", "preview", "cap_not_confirmed"].includes(c));
    for (const code of new Set(wanted)) expect(Object.hasOwn(REASONS, code), code).toBe(true);
    for (const text of Object.values(REASONS)) expect(text).not.toMatch(BAD);
  });
  it("an unknown or missing reason reads as a plain sentence", () => {
    for (const r of ["nope", null, undefined, "", 7, "constructor"]) expect(reasonSentence(r)).toBe("it stopped early");
  });
  it("each state has a sentence; a finished one is the verification line, and none prints null or undefined", () => {
    const line = "12 claims, 3 unverifiable, 1 blockers";
    expect(stateSentence(null)).toMatch(/^No preview yet/);
    expect(stateSentence({ state: "requested" })).toMatch(/Waiting/);
    expect(stateSentence({ state: "running" })).toMatch(/running/);
    expect(stateSentence({ state: "finished", summary: { line } })).toBe(line);
    expect(stateSentence({ state: "finished", summary: null })).toBe("Preview finished.");
    expect(stateSentence({ state: "failed", reason: "agent_failed" })).toBe("The preview stopped because the read stopped before it finished. The one-time preview is used.");
    expect(stateSentence({ state: "void", reason: "clone_failed" })).toMatch(/Nothing was spent, and you can ask again\.$/);
    expect(stateSentence({ state: "weird" })).toBe("The preview's state isn't known.");
    for (const p of [null, {}, { state: "failed" }, { state: "void", reason: null }, { state: "finished" }, { state: undefined }]) expect(stateSentence(p)).not.toMatch(BAD);
  });
  it("the button is offered with no preview or a void one, never while one is running, finished or failed", () => {
    expect(canAsk({ preview: null })).toBe(true);
    expect(canAsk({ preview: { state: "void" } })).toBe(true);
    for (const state of ["requested", "running", "finished", "failed"]) expect(canAsk({ preview: { state } })).toBe(false);
  });
});

describe("what stays locked", () => {
  it("a locked or unknown feature says 'Setup payment required'; only an explicit open lock reads open", () => {
    expect(lockLine("Publish", { locked: true, label: "anything the server says" })).toBe("Publish: Setup payment required");
    for (const lock of [undefined, null, {}, { locked: "no" }]) expect(lockLine("Downloads", lock)).toBe("Downloads: Setup payment required");
    expect(lockLine("Full site", { locked: false, label: null })).toBe("Full site: open");
  });
});

describe("the confirmation names the exact cap", () => {
  it("reads the cap the server sent, and never a placeholder", () => {
    const cap = Number("2" + "0");
    expect(confirmSentence(cap)).toContain("$" + cap);
    expect(confirmSentence(20)).toMatch(/your own model key/);
    for (const cap of [undefined, null, NaN, 0, -1, "20"]) {
      const s = confirmSentence(cap);
      expect(s).not.toMatch(BAD);
      expect(s).toContain("the spending cap");
    }
  });
  it("the request sends the cap the person was shown, and the render only ever goes into a sandboxed frame", () => {
    expect(src).toMatch(/confirm_model_cap_usd: cap/);
    expect(src).toMatch(/sandbox: ""/);
    expect(src).not.toMatch(/srcdoc/);
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("the frame's address", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  it("is the site's own render route and nothing else", () => {
    const own = "/api/v1/sites/" + id + "/preview/render";
    expect(renderPath(id, own)).toBe(own);
    for (const url of [null, undefined, "", "https://evil.example/x", "//evil.example/x", "javascript:alert(1)", "/api/v1/sites/" + id + "/preview", "/api/v1/sites/other/preview/render", 5]) expect(renderPath(id, url)).toBe("");
    expect(renderPath("not-an-id", "/api/v1/sites/not-an-id/preview/render")).toBe("");
  });
});
