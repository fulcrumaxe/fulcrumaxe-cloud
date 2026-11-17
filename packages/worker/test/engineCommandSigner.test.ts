import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENGINE_COMMAND_PURPOSE, verifyEngineCommand, type EngineCommand } from "@fulcrumaxe/runner-protocol";
import { JOB_KEY_ID_ENV, JOB_SIGNING_KEY_ENV, loadJobSigner } from "../src/jobSigner.js";

/** EB-8a: the job-signing key signs engine bridge commands too, with the same `key_id`, so a runner that trusts the key for jobs trusts it for commands. */
describe("the job signer signs engine commands", () => {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  /** Both times come from one reading of the clock, so the life is exactly `lifeMs` on any run; two separate `Date.now()` calls drift apart by a millisecond or more and push a 600 s life over the limit. */
  const command = (over: Partial<EngineCommand> = {}, lifeMs = 600_000): EngineCommand => {
    const issued = Date.now();
    return {
      v: 1,
      purpose: ENGINE_COMMAND_PURPOSE,
      command_id: "11111111-1111-4111-8111-111111111111",
      command_seq: 1,
      runner_id: "22222222-2222-4222-8222-222222222222",
      repo_gh_id: 7,
      kind: "pause_loop",
      args: {},
      issued_by: "33333333-3333-4333-8333-333333333333",
      issued_at: new Date(issued).toISOString(),
      expires_at: new Date(issued + lifeMs).toISOString(),
      halt_epoch: 0,
      ...over,
    } as EngineCommand;
  };

  it("signs under the configured key id and verifies with the public key, and not with another", () => {
    const signer = loadJobSigner({ [JOB_SIGNING_KEY_ENV]: pem, [JOB_KEY_ID_ENV]: "job-key-1" })!;
    const signed = signer.signEngineCommand(command());
    expect(signed.key_id).toBe("job-key-1");
    expect(verifyEngineCommand(signed, { "job-key-1": pair.publicKey }).command_id).toBe("11111111-1111-4111-8111-111111111111");
    const other = generateKeyPairSync("ed25519").publicKey;
    expect(() => verifyEngineCommand(signed, { "job-key-1": other })).toThrow(expect.objectContaining({ code: "bad_signature" }));
  });

  it("refuses to sign a command that breaks the protocol (a life over 600 s)", () => {
    const signer = loadJobSigner({ [JOB_SIGNING_KEY_ENV]: pem, [JOB_KEY_ID_ENV]: "job-key-1" })!;
    expect(() => signer.signEngineCommand(command({}, 700_000))).toThrow();
  });
});
