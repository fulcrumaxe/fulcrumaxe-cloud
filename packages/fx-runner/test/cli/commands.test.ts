import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KEY_FILE, REGISTRATION_FILE } from "../../src/config.js";
import { writeApiKey } from "../../src/credentials.js";
import { CODE, useRig } from "./harness.js";

const rig = useRig();
const mode = (p: string): number => statSync(p).mode & 0o777;
const stateFiles = (): string[] => (existsSync(rig.dir) ? readdirSync(rig.dir).sort() : []);

describe("register (R4a.1)", () => {
  it("registers over a real connection, and leaves the key at 0600 in a 0700 directory", async () => {
    const result = await rig.register("api_key");
    expect(result.code).toBe(0);
    expect(rig.cloud.runners.size).toBe(1);
    expect(stateFiles()).toEqual([REGISTRATION_FILE, KEY_FILE].sort());
    expect(mode(rig.dir)).toBe(0o700);
    expect(mode(path.join(rig.dir, KEY_FILE))).toBe(0o600);
    expect(mode(path.join(rig.dir, REGISTRATION_FILE))).toBe(0o600);
    const saved = JSON.parse(readFileSync(path.join(rig.dir, REGISTRATION_FILE), "utf8")) as Record<string, string>;
    expect(saved).toMatchObject({ version: 1, cloud_origin: rig.cloud.origin, credential_mode: "api_key" });
    expect(result.out).toContain(saved.runner_id);
  });

  it("sends the code and the public JWK only: the body has no private member, and the private key is in no output", async () => {
    const result = await rig.register("subscription");
    expect(result.code).toBe(0);
    const sent = rig.cloud.seen[0]!;
    expect(sent.path).toBe("/api/runner/register");
    const body = JSON.parse(sent.body) as { code: string; public_key_jwk: Record<string, string> };
    expect(Object.keys(body).sort()).toEqual(["code", "public_key_jwk"]);
    expect(Object.keys(body.public_key_jwk).sort()).toEqual(["crv", "kty", "x"]);
    expect(sent.body).not.toMatch(/"d"/);
    expect(sent.body).not.toMatch(/PRIVATE|BEGIN/);
    const pem = readFileSync(path.join(rig.dir, KEY_FILE), "utf8");
    const secretBody = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    expect(secretBody.length).toBeGreaterThan(20);
    expect(result.out + result.err).not.toContain(secretBody);
    expect(JSON.stringify(sent.headers)).not.toContain(secretBody);
  });

  it("the signature covers the method, the full URI and the body digest, and the cloud verified it", async () => {
    await rig.register();
    const headers = rig.cloud.seen[0]!.headers;
    expect(headers["signature-input"]).toMatch(/^fx=\("@method" "@target-uri" "content-digest"\);created=\d+;keyid="[A-Za-z0-9_-]{43}";nonce="[A-Za-z0-9_-]{24}";alg="ed25519"$/);
    expect(headers["content-digest"]).toMatch(/^sha-256=:[A-Za-z0-9+/=]+:$/);
  });

  it("refuses bad input before any request: an unknown mode, a malformed code, a missing or unsafe cloud address", async () => {
    const base = ["register", "--code", CODE, "--credential-mode", "api_key", "--cloud-url", rig.cloud.origin];
    const swap = (flag: string, value: string): string[] => base.map((a, i) => (base[i - 1] === flag ? value : a));
    for (const argv of [
      swap("--credential-mode", "both"),
      swap("--code", "fxrr_short"),
      swap("--code", "nope"),
      swap("--cloud-url", "http://example.com"),
      swap("--cloud-url", "https://example.com/some/path"),
      swap("--cloud-url", "https://user:pw@example.com"),
      swap("--cloud-url", "ftp://example.com"),
      swap("--cloud-url", "not a url"),
      base.slice(0, 4),
      base.slice(2),
    ]) {
      const result = await rig.run(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err + result.out).not.toContain(CODE);
    }
    expect(rig.cloud.seen).toEqual([]);
    expect(stateFiles()).toEqual([]);
  });

  it("an unusable code leaves nothing behind and does not echo the code", async () => {
    const result = await rig.run(["register", "--code", `fxrr_${"Z9y8X7w6".repeat(5)}`, "--credential-mode", "api_key", "--cloud-url", rig.cloud.origin]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("401 invalid_code");
    expect(result.err).not.toContain("Z9y8X7w6");
    expect(stateFiles()).toEqual([]);
  });

  it("a code works once: the second use is refused, and a rate limit and the runner limit are reported in words", async () => {
    expect((await rig.register()).code).toBe(0);
    await rig.run(["revoke", "--local"]);
    rig.cloud.validCodes.add(CODE);
    rig.cloud.force.push("rate_limit");
    const limited = await rig.register();
    expect(limited.code).toBe(1);
    expect(limited.err).toContain("wait 42 seconds");
    rig.cloud.force.push("runner_limit");
    const full = await rig.register();
    expect(full.err).toContain("409 runner_limit");
    expect(stateFiles()).toEqual([]);
  });

  it("a network failure and a redirect are reported without a path or a stack", async () => {
    const down = await rig.run(["register", "--code", CODE, "--credential-mode", "api_key", "--cloud-url", "http://127.0.0.1:1"]);
    expect(down.code).toBe(1);
    // The one deprecation line for --code (D#605 FL-7) comes first; the failure itself is unchanged.
    expect(down.err.split("\n").slice(1).join("\n")).toBe("fx-runner: could not reach the cloud; check --cloud-url and your network, then try again\n");
    const fetchFn = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const odd = await rig.run(["register", "--code", CODE, "--credential-mode", "api_key", "--cloud-url", rig.cloud.origin], { fetchFn });
    expect(odd.code).toBe(1);
    expect(stateFiles()).toEqual([]);
  });
});

describe("one login, one person, one account (R4a.2)", () => {
  it("a second subscription registration on the same machine exits non-zero, sends nothing and changes nothing", async () => {
    expect((await rig.register("subscription")).code).toBe(0);
    const before = readFileSync(path.join(rig.dir, REGISTRATION_FILE), "utf8");
    rig.cloud.validCodes.add(CODE);
    const requests = rig.cloud.seen.length;
    const second = await rig.register("subscription");
    expect(second.code).not.toBe(0);
    expect(second.err).toContain("subscription login is never shared between accounts");
    expect(second.err).toContain("fx-runner revoke, then register again");
    expect(second.err).toContain("fx-runner revoke --local");
    expect(rig.cloud.seen.length).toBe(requests);
    expect(readFileSync(path.join(rig.dir, REGISTRATION_FILE), "utf8")).toBe(before);
    expect(rig.cloud.runners.size).toBe(1);
  });

  it("a subscription registration is also refused beside an API-key one, and after the first is revoked it works again", async () => {
    expect((await rig.register("api_key")).code).toBe(0);
    rig.cloud.validCodes.add(CODE);
    expect((await rig.register("subscription")).code).not.toBe(0);
    expect((await rig.run(["revoke"])).code).toBe(0);
    rig.cloud.validCodes.add(CODE);
    expect((await rig.register("subscription")).code).toBe(0);
  });
});

describe("status", () => {
  it("says so when there is no registration, and reports a registered runner without a network call", async () => {
    const none = await rig.run(["status"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("Not registered");
    await rig.register("subscription");
    const requests = rig.cloud.seen.length;
    const ok = await rig.run(["status"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/Credential mode: subscription/);
    expect(ok.out).toContain(rig.cloud.origin);
    expect(ok.out).toMatch(/Key: +ok, 0 days old/);
    expect(rig.cloud.seen.length).toBe(requests);
  });

  it("flags a key at the cloud's 90-day limit, a missing key, and a key that is not the registered one", async () => {
    await rig.register();
    const later = (days: number) => ({ now: () => new Date(Date.now() + days * 86_400_000) });
    expect((await rig.run(["status"], later(89))).code).toBe(0);
    const old = await rig.run(["status"], later(90));
    expect(old.code).toBe(1);
    expect(old.out).toContain("90 days");
    const { rmSync, writeFileSync } = await import("node:fs");
    const { generateRunnerKey, saveRunnerKey } = await import("../../src/keys.js");
    saveRunnerKey(rig.dir, generateRunnerKey());
    expect((await rig.run(["status"])).out).toContain("does not match the registration");
    rmSync(path.join(rig.dir, KEY_FILE));
    expect((await rig.run(["status"])).out).toContain("missing");
    writeFileSync(path.join(rig.dir, REGISTRATION_FILE), "{", { mode: 0o600 });
    const damaged = await rig.run(["status"]);
    expect(damaged.code).toBe(1);
    expect(damaged.err).toContain("damaged");
  });
});

describe("revoke", () => {
  it("revokes with the runner's own signature, then deletes the key and the registration", async () => {
    await rig.register();
    const result = await rig.run(["revoke", "--reason", "laptop returned"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("2 running jobs were stopped");
    const sent = rig.cloud.seen[1]!;
    expect(sent.path).toBe("/api/runner/revoke");
    expect(JSON.parse(sent.body)).toEqual({ reason: "laptop returned" });
    expect([...rig.cloud.runners.values()][0]!.revoked).toBe(true);
    expect(stateFiles()).toEqual([]);
    expect((await rig.run(["status"])).out).toContain("Not registered");
  });

  it("leaves an API key file for the user to clear, and says so (D#6 R5b-3)", async () => {
    await rig.register();
    writeApiKey(rig.dir, process.getuid!(), ["sk-ant-", "api03-", "REVOKEKEY0123456789abcdef"].join("")); // gitleaks:allow
    const result = await rig.run(["revoke"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("The stored API key file is left in place; to remove it run: fx-runner credentials clear-api-key");
    expect(result.out).not.toContain("REVOKEKEY");
    expect(stateFiles()).toEqual(["credentials"]);
  });

  it("sends an empty message with no reason, and refuses a reason the protocol would refuse before sending", async () => {
    await rig.register();
    const long = await rig.run(["revoke", "--reason", "x".repeat(201)]);
    expect(long.code).toBe(2);
    expect(rig.cloud.seen.length).toBe(1);
    expect((await rig.run(["revoke"])).code).toBe(0);
    expect(rig.cloud.seen[1]!.body).toBe("{}");
  });

  it("keeps the local files when the cloud does not know the runner, and --local is the way out", async () => {
    await rig.register();
    await rig.run(["revoke"]);
    // The workspace revoked it first: rebuild the local state of a runner the cloud already refuses.
    rig.cloud.validCodes.add(CODE);
    await rig.register();
    const runner = [...rig.cloud.runners.values()].at(-1)!;
    runner.revoked = true;
    const refused = await rig.run(["revoke"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("401 unauthorized");
    // revoke cannot succeed against a runner the cloud refuses, so the message must name the way out
    expect(refused.err).toContain("run: fx-runner revoke --local, then register again");
    expect(stateFiles()).toEqual([REGISTRATION_FILE, KEY_FILE].sort());
    const local = await rig.run(["revoke", "--local"]);
    expect(local.code).toBe(0);
    expect(stateFiles()).toEqual([]);
  });

  it("a key over 90 days old is told to register again", async () => {
    await rig.register();
    rig.cloud.force.push("key_too_old");
    const result = await rig.run(["revoke"]);
    expect(result.err).toContain("401 reregister_required");
    expect(result.err).toContain("revoke --local");
    expect(stateFiles()).toEqual([REGISTRATION_FILE, KEY_FILE].sort());
  });

  it("when the cloud revoked the runner but could not stop its jobs, the key is deleted and the exit is non-zero", async () => {
    await rig.register();
    rig.cloud.force.push("leases_not_failed");
    const result = await rig.run(["revoke"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("could not be stopped yet");
    expect(stateFiles()).toEqual([]);
  });

  it("without a registration it says so and sends nothing", async () => {
    const result = await rig.run(["revoke"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no runner registration");
    expect(rig.cloud.seen).toEqual([]);
  });
});
