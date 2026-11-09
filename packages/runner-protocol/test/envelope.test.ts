import { describe, expect, it } from "vitest";
import { MAX_ENVELOPE_INPUT_BYTES, endsWithEnvelopeBlock, extractAgentOutputEnvelope } from "../src/envelope.js";

const block = (json: string): string => `<!-- AGENT_OUTPUT -->\n\`\`\`json\n${json}\n\`\`\`\n<!-- /AGENT_OUTPUT -->`;

describe("endsWithEnvelopeBlock", () => {
  it("is true when the closing marker is the last non-whitespace text", () => {
    expect(endsWithEnvelopeBlock(`done.\n${block('{"verdict":"pass"}')}`)).toBe(true);
    expect(endsWithEnvelopeBlock(`${block('{"verdict":"pass"}')}\n \t\n`)).toBe(true);
  });

  it("is false for prose after the block, for no block, and for an opener with no closer", () => {
    expect(endsWithEnvelopeBlock(`${block('{"verdict":"pass"}')}\nBackground command finished.`)).toBe(false);
    expect(endsWithEnvelopeBlock("no markers here")).toBe(false);
    expect(endsWithEnvelopeBlock("<!-- AGENT_OUTPUT -->\n```json\n{}")).toBe(false);
  });

  it("a quoted block, then prose, then a bare closing marker is not the end of a block", () => {
    expect(endsWithEnvelopeBlock(`${block('{"verdict":"pass"}')}\nsome prose\n<!-- /AGENT_OUTPUT -->`)).toBe(false);
    expect(endsWithEnvelopeBlock(`${block('{"verdict":"pass"}')}\nsome prose\n\`\`\`\n<!-- /AGENT_OUTPUT -->\n`)).toBe(false);
  });

  it("looks at the LAST closer: a block, prose, then a quoted closer-free tail is false", () => {
    expect(endsWithEnvelopeBlock(`${block('{"verdict":"pass"}')}\nquoted above\n${block('{"verdict":"fail"}')}\nand more`)).toBe(false);
  });
});

describe("extractAgentOutputEnvelope", () => {
  it("reads a block that the agent followed with trailing prose (a background command finishing after it)", () => {
    expect(extractAgentOutputEnvelope(`${block('{"verdict":"needs-fix"}')}\n\nBackground command finished: exit 0.`)).toEqual({ verdict: "needs-fix" });
  });

  it("reads the block the agent ended its message with", () => {
    expect(extractAgentOutputEnvelope(`done.\n${block('{"verdict":"pass","n":2}')}`)).toEqual({ verdict: "pass", n: 2 });
  });

  it("takes the last block, so a block quoted earlier in the message cannot win", () => {
    const text = `${block('{"verdict":"pass"}')}\nlater\n${block('{"verdict":"fail"}')}`;
    expect(extractAgentOutputEnvelope(text)).toEqual({ verdict: "fail" });
  });

  it("returns nothing when the last block is malformed, and does not fall back to an earlier one", () => {
    const text = `${block('{"verdict":"pass"}')}\n${block("{not json")}`;
    expect(extractAgentOutputEnvelope(text)).toBeUndefined();
  });

  it("returns nothing for a block that is not a JSON object", () => {
    for (const body of ["[1,2]", "7", '"x"', "null"]) expect(extractAgentOutputEnvelope(block(body)), body).toBeUndefined();
  });

  it("returns nothing when there is no block, or when the input is over the size cap", () => {
    expect(extractAgentOutputEnvelope("no markers here")).toBeUndefined();
    const big = `${"x".repeat(MAX_ENVELOPE_INPUT_BYTES)}${block('{"a":1}')}`;
    expect(extractAgentOutputEnvelope(big)).toBeUndefined();
  });

  it("an unterminated earlier block cannot swallow the real one after it", () => {
    const text = `<!-- AGENT_OUTPUT -->\n\`\`\`json\n{"verdict":"pass"\n\n${block('{"verdict":"fail"}')}`;
    expect(extractAgentOutputEnvelope(text)).toEqual({ verdict: "fail" });
  });
});
