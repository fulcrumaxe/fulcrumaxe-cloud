import { describe, expect, it } from "vitest";
import { CREDENTIAL_MODES, RUNNER_MESSAGES, RegisterResponse } from "../src/messages.js";
import { g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

const RUNNER = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const ACCOUNT = "6b1e2f30-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const JWK = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };

describe("RegisterResponse (the cloud's 201 to a registration)", () => {
  const good = { runner_id: RUNNER, account_id: ACCOUNT, credential_mode: "subscription" };

  it("carries exactly the runner id, the account id and the credential mode", () => {
    expect(RegisterResponse.safeParse(good).success).toBe(true);
    expect(Object.keys(RegisterResponse.shape).sort()).toEqual(["account_id", "credential_mode", "runner_id"]);
    for (const mode of CREDENTIAL_MODES) expect(RegisterResponse.safeParse({ ...good, credential_mode: mode }).success, mode).toBe(true);
  });

  it("refuses a reply missing a field, with a wrong type or value, or with anything extra", () => {
    for (const key of Object.keys(good)) {
      const rest: Record<string, string> = { ...good };
      delete rest[key];
      expect(RegisterResponse.safeParse(rest).success, `missing ${key}`).toBe(false);
    }
    for (const bad of [{ runner_id: "nope" }, { account_id: 7 }, { credential_mode: "both" }, { credential_mode: "" }, { extra: 1 }, { public_key_jwk: JWK }]) {
      expect(RegisterResponse.safeParse({ ...good, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is a strict object whose only credential-looking name is the allowlisted credential_mode, and is not a runner-to-cloud message", () => {
    expect(nonStrictObjects(RegisterResponse)).toEqual([]);
    expect(g1Violations(RegisterResponse)).toEqual([]);
    expect(Object.values(RUNNER_MESSAGES)).not.toContain(RegisterResponse);
  });
});
