import { generateKeyPairSync, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { importSPKI, jwtVerify } from "jose";
import type { TokenScope } from "@fx/gh-policy";
import { APP_ENV_NAMES, AppCredentialsError, loadAppCredentials, resetAppCredentialsWarnings, type AppKind } from "../src/appCredentials.js";
import { InstallationTokenCache, getInstallationToken, type AccessTokenRequester } from "../src/installationToken.js";

/**
 * D#2 H13e, criteria 1, 2 and 8: credentials chosen by app_kind, fail
 * closed per kind with no fallback between kinds, the App JWT signed with
 * that kind's key only, and a token cache keyed by kind.
 */

const KINDS: AppKind[] = ["team", "team_readonly", "sitekit"];
const APP_IDS: Record<AppKind, string> = { team: "1001", team_readonly: "1002", sitekit: "1003" };
const SECRETS: Record<AppKind, string> = {
  team: "team-webhook-secret-0123456789abcdef-xx",
  team_readonly: "readonly-webhook-secret-0123456789abc",
  sitekit: "sitekit-webhook-secret-0123456789abcde",
};
const keys = {} as Record<AppKind, { privatePem: string; publicPem: string }>;

beforeAll(() => {
  for (const kind of KINDS) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    keys[kind] = { privatePem: privateKey as unknown as string, publicPem: publicKey as unknown as string };
  }
});

function envFor(kinds: AppKind[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const kind of kinds) {
    const names = APP_ENV_NAMES[kind];
    env[names.appId] = APP_IDS[kind];
    env[names.privateKey] = keys[kind].privatePem;
    env[names.webhookSecret] = SECRETS[kind];
  }
  return env;
}

function scope(): TokenScope {
  return { repositories: ["widgets"], permissions: { contents: "write" } };
}

function okRequester(): AccessTokenRequester {
  return vi.fn(async () => ({ token: "ghs_x", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
}

describe("loadAppCredentials: fail closed per kind (criterion 1)", () => {
  it("only team set: team works, the other two refuse", () => {
    const source = loadAppCredentials(envFor(["team"]));
    expect(source("team").appId).toBe("1001");
    expect(() => source("team_readonly")).toThrow(AppCredentialsError);
    expect(() => source("sitekit")).toThrow(AppCredentialsError);
  });

  it.each(KINDS)("no fallback: with only %s missing, that kind refuses and never borrows another kind's credentials", (missing) => {
    const source = loadAppCredentials(envFor(KINDS.filter((k) => k !== missing)));
    expect(() => source(missing)).toThrow(AppCredentialsError);
    for (const other of KINDS.filter((k) => k !== missing)) expect(source(other).appId).toBe(APP_IDS[other]);
  });

  it.each([["abc"], ["0"], ["-5"], ["1.5"], [""]])("app id %j makes the kind not configured, and the others keep working", (badId) => {
    const env = envFor(KINDS);
    env[APP_ENV_NAMES.team_readonly.appId] = badId;
    const source = loadAppCredentials(env);
    expect(() => source("team_readonly")).toThrow(AppCredentialsError);
    expect(source("team").appId).toBe("1001");
    expect(source("sitekit").appId).toBe("1003");
  });

  it("an unparseable key makes the kind not configured", () => {
    const env = envFor(KINDS);
    env[APP_ENV_NAMES.sitekit.privateKey] = "not a pem";
    const source = loadAppCredentials(env);
    expect(() => source("sitekit")).toThrow(AppCredentialsError);
    expect(source("team").appId).toBe("1001");
  });

  it.each([[""], ["a".repeat(31)]])("a webhook secret of %j makes the kind not configured", (secret) => {
    const env = envFor(KINDS);
    env[APP_ENV_NAMES.team_readonly.webhookSecret] = secret;
    const source = loadAppCredentials(env);
    expect(() => source("team_readonly")).toThrow(AppCredentialsError);
    expect(source("team").appId).toBe("1001");
  });

  it("two kinds with the same App id: every kind refuses, and the error names the env variables, not a value", () => {
    const env = envFor(KINDS);
    env[APP_ENV_NAMES.sitekit.appId] = APP_IDS.team;
    const source = loadAppCredentials(env);
    for (const kind of KINDS) {
      let message = "";
      try {
        source(kind);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("GITHUB_APP_ID");
      expect(message).toContain("GITHUB_APP_SITEKIT_ID");
      expect(message).not.toContain(APP_IDS.team);
    }
  });

  it("an unknown kind refuses", () => {
    const source = loadAppCredentials(envFor(KINDS));
    for (const bad of [null, undefined, "", "Team", " team", "admin"]) {
      expect(() => source(bad)).toThrow(AppCredentialsError);
    }
  });

  it("errors carry fixed text and never a key, secret or id value, and the one warning logged shows no value", () => {
    resetAppCredentialsWarnings();
    const env = envFor(["team"]);
    env[APP_ENV_NAMES.sitekit.privateKey] = "-----BEGIN PRIVATE KEY-----\nLEAKME-marker\n-----END PRIVATE KEY-----";
    env[APP_ENV_NAMES.sitekit.appId] = "777";
    env[APP_ENV_NAMES.sitekit.webhookSecret] = "LEAKME-secret-0123456789abcdef012345678";
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn")].map((s) => s.mockImplementation(() => {}));
    const source = loadAppCredentials(env);
    expect(() => source("sitekit")).toThrow(new AppCredentialsError("not_configured (sitekit)"));
    expect(() => source("sitekit")).not.toThrow(/LEAKME|777/);
    const [errorSpy, warnSpy] = spies;
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy!.mock.calls)).not.toMatch(/LEAKME|777/);
    for (const spy of spies) spy.mockRestore();
  });
});

describe("mint by kind (criterion 2)", () => {
  it("signs each kind's App JWT with that kind's key, iss = that kind's App id, verifiable under that key only", async () => {
    const source = loadAppCredentials(envFor(KINDS));
    for (const kind of ["team", "team_readonly"] as const) {
      const requester = okRequester();
      await getInstallationToken({
        installationId: 42,
        appKind: kind,
        purpose: kind === "team" ? "run" : "preview_read",
        role: "executor",
        scope: scope(),
        appCredentials: source,
        requester,
        cache: new InstallationTokenCache(),
      });
      const { appJwt } = (requester as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { appJwt: string };
      const own = await importSPKI(keys[kind].publicPem, "RS256");
      const { payload } = await jwtVerify(appJwt, own);
      expect(payload.iss).toBe(APP_IDS[kind]);
      for (const other of KINDS.filter((k) => k !== kind)) {
        const foreign = await importSPKI(keys[other].publicPem, "RS256");
        await expect(jwtVerify(appJwt, foreign)).rejects.toThrow();
      }
    }
  });

  it("a kind that is not configured mints nothing and never uses another kind's key", async () => {
    const source = loadAppCredentials(envFor(["team"]));
    const requester = okRequester();
    await expect(
      getInstallationToken({
        installationId: 42,
        appKind: "team_readonly",
        purpose: "preview_read",
        role: "executor",
        scope: scope(),
        appCredentials: source,
        requester,
        cache: new InstallationTokenCache(),
      }),
    ).rejects.toBeInstanceOf(AppCredentialsError);
    expect(requester).not.toHaveBeenCalled();
  });
});

describe("cache key includes the kind (criterion 8)", () => {
  it("the same installation, role, repo and permissions under two kinds are two entries, neither served for the other", () => {
    const cache = new InstallationTokenCache();
    const s = scope();
    cache.set(42, "team", "executor", s, "ghs_team", Date.now() + 60_000);
    expect(cache.get(42, "team_readonly", "executor", s, Date.now())).toBeUndefined();
    cache.set(42, "team_readonly", "executor", s, "ghs_ro", Date.now() + 60_000);
    expect(cache.get(42, "team", "executor", s, Date.now())).toBe("ghs_team");
    expect(cache.get(42, "team_readonly", "executor", s, Date.now())).toBe("ghs_ro");
  });
});

describe("partly configured kinds are reported once, by shape only", () => {
  const names = APP_ENV_NAMES.team_readonly;
  // Same shape as an App client secret: 40 hex characters. Made up here, not a real one.
  const clientSecretShape = randomBytes(20).toString("hex");
  const goodPem = () => keys.team_readonly.privatePem;
  const goodSecret = SECRETS.team_readonly;

  function load(env: Record<string, string>) {
    resetAppCredentialsWarnings();
    const lines: string[] = [];
    const source = loadAppCredentials(env, (l) => lines.push(l));
    return { lines, source, parsed: lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
  }

  it("names the kind and the failing check when a client secret is pasted as the key", () => {
    const { parsed, lines, source } = load({ [names.appId]: "1002", [names.privateKey]: clientSecretShape, [names.webhookSecret]: goodSecret });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      event: "appcreds.invalid",
      kind: "team_readonly",
      checks: ["pem_missing_begin_end_lines"],
      variables: [names.privateKey],
      facts: { pem_length: 40, pem_has_begin_line: false, pem_has_end_line: false },
    });
    expect(lines.join("\n")).not.toContain(clientSecretShape);
    expect(() => source("team_readonly")).toThrow(/not_configured/);
  });

  it("reports an id that is not digits, with its length only", () => {
    const badId = "Iv1.abcdef0123456789";
    const { parsed, lines } = load({ [names.appId]: badId, [names.privateKey]: goodPem(), [names.webhookSecret]: goodSecret });
    expect(parsed[0]).toMatchObject({ kind: "team_readonly", checks: ["id_not_digits"], variables: [names.appId], facts: { id_length: badId.length } });
    expect(lines.join("\n")).not.toContain(badId);
  });

  it("reports a webhook secret under 32 bytes, with its byte count only", () => {
    const short = "short-webhook-secret-31-bytes-xx".slice(0, 31);
    const { parsed, lines } = load({ [names.appId]: "1002", [names.privateKey]: goodPem(), [names.webhookSecret]: short });
    expect(parsed[0]).toMatchObject({ checks: ["webhook_secret_under_32_bytes"], variables: [names.webhookSecret], facts: { webhook_secret_bytes: 31 } });
    expect(lines.join("\n")).not.toContain(short);
  });

  it("reports armor lines present but a body that does not parse, without the body", () => {
    const damaged = "-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUA==\n-----END PRIVATE KEY-----\n";
    const { parsed, lines } = load({ [names.appId]: "1002", [names.privateKey]: damaged, [names.webhookSecret]: goodSecret });
    expect(parsed[0]).toMatchObject({
      checks: ["pem_unparseable"],
      facts: { pem_length: damaged.length, pem_has_begin_line: true, pem_has_end_line: true },
    });
    expect(lines.join("\n")).not.toContain("QUJDREVGR0hJSktMTU5PUA");
  });

  it("reports an armored key missing its END line", () => {
    const truncated = goodPem().split("\n").slice(0, 5).join("\n");
    const { parsed, lines } = load({ [names.appId]: "1002", [names.privateKey]: truncated, [names.webhookSecret]: goodSecret });
    expect(parsed[0]).toMatchObject({ checks: ["pem_missing_begin_end_lines"], facts: { pem_has_begin_line: true, pem_has_end_line: false } });
    expect(lines.join("\n")).not.toContain(truncated.split("\n")[1]);
  });

  it("names a variable that is missing while the others are set", () => {
    const { parsed } = load({ [names.appId]: "1002", [names.privateKey]: goodPem() });
    expect(parsed[0]).toMatchObject({ checks: ["webhook_secret_missing"], variables: [names.webhookSecret] });
  });

  it("lists every failing check at once and never a value", () => {
    const env = { [names.appId]: "abc", [names.privateKey]: clientSecretShape, [names.webhookSecret]: "tiny" };
    const { parsed, lines } = load(env);
    expect(parsed[0]!.checks).toEqual(["id_not_digits", "pem_missing_begin_end_lines", "webhook_secret_under_32_bytes"]);
    for (const value of Object.values(env)) expect(lines.join("\n")).not.toContain(value);
  });

  it("stays silent for a kind with none of its variables set, and for good kinds", () => {
    expect(load({}).lines).toEqual([]);
    expect(load(envFor(["team", "team_readonly", "sitekit"])).lines).toEqual([]);
  });

  it("logs the same problem once per process even when the loader runs on every request", () => {
    resetAppCredentialsWarnings();
    const lines: string[] = [];
    const env = { [names.appId]: "1002", [names.privateKey]: clientSecretShape, [names.webhookSecret]: goodSecret };
    loadAppCredentials(env, (l) => lines.push(l));
    loadAppCredentials(env, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
  });

  it("writes to console.warn by default", () => {
    resetAppCredentialsWarnings();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadAppCredentials({ [names.appId]: "1002", [names.privateKey]: clientSecretShape, [names.webhookSecret]: goodSecret });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).not.toContain(clientSecretShape);
    spy.mockRestore();
  });
});
