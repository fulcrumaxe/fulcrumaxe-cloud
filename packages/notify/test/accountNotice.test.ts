import { describe, expect, it } from "vitest";
import { postAccountNotice } from "../src/index.js";

type Call = { sql: string; params: unknown[] };
const clientAnswering = (n: unknown) => {
  const calls: Call[] = [];
  const client = { query: async (sql: string, params: unknown[]) => (calls.push({ sql, params }), { rows: n === undefined ? [] : [{ n }] }) };
  return { calls, client: client as never };
};

describe("postAccountNotice", () => {
  it("calls the one definer with a kind and an id and answers how many people it reached", async () => {
    const { calls, client } = clientAnswering(3);
    expect(await postAccountNotice(client, "machine.linked", "11111111-1111-4111-8111-111111111111")).toBe(3);
    expect(calls).toEqual([{ sql: expect.stringContaining("account_notice_post($1::text, $2::uuid)"), params: ["machine.linked", "11111111-1111-4111-8111-111111111111"] }]);
  });
  it("sends no id when none is given, and reads no row as nobody reached", async () => {
    const { calls, client } = clientAnswering(undefined);
    expect(await postAccountNotice(client, "engine.fewer_than_running")).toBe(0);
    expect(calls[0]!.params).toEqual(["engine.fewer_than_running", null]);
  });
});
