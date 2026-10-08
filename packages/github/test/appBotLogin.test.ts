import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AppBotLoginError, LOGIN_TTL_MS, clearAppBotLoginCache, readAppBotLogin } from "../src/appBotLogin.js";

/** D#6 R2b-3f: the login our App's pull requests carry, asked of `GET /app` with the App's own JWT. */
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

interface Seen {
  url: string;
  headers: Record<string, string>;
}
function fakeFetch(reply: { status: number; body: unknown } | Error, seen: Seen[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    // The real service refuses a request without a User-Agent or the JSON media type.
    const h = init.headers as Record<string, string>;
    if (!h["user-agent"] || h.accept !== "application/vnd.github+json" || !/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(h.authorization ?? "")) return new Response("{}", { status: 403 });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
}

describe("readAppBotLogin", () => {
  beforeEach(clearAppBotLoginCache);

  it("answers <slug>[bot] for the App it asked as, with a JWT and the headers GitHub requires", async () => {
    const seen: Seen[] = [];
    expect(await readAppBotLogin({ appId: "123", privateKeyPem: pem, fetchImpl: fakeFetch({ status: 200, body: { id: 123, slug: "fulcrumaxe-runner" } }, seen) })).toBe("fulcrumaxe-runner[bot]");
    expect(seen.map((s) => s.url)).toEqual(["https://api.github.com/app"]);
  });

  it("remembers the answer for ten minutes, then asks again", async () => {
    let calls = 0;
    const f = ((async () => (calls++, new Response(JSON.stringify({ id: 7, slug: "app-x" }), { status: 200 }))) as unknown) as typeof fetch;
    let now = 1_000_000;
    const read = () => readAppBotLogin({ appId: "7", privateKeyPem: pem, fetchImpl: f, now: () => now });
    await read();
    now += LOGIN_TTL_MS - 1;
    await read();
    expect(calls).toBe(1);
    now += 2;
    await read();
    expect(calls).toBe(2);
  });

  it("refuses an answer for another App, a slug of the wrong shape, a non-200 and a transport error, all with the same fixed error", async () => {
    const bad: Array<{ status: number; body: unknown } | Error> = [
      { status: 200, body: { id: 999, slug: "other" } },
      { status: 200, body: { id: 123, slug: "has space" } },
      { status: 200, body: { id: 123, slug: "evil[bot]" } },
      { status: 200, body: { id: 123 } },
      { status: 401, body: { message: "Bad credentials" } },
      new Error("ECONNRESET with-secret-material"),
    ];
    for (const reply of bad) {
      const error = await readAppBotLogin({ appId: "123", privateKeyPem: pem, fetchImpl: fakeFetch(reply) }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(AppBotLoginError);
      expect((error as Error).message).not.toContain("secret");
    }
  });

  it("an unparseable key is the same fixed error and the key is never echoed", async () => {
    const error = await readAppBotLogin({ appId: "1", privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----", fetchImpl: fakeFetch({ status: 200, body: {} }) }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AppBotLoginError);
    expect((error as Error).message).not.toContain("not a key");
  });
});
