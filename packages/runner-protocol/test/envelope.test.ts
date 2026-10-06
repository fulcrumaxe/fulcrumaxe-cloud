import { describe, expect, it } from "vitest";
import { MAX_ENVELOPE_INPUT_BYTES, extractAgentOutputEnvelope } from "../src/envelope.js";

const block = (json: string): string => `<!-- AGENT_OUTPUT -->\n\`\`\`json\n${json}\n\`\`\`\n<!-- /AGENT_OUTPUT -->`;

describe("extractAgentOutputEnvelope", () => {
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
