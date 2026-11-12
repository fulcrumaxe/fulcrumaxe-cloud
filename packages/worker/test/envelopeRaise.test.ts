import { describe, expect, it, vi } from "vitest";

const write = vi.hoisted(() => vi.fn());
vi.mock("@fx/spend", async (orig) => ({
  ...(await orig<typeof import("@fx/spend")>()),
  itemEnvelopeId: async () => "env-1",
  currentEnvelope: async () => ({ amountUsd: 0.5, version: 1 }),
  writeEnvelopeVersion: write,
  auditEnvelopeChanged: async () => undefined,
}));
import { EnvelopeWriteError } from "@fx/spend";
import { raiseItemEnvelope } from "../src/envelopeRaise.js";

const client = {
  query: async (sql: string) => (sql.includes("envelope_pause_asks") ? { rows: [{ envelope_version: 1 }] } : { rows: [{ scope: "item", repo_id: null }] }),
} as never;
const facts = { accountId: "a", workItemId: "w", askId: "k", limitUsd: 0.7 };

describe("the envelope raiser maps the writer's refusals", () => {
  it("a lost race for the next version is `conflict`, the account cap is `over_account_budget`, anything else is thrown", async () => {
    write.mockRejectedValueOnce(new EnvelopeWriteError("version_conflict"));
    expect(await raiseItemEnvelope(client, facts)).toBe("conflict");
    write.mockRejectedValueOnce(new EnvelopeWriteError("over_account_budget"));
    expect(await raiseItemEnvelope(client, facts)).toBe("over_account_budget");
    write.mockRejectedValueOnce(new Error("boom"));
    await expect(raiseItemEnvelope(client, facts)).rejects.toThrow("boom");
    write.mockResolvedValueOnce({ envelopeId: "env-1", version: 2 });
    expect(await raiseItemEnvelope(client, facts)).toBe("raised");
  });
});
