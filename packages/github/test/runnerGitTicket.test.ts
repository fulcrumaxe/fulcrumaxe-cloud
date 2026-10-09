import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  GIT_TICKET_LIFETIME_SECONDS,
  GIT_TICKET_REF_PATTERN,
  GIT_TICKET_TYP,
  RunnerGitTicketError,
  createRunnerGitTicketKeys,
  parseRunnerGitTicketClaims,
  signRunnerGitTicket,
  verifyRunnerGitTicket,
  type RunnerGitTicketInput,
} from "../src/runnerGitTicket.js";

/**
 * D#6 R5a-2b (C27 section 1, criterion 3): the ticket's signer and verifier. Every case signs with a throwaway Ed25519 key and verifies against a
 * local JWKS built from its public half; no network and no database is involved, which is the point of the ticket.
 */

const ISSUER = "https://cloud.example.test";
const AUDIENCE = "https://proxy.example.test/api/gh-proxy";
const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const RUNNER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ACCOUNT = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const REPO = { id: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f", owner: "acme", name: "widgets" };
const NOW = new Date("2026-10-10T12:00:00.000Z");
const IAT = Math.floor(NOW.getTime() / 1000);

const pair = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const jwk = (key: KeyObject, kid: string) => ({ ...(key.export({ format: "jwk" }) as { kty: string; crv: string; x: string }), kid });
const keys = createRunnerGitTicketKeys({ keys: [jwk(pair.publicKey, "k1")] })!;
const signer = { keyId: "k1", privateKey: pair.privateKey };
const deps = (over: { now?: Date } = {}) => ({ keys, issuer: ISSUER, audience: AUDIENCE, now: () => over.now ?? NOW });

const input = (over: Partial<RunnerGitTicketInput> = {}): RunnerGitTicketInput => ({
  issuer: ISSUER,
  audience: AUDIENCE,
  runnerId: RUNNER,
  accountId: ACCOUNT,
  runId: RUN,
  leaseGeneration: 3,
  repo: REPO,
  ref: `fx/${RUN}-g3`,
  ...over,
});

/** The claims a correct ticket carries, as written on the wire. */
const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: RUNNER,
  acct: ACCOUNT,
  run: RUN,
  gen: 3,
  repo: REPO,
  ref: `fx/${RUN}-g3`,
  jti: "4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f80",
  iat: IAT,
  nbf: IAT,
  exp: IAT + GIT_TICKET_LIFETIME_SECONDS,
  ...over,
});

/** A token signed by hand, so a case can break exactly one thing the signer would never break. */
async function forge(payload: Record<string, unknown>, header: Record<string, unknown> = {}, key: KeyObject = pair.privateKey): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: "EdDSA", typ: GIT_TICKET_TYP, kid: "k1", ...header }).sign(key);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const refusal = async (token: string, over: { now?: Date } = {}) => {
  try {
    await verifyRunnerGitTicket(token, deps(over));
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerGitTicketError);
    return (error as RunnerGitTicketError).code;
  }
  return "accepted";
};

describe("a minted ticket", () => {
  it("verifies, and carries exactly the twelve claims of the ruling", async () => {
    const { ticket, expiresAt } = await signRunnerGitTicket(input(), signer, NOW);
    const claims = await verifyRunnerGitTicket(ticket, deps());
    expect(claims).toMatchObject({ issuer: ISSUER, audience: AUDIENCE, runnerId: RUNNER, accountId: ACCOUNT, runId: RUN, leaseGeneration: 3, repo: REPO, ref: `fx/${RUN}-g3`, issuedAt: IAT, expiresAt: IAT + 300 });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(expiresAt.getTime()).toBe((IAT + 300) * 1000);
    const [header, body] = ticket.split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part!, "base64url").toString("utf8")) as Record<string, unknown>);
    expect(header).toEqual({ alg: "EdDSA", typ: "fx-git-ticket+jwt", kid: "k1" });
    expect(Object.keys(body!).sort()).toEqual(["acct", "aud", "exp", "gen", "iat", "iss", "jti", "nbf", "ref", "repo", "run", "sub"]);
    expect(body!["nbf"]).toBe(body!["iat"]);
    expect((body!["exp"] as number) - (body!["iat"] as number)).toBe(300);
    expect(Object.keys(body!["repo"] as object).sort()).toEqual(["id", "name", "owner"]);
  });

  it("gets a fresh jti every time", async () => {
    const a = await verifyRunnerGitTicket((await signRunnerGitTicket(input(), signer, NOW)).ticket, deps());
    const b = await verifyRunnerGitTicket((await signRunnerGitTicket(input(), signer, NOW)).ticket, deps());
    expect(a.jti).not.toBe(b.jti);
  });

  it("is accepted for a fix round's branch, which is an earlier run's", async () => {
    const earlier = "5e6f7a8b-9c0d-4e1f-8a3b-4c5d6e7f8091";
    const { ticket } = await signRunnerGitTicket(input({ ref: `fx/${earlier}-g2` }), signer, NOW);
    expect((await verifyRunnerGitTicket(ticket, deps())).ref).toBe(`fx/${earlier}-g2`);
  });

  it("is still good 59 seconds after it expires, and not 61 (the skew bound)", async () => {
    const { ticket } = await signRunnerGitTicket(input(), signer, NOW);
    expect(await refusal(ticket, { now: new Date((IAT + 300 + 59) * 1000) })).toBe("accepted");
    expect(await refusal(ticket, { now: new Date((IAT + 300 + 61) * 1000) })).toBe("expired");
  });

  it("is refused a minute before it is valid, and accepted within the skew", async () => {
    const { ticket } = await signRunnerGitTicket(input(), signer, new Date((IAT + 1000) * 1000));
    expect(await refusal(ticket)).toBe("expired");
    const { ticket: near } = await signRunnerGitTicket(input(), signer, new Date((IAT + 50) * 1000));
    expect(await refusal(near)).toBe("accepted");
  });

  it("is never signed for input the verifier would refuse", async () => {
    for (const bad of [
      input({ ref: "main" }),
      input({ ref: `fx/${RUN}-g0` }),
      input({ ref: `refs/heads/fx/${RUN}-g3` }),
      input({ ref: `fx/${RUN}-g3/../x` }),
      input({ leaseGeneration: 0 }),
      input({ leaseGeneration: 1.5 }),
      input({ runId: "not-a-uuid" }),
      input({ repo: { ...REPO, owner: "a/b" } }),
      input({ repo: { ...REPO, name: "x y" } }),
    ]) {
      await expect(signRunnerGitTicket(bad, signer, NOW)).rejects.toMatchObject({ code: "claims" });
    }
    await expect(signRunnerGitTicket(input(), { ...signer, keyId: "bad kid" }, NOW)).rejects.toMatchObject({ code: "header" });
  });
});

describe("the verifier refuses", () => {
  it("a token that is not a compact JWS", async () => {
    for (const bad of ["", "abc", "a.b", "a.b.c", `${b64({ alg: "EdDSA" })}.${b64({})}`, "x".repeat(3000)]) expect(["malformed", "header"]).toContain(await refusal(bad));
  });

  it("another typ (an ordinary JWT, a sandbox token)", async () => {
    expect(await refusal(await forge(wire(), { typ: "JWT" }))).toBe("header");
    expect(await refusal(await forge(wire(), { typ: undefined }))).toBe("header");
    expect(await refusal(await forge(wire(), { typ: "fx-git-ticket+JWT" }))).toBe("header");
  });

  it("alg none, and HS256 made with the public key as the secret", async () => {
    const none = `${b64({ alg: "none", typ: GIT_TICKET_TYP, kid: "k1" })}.${b64(wire())}.`;
    expect(await refusal(none)).toBe("header");
    const hs = await new SignJWT(wire()).setProtectedHeader({ alg: "HS256", typ: GIT_TICKET_TYP, kid: "k1" }).sign(new TextEncoder().encode(jwk(pair.publicKey, "k1").x));
    expect(await refusal(hs)).toBe("header");
  });

  it("a signature made by another key, or a payload changed after signing", async () => {
    expect(await refusal(await forge(wire(), {}, other.privateKey))).toBe("signature");
    const good = await forge(wire());
    const [h, , s] = good.split(".");
    expect(await refusal(`${h}.${b64(wire({ run: "6f7a8b9c-0d1e-4f2a-9b4c-5d6e7f809102" }))}.${s}`)).toBe("signature");
  });

  it("an unknown kid, and a token with no kid", async () => {
    expect(await refusal(await forge(wire(), { kid: "k2" }))).toBe("signature");
    expect(await refusal(await forge(wire(), { kid: undefined }))).toBe("header");
  });

  it("the wrong issuer, the wrong audience, and an audience array that contains the right one", async () => {
    expect(await refusal(await forge(wire({ iss: "https://other.example.test" })))).toBe("issuer");
    expect(await refusal(await forge(wire({ aud: "https://other.example.test/api/gh-proxy" })))).toBe("audience");
    expect(await refusal(await forge(wire({ aud: [AUDIENCE] })))).toBe("audience");
    expect(await refusal(await forge(wire({ aud: [AUDIENCE, "https://x.example.test"] })))).toBe("audience");
  });

  it("a token older than 360 seconds, even one whose own exp is far away", async () => {
    // exp an hour out: only the age check stops it, and it does so as "expired", not as a claims problem.
    const long = await forge(wire({ exp: IAT + 3600 }));
    expect(await refusal(long, { now: new Date((IAT + 500) * 1000) })).toBe("expired");
    // The same token read right away is refused by the claims schema (its span is not 300).
    expect(await refusal(long)).toBe("claims");
  });

  it("an unknown claim, a missing claim, and a claim of the wrong shape", async () => {
    expect(await refusal(await forge({ ...wire(), extra: 1 }))).toBe("claims");
    expect(await refusal(await forge(wire({ scope: "write" })))).toBe("claims");
    for (const key of ["sub", "acct", "run", "gen", "repo", "ref", "jti", "iat", "nbf", "exp"]) {
      const { [key]: _gone, ...rest } = wire();
      expect(await refusal(await forge(rest)), key).not.toBe("accepted");
    }
    expect(await refusal(await forge(wire({ gen: 0 })))).toBe("claims");
    expect(await refusal(await forge(wire({ gen: "3" })))).toBe("claims");
    expect(await refusal(await forge(wire({ run: "not-a-uuid" })))).toBe("claims");
    expect(await refusal(await forge(wire({ repo: { ...REPO, extra: 1 } })))).toBe("claims");
    expect(await refusal(await forge(wire({ repo: { id: REPO.id, owner: REPO.owner } })))).toBe("claims");
    expect(await refusal(await forge(wire({ nbf: IAT - 1 })))).toBe("claims");
    expect(await refusal(await forge(wire({ exp: IAT + 299 })))).toBe("claims");
  });

  it("a ref outside the run-branch pattern", async () => {
    for (const ref of ["main", "refs/heads/main", `fx/${RUN}`, `fx/${RUN}-g0`, `fx/${RUN}-g03`, `fx/${RUN}-g3 `, `fx/${RUN}-g3\n`, `x/fx/${RUN}-g3`, `fx/${RUN.toUpperCase()}-g3`, "", `fx/${RUN}-g3/extra`, `refs/tags/fx/${RUN}-g3`]) {
      expect(await refusal(await forge(wire({ ref }))), JSON.stringify(ref)).toBe("claims");
    }
    expect(GIT_TICKET_REF_PATTERN.test(`fx/${RUN}-g12`)).toBe(true);
  });
});

describe("the ticket key set", () => {
  const good = (kid: string) => jwk(generateKeyPairSync("ed25519").publicKey, kid);

  it("takes one or two Ed25519 public keys with distinct kids, and no more", () => {
    expect(createRunnerGitTicketKeys({ keys: [good("a")] })).not.toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [good("a"), good("b")] })).not.toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [good("a"), good("b"), good("c")] })).toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [] })).toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [good("a"), good("a")] })).toBeNull();
  });

  it("refuses a key with a private member, no kid, another curve or type, or an unexpected member", () => {
    const k = good("a");
    expect(createRunnerGitTicketKeys({ keys: [{ ...k, d: "AAAA" }] })).toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [{ ...k, kid: undefined }] })).toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [{ ...k, crv: "Ed448" }] })).toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [{ ...k, kty: "RSA" }] })).toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [{ ...k, alg: "RS256" }] })).toBeNull();
    expect(createRunnerGitTicketKeys({ keys: [{ ...k, extra: 1 }] })).toBeNull();
    for (const bad of [null, undefined, "x", 5, [], {}, { keys: "x" }]) expect(createRunnerGitTicketKeys(bad)).toBeNull();
  });

  it("verifies against whichever listed key the kid names (rotation)", async () => {
    const next = generateKeyPairSync("ed25519");
    const both = createRunnerGitTicketKeys({ keys: [jwk(pair.publicKey, "k1"), jwk(next.publicKey, "k2")] })!;
    const a = (await signRunnerGitTicket(input(), signer, NOW)).ticket;
    const b = (await signRunnerGitTicket(input(), { keyId: "k2", privateKey: next.privateKey }, NOW)).ticket;
    for (const ticket of [a, b]) await expect(verifyRunnerGitTicket(ticket, { keys: both, issuer: ISSUER, audience: AUDIENCE, now: () => NOW })).resolves.toBeDefined();
    // A ticket signed by k1's private key but labelled k2 is a signature failure, not a pass.
    const swapped = await forge(wire(), { kid: "k2" });
    await expect(verifyRunnerGitTicket(swapped, { keys: both, issuer: ISSUER, audience: AUDIENCE, now: () => NOW })).rejects.toMatchObject({ code: "signature" });
  });
});

describe("the claims schema", () => {
  it("is exported on its own and returns null, never throws", () => {
    expect(parseRunnerGitTicketClaims(wire())).not.toBeNull();
    for (const bad of [null, undefined, 5, "x", [], {}]) expect(parseRunnerGitTicketClaims(bad)).toBeNull();
  });

  it("an error never carries the token or a claim", async () => {
    const token = await forge(wire({ run: "not-a-uuid" }));
    const error = (await verifyRunnerGitTicket(token, deps()).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("runnerGitTicket: refused (claims)");
    expect(JSON.stringify(error)).not.toContain(token);
  });
});
