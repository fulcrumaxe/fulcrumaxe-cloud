import { describe, expect, it } from "vitest";
import { DISCOVERY_ANALYST_ROLE, PROPOSAL_VERIFIER_ROLE, structuredSchemaFor } from "@fulcrumaxe/runner-protocol";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { engineFor, fixtureText, makeRig } from "./rig.js";

/**
 * D#6 RUNNER-STRUCTURED-OUTPUT, through the real engine over a fake binary that prints the stream the installed CLI prints: an init line and a result line
 * (the stream fixtures' own shapes). With `--json-schema` the CLI puts its answer in the result line's `structured_output` field. The shape is taken from the
 * CLI's documented result message; no capture of it is committed yet, so this is the one place that states it (see the PR note about a real-binary canary).
 */
const init = (): string => fixtureText("stream.tooluse.synthetic.jsonl").split("\n").find((line) => line.includes('"subtype":"init"'))!;
const ANSWER = { category: "bug", claims: [{ text: "a claim", verdict: "supported", cites: [{ path: "src/a.ts", start_line: 1, end_line: 3 }] }] };
const resultLine = (extra: Record<string, unknown>): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "sess-0001", total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 }, ...extra });
const TEXT_ENVELOPE = (value: unknown): string => `Done.\n<!-- AGENT_OUTPUT -->\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n<!-- /AGENT_OUTPUT -->`;

async function run(role: string, stream: string[]) {
  const rig = makeRig();
  rig.fake.set("stream.jsonl", [init(), ...stream].join("\n") + "\n");
  const { handle } = await engineFor(rig).start(rig.startOptions({ role }));
  const outcome = await outcomeOf(handle);
  return { outcome, argv: rig.fake.argv() };
}

describe("structured output through the engine", () => {
  it.each([PROPOSAL_VERIFIER_ROLE, DISCOVERY_ANALYST_ROLE])("%s: the command line carries the role's schema and the answer is read from structured_output", async (role) => {
    const { outcome, argv } = await run(role, [resultLine({ result: "", structured_output: ANSWER })]);
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!)).toEqual(structuredSchemaFor(role));
    expect(outcome.status).toBe("ok");
    expect(outcome.agentOutput).toEqual(ANSWER);
  });

  it("the structured answer wins over a text envelope in the same result", async () => {
    const { outcome } = await run(PROPOSAL_VERIFIER_ROLE, [resultLine({ result: TEXT_ENVELOPE({ category: "doc", claims: [] }), structured_output: ANSWER })]);
    expect(outcome.agentOutput).toEqual(ANSWER);
  });

  it("fallback: a result with no structured_output is still read from the text envelope", async () => {
    const { outcome } = await run(PROPOSAL_VERIFIER_ROLE, [resultLine({ result: TEXT_ENVELOPE({ category: "doc", claims: [] }) })]);
    expect(outcome.agentOutput).toEqual({ category: "doc", claims: [] });
  });

  it.each([null, "text", ["a"], 7])("fallback: a structured_output that is not an object (%j) is ignored and the text envelope decides", async (bad) => {
    const { outcome } = await run(PROPOSAL_VERIFIER_ROLE, [resultLine({ result: TEXT_ENVELOPE({ category: "doc", claims: [] }), structured_output: bad })]);
    expect(outcome.agentOutput).toEqual({ category: "doc", claims: [] });
  });

  it("a role with no fixed shape gets no flag and keeps the text path", async () => {
    const { outcome, argv } = await run("executor", [resultLine({ result: TEXT_ENVELOPE({ verdict: "done" }) })]);
    expect(argv).not.toContain("--json-schema");
    expect(outcome.agentOutput).toEqual({ verdict: "done" });
  });

  it("an oversized structured_output is not taken (same cap as the text envelope)", async () => {
    const huge = { category: "bug", claims: [], pad: "x".repeat(300 * 1024) };
    const { outcome } = await run(PROPOSAL_VERIFIER_ROLE, [resultLine({ result: "", structured_output: huge })]);
    expect(outcome.agentOutput).toBeUndefined();
  });
});
