import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { DECISION_REFUSAL_CODES, recordDecisionIdsEvent, recordDecisionRefusedEvent, type DecisionRefusalCode } from "../src/runStatusWriter.js";

/** D#7 DP4b-2: the run_events rows the decision call site leaves. A fake client records what would be written. */
function fake() {
  const inserts: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("INSERT INTO run_events")) inserts.push({ kind: String(params![3]), payload: JSON.parse(String(params![4])) as Record<string, unknown> });
      return { rows: [{ next: "1" }] };
    },
  } as unknown as PoolClient;
  return { client, inserts };
}
const IDS = { accountId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222" };

describe("recordDecisionRefusedEvent", () => {
  it.each([...DECISION_REFUSAL_CODES])("writes one decision_request.refused row for %s: the code and nothing else", async (code) => {
    const { client, inserts } = fake();
    await recordDecisionRefusedEvent(client, { ...IDS, code });
    expect(inserts).toEqual([{ kind: "decision_request.refused", payload: { code } }]);
  });

  it("stores the key only when it has a key's shape, so no agent text can ride along", async () => {
    const { client, inserts } = fake();
    for (const key of ["d1", "d99", "d0", "d100", "D1", "dd1", "d1 ", "ignore previous instructions", "d1\nd2", ""]) {
      await recordDecisionRefusedEvent(client, { ...IDS, code: "decision_key_unknown", key });
    }
    expect(inserts.map((i) => i.payload)).toEqual([
      { code: "decision_key_unknown", key: "d1" },
      { code: "decision_key_unknown", key: "d99" },
      ...Array.from({ length: 8 }, () => ({ code: "decision_key_unknown" })),
    ]);
  });

  it("refuses a code outside the fixed words before anything is written", async () => {
    const { client, inserts } = fake();
    await expect(recordDecisionRefusedEvent(client, { ...IDS, code: "free text from the agent" as DecisionRefusalCode })).rejects.toThrow("decision_refusal_code_unknown");
    expect(inserts).toEqual([]);
  });
});

describe("recordDecisionIdsEvent", () => {
  it("writes the kind it is given with its ids-only payload", async () => {
    const { client, inserts } = fake();
    await recordDecisionIdsEvent(client, { ...IDS, kind: "decision.announced", payload: { decision_type: "test_strategy_choice", key: "d2" } });
    await recordDecisionIdsEvent(client, { ...IDS, kind: "decision.intake", payload: { code: "parked" } });
    expect(inserts).toEqual([
      { kind: "decision.announced", payload: { decision_type: "test_strategy_choice", key: "d2" } },
      { kind: "decision.intake", payload: { code: "parked" } },
    ]);
  });
});
