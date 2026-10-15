import { describe, expect, it } from "vitest";
import { assignPartnerOnSignup } from "../src/signup/index.js";

const ACCOUNT = "33333333-3333-4333-8333-333333333333";

function fakeClient() {
  const queries: { text: string; values?: unknown[] }[] = [];
  return {
    queries,
    async query(text: string, values?: unknown[]) {
      queries.push({ text, ...(values ? { values } : {}) });
      return { rows: [] };
    },
  };
}

describe("assignPartnerOnSignup", () => {
  it("is a no-op without a signupHost, with the layer on", async () => {
    const client = fakeClient();
    await assignPartnerOnSignup({ accountId: ACCOUNT, client }, { FX_PARTNER_LAYER: "on" });
    expect(client.queries).toEqual([]);
  });

  it("is a no-op with a signupHost while the layer is unset, off or anything but on", async () => {
    for (const value of [undefined, "off", "ON", ""]) {
      const client = fakeClient();
      await assignPartnerOnSignup({ accountId: ACCOUNT, signupHost: "a.example.com", client }, { FX_PARTNER_LAYER: value });
      expect(client.queries, String(value)).toEqual([]);
    }
  });

  it("calls assign_partner_on_signup once with the account and the normalised host, on the signup transaction's client", async () => {
    const client = fakeClient();
    await assignPartnerOnSignup({ accountId: ACCOUNT, signupHost: "Build.Acme.example.:443", client }, { FX_PARTNER_LAYER: "on" });
    expect(client.queries).toEqual([{ text: "SELECT assign_partner_on_signup($1, $2)", values: [ACCOUNT, "build.acme.example"] }]);
  });

  it("refuses a signupHost that is not a hostname, instead of creating a direct account on a partner host", async () => {
    const client = fakeClient();
    await expect(
      assignPartnerOnSignup({ accountId: ACCOUNT, signupHost: "ours@evil.example", client }, { FX_PARTNER_LAYER: "on" }),
    ).rejects.toThrow(/not a hostname/);
    expect(client.queries).toEqual([]);
  });

  it("does not swallow a refusal from the database function", async () => {
    const client = {
      async query(): Promise<never> {
        throw Object.assign(new Error("assign_partner_on_signup: the host is not an active partner host"), { code: "42501" });
      },
    };
    await expect(
      assignPartnerOnSignup({ accountId: ACCOUNT, signupHost: "a.example.com", client }, { FX_PARTNER_LAYER: "on" }),
    ).rejects.toMatchObject({ code: "42501" });
  });

});
